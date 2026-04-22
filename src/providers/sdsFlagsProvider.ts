/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

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

export class SdsIOInterfaceProvider implements vscode.TreeDataProvider<SdsFlagTreeItem>, vscode.TreeDragAndDropController<SdsFlagTreeItem> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SdsFlagTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    readonly dragMimeTypes = ['application/vnd.code.tree.sdsIOInterface'];
    readonly dropMimeTypes = ['application/vnd.code.tree.sdsIOInterface'];

    private readonly flags: SdsFlag[] = [];
    private nextId = 1;
    private mode: SdsIoMode = 'idle';

    getTreeItem(element: SdsFlagTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(_element?: SdsFlagTreeItem): Thenable<SdsFlagTreeItem[]> {
        return Promise.resolve(this.flags.map((flag) => new SdsFlagTreeItem(flag)));
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    async addFlagAndRename(): Promise<void> {
        if (this.flags.length >= MAX_FLAGS) {
            vscode.window.showWarningMessage(`Only ${MAX_FLAGS} flags are supported.`);
            return;
        }

        const fallbackName = this.getFallbackName();
        const newFlag: SdsFlag = {
            id: `flag-${this.nextId++}`,
            name: fallbackName,
            enabled: false,
        };

        this.flags.push(newFlag);
        this.refresh();

        const input = await vscode.window.showInputBox({
            prompt: 'Enter flag name',
            placeHolder: 'Flag_A',
            value: fallbackName,
            validateInput: (value) => this.validateFlagName(value, newFlag.id),
            ignoreFocusOut: true,
        });

        const normalized = this.normalizeFlagName(input, fallbackName);
        newFlag.name = normalized;
        this.refresh();
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

    removeFlag(item: SdsFlagTreeItem): void {
        const index = this.flags.findIndex((f) => f.id === item.flag.id);
        if (index < 0) {
            return;
        }

        this.flags.splice(index, 1);
        this.refresh();
    }

    moveUp(item: SdsFlagTreeItem): void {
        this.moveBy(item.flag.id, -1);
    }

    moveDown(item: SdsFlagTreeItem): void {
        this.moveBy(item.flag.id, 1);
    }

    setEnabledByTreeItems(items: ReadonlyArray<[SdsFlagTreeItem, vscode.TreeItemCheckboxState]>): void {
        for (const [item, checkboxState] of items) {
            const flag = this.findFlag(item.flag.id);
            if (!flag) {
                continue;
            }
            flag.enabled = checkboxState === vscode.TreeItemCheckboxState.Checked;
        }
        this.refresh();
    }

    playDummy(): void {
        const { setMask, unsetMask } = this.getFlagMasks();
        this.mode = 'play';
        void vscode.window.showInformationMessage(
            `Play dummy invoked. Command masks -> set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, unset: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`
        );
    }

    recordDummy(): void {
        const { setMask, unsetMask } = this.getFlagMasks();
        this.mode = 'record';
        void vscode.window.showInformationMessage(
            `Record dummy invoked. Command masks -> set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, unset: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`
        );
    }

    stopDummy(): void {
        const { setMask, unsetMask } = this.getFlagMasks();
        this.mode = 'idle';
        void vscode.window.showInformationMessage(
            `Stop dummy invoked. Command masks -> set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, unset: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`
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
        return `set: 0x${setMask.toString(16).toUpperCase().padStart(2, '0')}, unset: 0x${unsetMask.toString(16).toUpperCase().padStart(2, '0')}`;
    }

    getFlagMasks(): SdsFlagMasks {
        const allFlagsMask = (1 << MAX_FLAGS) - 1;
        const setMask = this.computeSetMask() & allFlagsMask;
        const unsetMask = (~setMask) & allFlagsMask;
        return { setMask, unsetMask };
    }

    async handleDrag(
        source: readonly SdsFlagTreeItem[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const sourceIds = source.map((s) => s.flag.id);
        dataTransfer.set(this.dragMimeTypes[0], new vscode.DataTransferItem(JSON.stringify(sourceIds)));
    }

    async handleDrop(
        target: SdsFlagTreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken
    ): Promise<void> {
        const item = dataTransfer.get(this.dragMimeTypes[0]);
        if (!item) {
            return;
        }

        const raw = await item.asString();
        let sourceIds: string[] = [];

        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                sourceIds = parsed.filter((v): v is string => typeof v === 'string');
            }
        } catch {
            return;
        }

        if (sourceIds.length === 0) {
            return;
        }

        const moved = this.flags.filter((f) => sourceIds.includes(f.id));
        if (moved.length === 0) {
            return;
        }

        const remaining = this.flags.filter((f) => !sourceIds.includes(f.id));

        if (!target) {
            this.flags.splice(0, this.flags.length, ...remaining, ...moved);
            this.refresh();
            return;
        }

        const targetIndex = remaining.findIndex((f) => f.id === target.flag.id);
        if (targetIndex < 0) {
            this.flags.splice(0, this.flags.length, ...remaining, ...moved);
            this.refresh();
            return;
        }

        remaining.splice(targetIndex, 0, ...moved);
        this.flags.splice(0, this.flags.length, ...remaining);
        this.refresh();
    }

    private findFlag(id: string): SdsFlag | undefined {
        return this.flags.find((f) => f.id === id);
    }

    private moveBy(flagId: string, delta: -1 | 1): void {
        const index = this.flags.findIndex((f) => f.id === flagId);
        if (index < 0) {
            return;
        }

        const nextIndex = index + delta;
        if (nextIndex < 0 || nextIndex >= this.flags.length) {
            return;
        }

        const [flag] = this.flags.splice(index, 1);
        this.flags.splice(nextIndex, 0, flag);
        this.refresh();
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
            const letter = String.fromCharCode(65 + i);
            const candidate = `Flag_${letter}`;
            const isUsed = this.flags.some((f) => f.id !== currentId && f.name === candidate);
            if (!isUsed) {
                return candidate;
            }
        }
        return 'Flag_A';
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
