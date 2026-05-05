/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { SdsioMonitorClient, SdsioMonitorInfo } from '../recorder/sdsio/sdsIoMonitorClient';

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
    private monitorConnected = false;
    private remoteFlags = 0;

    constructor(monitor?: SdsioMonitorClient) {
        this.monitor = monitor;
        if (monitor) {
            monitor.on('connected', () => this._onMonitorConnected());
            monitor.on('disconnected', () => this._onMonitorDisconnected());
            monitor.on('info', (info: SdsioMonitorInfo) => this._onMonitorInfo(info));
        }
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


    async renameFlag(item: SdsFlagTreeItem): Promise<void> {
        const flag = this.findFlag(item.flag.id);
        if (!flag) {
            return;
        }

        const fallbackName = this.getFallbackName(flag.id);
        const input = await vscode.window.showInputBox({
            prompt: 'Rename flag',
            value: flag.name,
            validateInput: (value) => this.validateFlagName(value, flag.id),
            ignoreFocusOut: true,
        });

        flag.name = this.normalizeFlagName(input, fallbackName);
        this.refresh();
    }

    setEnabledByTreeItems(items: ReadonlyArray<[SdsFlagTreeItem, vscode.TreeItemCheckboxState]>): void {
        for (const [item, checkboxState] of items) {
            const flag = this.findFlag(item.flag.id);
            if (!flag) {
                continue;
            }
            flag.enabled = checkboxState === vscode.TreeItemCheckboxState.Checked;
        }
        // Send updated flags to monitor
        this.sendFlagsToMonitor();
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
        return this.mode !== 'record';
    }

    canRecord(): boolean {
        return this.mode !== 'play';
    }

    canStop(): boolean {
        return this.mode !== 'idle';
    }

    getBitmaskSummary(): string {
        const { setMask, unsetMask } = this.getFlagMasks();
        const connection = this.monitorConnected ? '🟢 connected' : '⭕ disconnected';
        return `${connection} | set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, clear: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`;
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
