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

// Created using AI

import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandMockState = vi.hoisted(() => {
    const registeredDisposables: Array<{
        command: string;
        callback: (...args: unknown[]) => unknown;
        dispose: () => void;
    }> = [];

    const registerCommandMock = vi.fn((command: string, callback: (...args: unknown[]) => unknown) => {
        const disposable = {
            command,
            callback,
            dispose: vi.fn(),
        };
        registeredDisposables.push(disposable);
        return disposable;
    });

    return {
        registerCommandMock,
        registeredDisposables,
    };
});

vi.mock('vscode', () => ({
    commands: {
        executeCommand: vi.fn(),
        registerCommand: commandMockState.registerCommandMock,
    },
    window: {
        showWarningMessage: vi.fn(),
    },
}));

vi.mock('../../src/providers/sdsExplorerProvider', () => ({
    SdsExplorerProvider: class { },
    SdsTreeItem: class { },
}));

import * as vscode from 'vscode';
import { registerSdsioInterfaceCommands } from '../../src/commands/sdsioInterfaceCommands';

function createContext() {
    return {
        subscriptions: [] as Array<{ dispose: () => void }>,
    };
}

function createService() {
    let changeListener: (() => void) | undefined;

    const service = {
        canConnect: vi.fn(() => true),
        canDisconnect: vi.fn(() => false),
        canPlay: vi.fn(() => true),
        canRecord: vi.fn(() => false),
        canStop: vi.fn(() => true),
        connectServer: vi.fn(async () => true),
        disconnectServer: vi.fn(async () => undefined),
        onDidChange: vi.fn((listener: () => void) => {
            changeListener = listener;
            return { dispose: vi.fn() };
        }),
        play: vi.fn(),
        record: vi.fn(),
        renameFlag: vi.fn(async () => undefined),
        setEnabledByTreeItems: vi.fn(),
        stop: vi.fn(),
        triggerChange: () => changeListener?.(),
    };

    return service;
}

function createTreeView() {
    let checkboxListener: ((changes: { items: Array<[Record<string, unknown>, unknown]> }) => void) | undefined;

    return {
        treeView: {
            onDidChangeCheckboxState: vi.fn((listener: (changes: { items: Array<[Record<string, unknown>, unknown]> }) => void) => {
                checkboxListener = listener;
                return { dispose: vi.fn() };
            }),
        },
        triggerCheckboxChange: (items: Array<[Record<string, unknown>, unknown]>) => {
            checkboxListener?.({ items });
        },
    };
}

function registerCommands() {
    const context = createContext();
    const service = createService();
    const explorerProvider = { refresh: vi.fn() };
    const { treeView, triggerCheckboxChange } = createTreeView();

    registerSdsioInterfaceCommands({
        context: context as never,
        sdsIoControlService: service as never,
        explorerProvider: explorerProvider as never,
        explorerTreeView: treeView as never,
    });

    return { context, service, explorerProvider, treeView, triggerCheckboxChange };
}

function getCommand(command: string): (...args: unknown[]) => unknown {
    const registration = commandMockState.registeredDisposables.find((disposable) => disposable.command === command);
    if (!registration) {
        throw new Error(`Command was not registered: ${command}`);
    }
    return registration.callback;
}

describe('registerSdsioInterfaceCommands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        commandMockState.registeredDisposables.length = 0;
    });

    it('registers commands, listeners, and initial command contexts', () => {
        const { context } = registerCommands();

        expect(commandMockState.registerCommandMock.mock.calls.map(([command]) => command)).toEqual([
            'arm-sds.sdsinterface.connect',
            'arm-sds.sdsinterface.disconnect',
            'arm-sds.sdsinterface.play',
            'arm-sds.sdsinterface.record',
            'arm-sds.sdsinterface.stop',
            'arm-sds.sdsinterface.rename',
        ]);
        expect(context.subscriptions).toHaveLength(8);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canConnect', true);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canDisconnect', false);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canPlay', true);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canRecord', false);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canStop', true);
    });

    it('refreshes command contexts and the explorer when service state changes', () => {
        const { service, explorerProvider } = registerCommands();
        vi.mocked(vscode.commands.executeCommand).mockClear();

        service.canConnect.mockReturnValue(false);
        service.canDisconnect.mockReturnValue(true);
        service.triggerChange();

        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canConnect', false);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.canDisconnect', true);
        expect(explorerProvider.refresh).toHaveBeenCalled();
    });

    it('forwards checkbox changes only for SDS flag tree items', () => {
        const { service, triggerCheckboxChange } = registerCommands();
        const flagChange = [{ itemType: 'sdsFlag', label: '0' }, true] as [Record<string, unknown>, unknown];
        const fileChange = [{ itemType: 'sdsFile', label: 'data' }, false] as [Record<string, unknown>, unknown];

        triggerCheckboxChange([fileChange]);
        triggerCheckboxChange([fileChange, flagChange]);

        expect(service.setEnabledByTreeItems).toHaveBeenCalledTimes(1);
        expect(service.setEnabledByTreeItems).toHaveBeenCalledWith([flagChange]);
    });

    it('connects and disconnects through the control service', async () => {
        const { service } = registerCommands();
        vi.mocked(vscode.commands.executeCommand).mockClear();

        await getCommand('arm-sds.sdsinterface.connect')();
        await getCommand('arm-sds.sdsinterface.disconnect')();

        expect(service.connectServer).toHaveBeenCalledTimes(1);
        expect(service.disconnectServer).toHaveBeenCalledTimes(1);
        expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(10);
    });

    it('plays and records after connecting, or warns when connection fails', async () => {
        const { service } = registerCommands();
        service.connectServer.mockResolvedValueOnce(false);

        await getCommand('arm-sds.sdsinterface.play')();

        service.connectServer.mockResolvedValueOnce(true);
        await getCommand('arm-sds.sdsinterface.record')();

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Unable to connect to SDSIO monitor server.');
        expect(service.play).not.toHaveBeenCalled();
        expect(service.record).toHaveBeenCalledTimes(1);
    });

    it('stops and renames flags through the control service', async () => {
        const { service } = registerCommands();
        const item = { itemType: 'sdsFlag', filePath: 'flag-0' };

        getCommand('arm-sds.sdsinterface.stop')();
        await getCommand('arm-sds.sdsinterface.rename')(item);

        expect(service.stop).toHaveBeenCalledTimes(1);
        expect(service.renameFlag).toHaveBeenCalledWith(item);
    });
});
