/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as vscode from 'vscode';
import { SdsioMonitorClient, SdsioMonitorInfo } from '../recorder/sdsio/sdsIoMonitorClient';
import { SdsioConfigManager } from '../controller/sdsioConfigManager';
import { SDSIO_SERVER_MONITOR_PORT } from '../extension';
import { DiagnosticSource, SdsDiagnostics } from '../diagnostics/sdsDiagnostics';
import { SdsioServerLauncher } from '../controller/sdsioServerLauncher';
import { SdsTreeItem } from './sdsExplorerProvider';

const FLAG_NAME_PATTERN = /^[a-zA-Z0-9 \-_.+,/()]+$/;
const MAX_FLAGS = 8;

export type SdsFlag = {
    id: string;
    name: string;
    enabled: boolean;
};

export type SdsFlagMasks = {
    setMask: number;
    unsetMask: number;
};

export type SdsIoMode = 'idle' | 'play' | 'record';

export enum SdsIoNotifyEvent {
    Mode = 'mode',
    Flags = 'flags',
    FileUpdate = 'fileUpdate',
    Connected = 'connected',
}

export type SdsIoChangeEvent =
    | { event: SdsIoNotifyEvent.Mode; mode: SdsIoMode; state: boolean }
    | { event: SdsIoNotifyEvent.Flags }
    | { event: SdsIoNotifyEvent.FileUpdate }
    | { event: SdsIoNotifyEvent.Connected; state: boolean };

export class SdsIoControlService {
    private readonly diagnostics = SdsDiagnostics.getInstance();
    private readonly _onDidChange = new vscode.EventEmitter<SdsIoChangeEvent>();
    readonly onDidChange = this._onDidChange.event;

    private readonly flags: SdsFlag[] = Array.from({ length: MAX_FLAGS }, (_, i) => ({ id: `flag-${i}`, name: `${i}`, enabled: false }));
    private lastFlagSignature = '';
    private mode: SdsIoMode = 'idle';
    private readonly monitor?: SdsioMonitorClient | undefined;
    private readonly extensionInstallPath?: string | undefined;
    private monitorConnected = false;
    private readonly serverLauncher: SdsioServerLauncher;
    private shutdownPromise?: Promise<void> | undefined;

    constructor(private readonly configManager: SdsioConfigManager, monitor?: SdsioMonitorClient, extensionInstallPath?: string) {
        this.monitor = monitor;
        this.extensionInstallPath = extensionInstallPath;
        this.serverLauncher = new SdsioServerLauncher(this.diagnostics);
        if (monitor) {
            monitor.on('connected', () => this.onMonitorConnected());
            monitor.on('disconnected', () => this.onMonitorDisconnected());
            monitor.on('info', (info: SdsioMonitorInfo) => this.onMonitorInfo(info));
        }

        configManager.onDidChangeConfigFile(async () => await this.reConnectServer());
        configManager.onDidChangeConfig(() => this.syncFlagNamesFromManager());
        this.syncFlagNamesFromManager();
    }

    getFlagTreeItems(): SdsTreeItem[] {
        return this.flags.map((flag) => {
            const item = new SdsTreeItem(
                SdsIoControlService.getNumberedLabel(flag.id, flag.name),
                'sdsFlag',
                flag.id,
                vscode.TreeItemCollapsibleState.None,
            );
            item.description = flag.enabled ? '(set)' : '(unset)';
            item.checkboxState = flag.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
            return item;
        });
    }

    async renameFlag(item: SdsTreeItem): Promise<void> {
        if (item.itemType !== 'sdsFlag') {
            return;
        }

        const flag = this.findFlag(item.filePath);
        if (!flag) {
            return;
        }

        const index = this.flags.indexOf(flag);
        const fallbackName = this.getFallbackName(flag.id);
        const input = await vscode.window.showInputBox({
            prompt: 'Rename flag',
            value: flag.name,
            validateInput: (value) => this.validateFlagName(value, flag.id),
            ignoreFocusOut: true,
        });

        const newName = this.normalizeFlagName(input, fallbackName);
        flag.name = newName;

        if (index >= 0) {
            const configFile = this.configManager.getConfigFile();
            this.configManager.setFlagName(index, newName);
            if (!configFile) {
                this.notifyFlagsChanged();
            }
            this.diagnostics.info(DiagnosticSource.Server, `Flag ${index} renamed to "${newName}" and saved to config`);
        } else {
            this.notifyFlagsChanged();
        }
    }

    setEnabledByTreeItems(items: ReadonlyArray<[SdsTreeItem, vscode.TreeItemCheckboxState]>): void {
        const changed: Array<{ index: number; enabled: boolean }> = [];

        for (const [item, checkboxState] of items) {
            if (item.itemType !== 'sdsFlag') {
                continue;
            }

            const flag = this.findFlag(item.filePath);
            if (!flag) {
                continue;
            }

            const enabled = checkboxState === vscode.TreeItemCheckboxState.Checked;
            if (flag.enabled === enabled) {
                continue;
            }

            flag.enabled = enabled;
            const index = this.flags.findIndex((f) => f.id === flag.id);
            if (index >= 0 && index < MAX_FLAGS) {
                changed.push({ index, enabled });
            }
        }

        if (changed.length === 0) {
            return;
        }

        if (this.monitor && this.monitorConnected && changed.length === 1) {
            const op = changed[0];
            const sent = op.enabled
                ? this.monitor.setFlag(op.index)
                : this.monitor.clearFlag(op.index);

            if (!sent) {
                this.sendFlagsToMonitor();
            }
        } else {
            this.sendFlagsToMonitor();
        }

        this.notifyFlagsChanged();
    }

    play(): void {
        if (this.mode === 'play') {
            return;
        }

        this.mode = 'play';
        const modeSent = this.monitorConnected ? this.monitor?.startPlayback() === true : false;
        this.diagnostics.info(DiagnosticSource.Server, `Play invoked. Control flags ${modeSent ? 'sent' : 'not sent'};`);
        this.notifyModeChanged();
    }

    record(): void {
        if (this.mode === 'record') {
            return;
        }

        this.mode = 'record';
        const modeSent = this.monitorConnected ? this.monitor?.startRecording() === true : false;
        this.diagnostics.info(DiagnosticSource.Server, `Record invoked. Control flags ${modeSent ? 'sent' : 'not sent'};`);
        this.notifyModeChanged();
    }

    stop(): void {
        if (this.mode === 'idle') {
            return;
        }

        const previousMode = this.mode;
        this.mode = 'idle';
        const modeSent = this.monitorConnected ? this.monitor?.stopRecordingOrPlayback() === true : false;
        this.diagnostics.info(DiagnosticSource.Server, `Stop invoked. Control flags ${modeSent ? 'sent' : 'not sent'};`);
        this.notifyModeChanged();

        if (previousMode === 'record') {
            this.notifyFileUpdate();
        }
    }

    canPlay(): boolean {
        return this.monitorConnected && this.mode === 'idle';
    }

    canRecord(): boolean {
        return this.monitorConnected && this.mode === 'idle';
    }

    canStop(): boolean {
        return this.monitorConnected && this.mode !== 'idle';
    }

    canConnect(): boolean {
        return !this.monitorConnected;
    }

    canDisconnect(): boolean {
        return this.monitorConnected;
    }

    async disconnectServer(): Promise<void> {
        this.stop();
        await this.serverLauncher.stop('Disconnecting SDSIO server terminal on user request');

        if (this.monitorConnected && this.monitor) {
            this.monitor.stop();
        }

        this.setMonitorConnected(false);
    }

    async connectServer(): Promise<boolean> {
        this.diagnostics.info(DiagnosticSource.Server, 'Attempting to connect to SDSIO monitor...');
        if (!this.monitor) {
            this.diagnostics.error(DiagnosticSource.Server, 'No monitor client available to connect to.');
            return false;
        }

        if (this.monitorConnected) {
            this.diagnostics.info(DiagnosticSource.Server, 'Already connected to SDSIO monitor.');
            return true;
        }

        try {
            if (this.serverLauncher.hasTerminal()) {
                await this.serverLauncher.stop('Terminating existing SDSIO server terminal before connecting');
            }

            const basePath = this.extensionInstallPath;
            if (!basePath) {
                this.diagnostics.error(DiagnosticSource.Server, 'No workspace folder or extension install path available to locate server binary.');
                return false;
            }

            const sdsIoFile = this.configManager.getConfigFile();
            if (!sdsIoFile) {
                this.diagnostics.error(DiagnosticSource.Server, 'No SDSIO config file selected. Please select or create a .sdsio.yml file.');
                return false;
            }

            await this.serverLauncher.start({
                basePath,
                configFile: sdsIoFile,
                monitorPort: SDSIO_SERVER_MONITOR_PORT,
            });
        } catch {
            // Ignore spawn failures and still try monitor reconnect below.
        }

        try {
            this.diagnostics.info(DiagnosticSource.Server, 'Attempting to connect monitor client to server...');
            await this.monitor.start();
        } catch {
            return false;
        }

        for (let i = 0; i < 20; i++) {
            if (this.monitorConnected) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return this.monitorConnected;
    }

    async shutdown(reason = 'Shutting down SDSIO server'): Promise<void> {
        if (this.shutdownPromise) {
            await this.shutdownPromise;
            return;
        }

        this.shutdownPromise = (async () => {
            this.stop();
            await this.serverLauncher.stop(reason);

            if (this.monitorConnected && this.monitor) {
                this.monitor.stop();
                this.setMonitorConnected(false);
            }

            this.serverLauncher.dispose();
        })();

        try {
            await this.shutdownPromise;
        } finally {
            this.shutdownPromise = undefined;
        }
    }

    getConnectionState(): string {
        return '';
    }

    getFlagMasks(): SdsFlagMasks {
        const managedMask = this.flags.length > 0 ? (1 << this.flags.length) - 1 : 0;
        const setMask = this.computeSetMask() & managedMask;
        const unsetMask = managedMask & ~setMask;
        return { setMask, unsetMask };
    }

    private async reConnectServer(): Promise<void> {
        if (this.serverLauncher.hasTerminal()) {
            await this.serverLauncher.stop('Terminating existing SDSIO server terminal due to config file change');

            if (this.monitorConnected && this.monitor) {
                this.monitor.stop();
                this.setMonitorConnected(false);
            }

            await this.connectServer();
        }
    }

    private sendFlagsToMonitor(): void {
        if (!this.monitor || !this.monitorConnected) {
            return;
        }

        const { setMask, unsetMask } = this.getFlagMasks();
        this.monitor.sendFlags(setMask, unsetMask);
    }

    private findFlag(id: string): SdsFlag | undefined {
        return this.flags.find((f) => f.id === id);
    }

    private validateFlagName(input: string, currentId?: string): string | undefined {
        if (!input || input.trim().length === 0) {
            return undefined;
        }

        const value = input.trim();
        if (!FLAG_NAME_PATTERN.test(value)) {
            return 'Allowed characters: a-z, A-Z, 0-9, - _ . , + / ( )';
        }

        const duplicate = this.flags.find((f) => f.id !== currentId && f.name === value);
        if (duplicate) {
            return 'Name already exists';
        }

        return undefined;
    }

    private normalizeFlagName(input: string | undefined, fallbackName: string): string {
        const value = input?.trim() ?? '';
        if (!value) {
            return fallbackName;
        }
        if (!FLAG_NAME_PATTERN.test(value)) {
            return fallbackName;
        }
        return value;
    }

    private getFallbackName(currentId?: string): string {
        for (let i = 0; i < MAX_FLAGS; i++) {
            const candidate = `${i}`;
            const isUsed = this.flags.some((f) => f.id !== currentId && f.name === candidate);
            if (!isUsed) {
                return candidate;
            }
        }

        return '0';
    }

    private syncFlagNamesFromManager(): void {
        const { flagNames } = this.configManager.getConfig();
        for (let i = 0; i < this.flags.length; i++) {
            this.flags[i].name = flagNames.get(i) ?? `${i}`;
        }
        this.lastFlagSignature = this.getFlagSignature();
    }

    private onMonitorConnected(): void {
        if (this.setMonitorConnected(true)) {
            this.diagnostics.info(DiagnosticSource.Server, 'Connected to SDSIO monitor');
        }
    }

    private onMonitorDisconnected(): void {
        if (this.setMonitorConnected(false)) {
            this.diagnostics.info(DiagnosticSource.Server, 'Disconnected from SDSIO monitor');
        }
    }

    private onMonitorInfo(info: SdsioMonitorInfo): void {
        for (let i = 0; i < this.flags.length && i < 8; i++) {
            const bit = (info.sdsFlags >> i) & 1;
            this.flags[i].enabled = bit !== 0;
        }

        this.notifyFlagsChanged();
        this.diagnostics.info(DiagnosticSource.Server, `Received monitor info: sdsFlags=0x${info.sdsFlags.toString(16).toUpperCase().padStart(2, '0')}`);
    }

    private setMonitorConnected(connected: boolean): boolean {
        if (this.monitorConnected === connected) {
            return false;
        }

        this.monitorConnected = connected;
        this._onDidChange.fire({ event: SdsIoNotifyEvent.Connected, state: connected });
        return true;
    }

    private notifyModeChanged(): void {
        this._onDidChange.fire({
            event: SdsIoNotifyEvent.Mode,
            mode: this.mode,
            state: this.mode !== 'idle',
        });
    }

    private notifyFlagsChanged(): void {
        const flagSignature = this.getFlagSignature();
        if (flagSignature === this.lastFlagSignature) {
            return;
        }

        this.lastFlagSignature = flagSignature;
        this._onDidChange.fire({ event: SdsIoNotifyEvent.Flags });
    }

    private notifyFileUpdate(): void {
        this._onDidChange.fire({ event: SdsIoNotifyEvent.FileUpdate });
    }

    private getFlagSignature(): string {
        return this.flags.map((flag) => `${flag.enabled ? '1' : '0'}:${flag.name}`).join('|');
    }

    private computeSetMask(): number {
        return this.flags.reduce((acc, flag, index) => {
            if (flag.enabled) {
                return acc | (1 << index);
            }
            return acc;
        }, 0);
    }

    private static getNumberedLabel(flagIndex: string, flagLabel: string): string {
        const index = flagIndex.split('-')[1];
        if (index === flagLabel) {
            return flagLabel;
        }

        return `${index}: ${flagLabel}`;
    }
}
