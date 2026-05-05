/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SdsioMonitorClient, SdsioMonitorInfo } from '../recorder/sdsio/sdsIoMonitorClient';
import { SdsioConfigManager } from '../sdsioConfigManager';

const FLAG_NAME_PATTERN = /^[a-zA-Z0-9\-_.+,/()]+$/;
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

type SdsIoMode = 'idle' | 'play' | 'record';

export class SdsFlagTreeItem extends vscode.TreeItem {
    constructor(public readonly flag: SdsFlag) {
        super(flag.name, vscode.TreeItemCollapsibleState.None);
        this.id = flag.id;
        this.description = flag.enabled ? '(set)' : '(unset)';
        this.contextValue = 'sdsFlag';
        this.iconPath = new vscode.ThemeIcon('symbol-boolean');
        this.checkboxState = flag.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    }
}

export class SdsIOInterfaceProvider implements vscode.TreeDataProvider<SdsFlagTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SdsFlagTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private readonly flags: SdsFlag[] = Array.from({ length: MAX_FLAGS }, (_, i) => ({ id: `flag-${i}`, name: `${i}`, enabled: false }));
    private nextId = 1;
    private mode: SdsIoMode = 'idle';
    private monitor?: SdsioMonitorClient;
    private extensionInstallPath?: string;
    private monitorConnected = false;
    private remoteFlags = 0;

    constructor(private readonly configManager: SdsioConfigManager, monitor?: SdsioMonitorClient, extensionInstallPath?: string) {
        this.monitor = monitor;
        this.extensionInstallPath = extensionInstallPath;
        if (monitor) {
            monitor.on('connected', () => this._onMonitorConnected());
            monitor.on('disconnected', () => this._onMonitorDisconnected());
            monitor.on('info', (info: SdsioMonitorInfo) => this._onMonitorInfo(info));
        }

        // Sync flag names whenever the config file changes or is replaced.
        configManager.onDidChangeConfig(() => this.syncFlagNamesFromManager());
        this.syncFlagNamesFromManager();
    }

    private _onMonitorConnected(): void {
        this.monitorConnected = true;
        this._onDidChangeTreeData.fire();
    }

    private _onMonitorDisconnected(): void {
        this.monitorConnected = false;
        this._onDidChangeTreeData.fire();
    }

    private _onMonitorInfo(info: SdsioMonitorInfo): void {
        this.remoteFlags = info.sdsFlags;
        // Synchronize local flag state from remote
        for (let i = 0; i < this.flags.length && i < 8; i++) {
            const bit = (info.sdsFlags >> i) & 1;
            this.flags[i].enabled = bit !== 0;
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SdsFlagTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(_element?: SdsFlagTreeItem): Thenable<SdsFlagTreeItem[]> {
        return Promise.resolve(this.flags.map((flag) => new SdsFlagTreeItem(flag)));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    private syncFlagNamesFromManager(): void {
        const { flagNames } = this.configManager.getConfig();
        for (let i = 0; i < this.flags.length; i++) {
            this.flags[i].name = flagNames.get(i) ?? `${i}`;
        }
        this._onDidChangeTreeData.fire();
    }

    async renameFlag(item: SdsFlagTreeItem): Promise<void> {
        const flag = this.findFlag(item.flag.id);
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

        // Persist to .sdsio.yml; onDidChangeConfig will fire → syncFlagNamesFromManager.
        if (index >= 0) {
            this.configManager.setFlagName(index, newName);
        } else {
            this.refresh();
        }
    }

    setEnabledByTreeItems(items: ReadonlyArray<[SdsFlagTreeItem, vscode.TreeItemCheckboxState]>): void {
        const changed: Array<{ index: number; enabled: boolean }> = [];

        for (const [item, checkboxState] of items) {
            const flag = this.findFlag(item.flag.id);
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
            this.refresh();
            return;
        }

        if (this.monitor && this.monitorConnected && changed.length === 1) {
            const op = changed[0];
            const sent = op.enabled
                ? this.monitor.setFlag(op.index)
                : this.monitor.clearFlag(op.index);

            // Fallback to full sync if a targeted update fails.
            if (!sent) {
                this.sendFlagsToMonitor();
            }
        } else {
            // Multiple changed items are sent as one full mask update.
            this.sendFlagsToMonitor();
        }

        this.refresh();
    }

    play(): void {
        const { setMask, unsetMask } = this.getFlagMasks();
        this.mode = 'play';
        const modeSent = this.monitorConnected ? this.monitor?.startPlayback() === true : false;
        this.sendFlagsToMonitor();
        void vscode.window.showInformationMessage(
            `Play invoked. Control flags ${modeSent ? 'sent' : 'not sent'}; user flags -> set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, clear: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`
        );
    }

    record(): void {
        const { setMask, unsetMask } = this.getFlagMasks();
        this.mode = 'record';
        const modeSent = this.monitorConnected ? this.monitor?.startRecording() === true : false;
        this.sendFlagsToMonitor();
        void vscode.window.showInformationMessage(
            `Record invoked. Control flags ${modeSent ? 'sent' : 'not sent'}; user flags -> set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, clear: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`
        );
    }

    stop(): void {
        const { setMask, unsetMask } = this.getFlagMasks();
        this.mode = 'idle';
        const modeSent = this.monitorConnected ? this.monitor?.stopRecordingOrPlayback() === true : false;
        this.sendFlagsToMonitor();
        void vscode.window.showInformationMessage(
            `Stop invoked. Control flags ${modeSent ? 'sent' : 'not sent'}; user flags -> set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, clear: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`
        );
    }

    canPlay(): boolean {
        return this.mode === 'idle';
    }

    canRecord(): boolean {
        return this.mode === 'idle';
    }

    canStop(): boolean {
        return this.mode !== 'idle';
    }

    canConnect(): boolean {
        return !this.monitorConnected;
    }

    async connectServer(): Promise<boolean> {
        if (!this.monitor) {
            return false;
        }

        if (this.monitorConnected) {
            return true;
        }

        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const basePath = this.extensionInstallPath ?? workspaceRoot;
            if (!basePath) {
                return false;
            }

            const toolsDir = path.join(basePath, 'tools');
            const bin = path.join(toolsDir, 'sdsio-server');
            const binExe = `${bin}.exe`;
            const serverBinary = fs.existsSync(binExe) ? binExe : bin;
            if (!fs.existsSync(serverBinary)) {
                return false;
            }

            const terminal = vscode.window.createTerminal({
                name: `SDSIO Server ${new Date().toLocaleTimeString()}`,
                cwd: basePath,
                iconPath: new vscode.ThemeIcon('arm-sds-sds-icon'),
            });
            terminal.show(true);
            terminal.sendText(`"${serverBinary}" -m 6060 socket --ipaddr 127.0.0.1`, true);
        } catch {
            // Ignore spawn failures and still try monitor reconnect below.
        }

        try {
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

    getBitmaskSummary(): string {
        const connection = this.monitorConnected ? '🟢 connected' : '⭕ disconnected';
        return `${connection}`;
    }

    getFlagMasks(): SdsFlagMasks {
        // Only manage the bits for flags that exist in this provider
        const managedMask = this.flags.length > 0 ? (1 << this.flags.length) - 1 : 0;
        const setMask = this.computeSetMask() & managedMask;
        const unsetMask = managedMask & ~setMask;
        return { setMask, unsetMask };
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

    private computeSetMask(): number {
        return this.flags.reduce((acc, flag, index) => {
            if (flag.enabled) {
                return acc | (1 << index);
            }
            return acc;
        }, 0);
    }
}
