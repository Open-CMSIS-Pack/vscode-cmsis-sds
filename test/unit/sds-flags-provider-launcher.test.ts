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

import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launcherState = {
    hasTerminal: false,
};

const launcherMock = {
    hasTerminal: vi.fn(() => launcherState.hasTerminal),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async () => true),
    dispose: vi.fn(),
};

vi.mock('vscode', () => {
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];

        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((l) => l !== listener);
                },
            };
        };

        fire(event: T): void {
            for (const listener of this.listeners) {
                listener(event);
            }
        }
    }

    class TreeItem {
        constructor(public label: string) { }
    }

    class ThemeIcon {
        constructor(public id: string) { }
    }

    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        TreeItemCollapsibleState: { None: 0 },
        TreeItemCheckboxState: { Checked: 1, Unchecked: 0 },
        version: '1.0.0',
        workspace: {
            getConfiguration: vi.fn(() => ({ get: vi.fn(() => 6060) })),
        },
        window: {
            showInputBox: vi.fn(),
            createOutputChannel: vi.fn(() => ({
                show: vi.fn(),
                hide: vi.fn(),
                clear: vi.fn(),
                appendLine: vi.fn(),
                dispose: vi.fn(),
            })),
        },
    };
});

vi.mock('../../src/controller/sdsioServerLauncher', () => {
    const SdsioServerLauncher = vi.fn(function SdsioServerLauncher() {
        return launcherMock;
    });

    return {
        SdsioServerLauncher,
    };
});

vi.mock('../../src/recorder/sdsio/sdsIoMonitorPort', () => ({
    DEFAULT_SDSIO_MONITOR_PORT: 6060,
    selectSdsioMonitorPort: vi.fn(async (port: number) => port),
}));

import { selectSdsioMonitorPort } from '../../src/recorder/sdsio/sdsIoMonitorPort';
import { SdsIoControlService, SdsIoNotifyEvent } from '../../src/providers/sdsIoControlService';
import * as vscode from 'vscode';

class FakeMonitor extends EventEmitter {
    start = vi.fn(async () => {
        this.emit('connected');
    });

    stop = vi.fn();

    setFlag = vi.fn(() => true);

    clearFlag = vi.fn(() => true);

    sendFlags = vi.fn();

    startPlayback = vi.fn(() => true);

    startRecording = vi.fn(() => true);

    stopRecordingOrPlayback = vi.fn(() => true);
}

type ConfigFileChangedHandler = () => Promise<void>;
type ConfigChangedHandler = () => void;

type FakeConfigManager = {
    onDidChangeConfigFile: ReturnType<typeof vi.fn>;
    onDidChangeConfig: ReturnType<typeof vi.fn>;
    getConfig: ReturnType<typeof vi.fn>;
    getConfigFile: ReturnType<typeof vi.fn>;
    setFlagName: ReturnType<typeof vi.fn>;
    triggerConfigFileChange: () => Promise<void>;
    triggerConfigChange: () => void;
};

function createConfigManager(...args: [string?]): FakeConfigManager {
    const configFile = args.length === 0 ? 'sample.sdsio.yml' : args[0];
    let onConfigFileChange: ConfigFileChangedHandler | undefined;
    let onConfigChange: ConfigChangedHandler | undefined;

    return {
        onDidChangeConfigFile: vi.fn((handler: ConfigFileChangedHandler) => {
            onConfigFileChange = handler;
        }),
        onDidChangeConfig: vi.fn((handler: ConfigChangedHandler) => {
            onConfigChange = handler;
        }),
        getConfig: vi.fn(() => ({
            flagNames: new Map<number, string>(),
            playbackTestCases: [{ testCase: 0, name: 'First case' }],
        })),
        getConfigFile: vi.fn(() => configFile),
        setFlagName: vi.fn(),
        triggerConfigFileChange: async () => {
            if (onConfigFileChange) {
                await onConfigFileChange();
            }
        },
        triggerConfigChange: () => {
            onConfigChange?.();
        },
    };
}

describe('SdsIoControlService launcher delegation', () => {
    beforeEach(() => {
        launcherState.hasTerminal = false;
        launcherMock.hasTerminal.mockReset();
        launcherMock.hasTerminal.mockImplementation(() => launcherState.hasTerminal);
        launcherMock.stop.mockReset();
        launcherMock.stop.mockResolvedValue(undefined);
        launcherMock.start.mockReset();
        launcherMock.start.mockResolvedValue(true);
        launcherMock.dispose.mockReset();
        vi.mocked(vscode.window.showInputBox).mockReset();
        vi.mocked(vscode.workspace.getConfiguration).mockReset();
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(() => 6060) } as never);
        vi.mocked(selectSdsioMonitorPort).mockReset();
        vi.mocked(selectSdsioMonitorPort).mockImplementation(async (port) => port);
    });

    it('connectServer delegates server startup to launcher', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const provider = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        const connected = await provider.connectServer();

        expect(connected).toBe(true);
        expect(launcherMock.start).toHaveBeenCalledWith({
            basePath: 'c:/workspace/ext',
            configFile: 'active.sdsio.yml',
            monitorPort: 6060,
        });
    });

    it.each([6060, 7070])('uses preferred port %i for both server and client', async (port) => {
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(() => port) } as never);
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(createConfigManager() as never, monitor as never, 'extension');

        await expect(service.connectServer()).resolves.toBe(true);

        expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith('cmsis-sds.sdsio');
        expect(selectSdsioMonitorPort).toHaveBeenCalledWith(port);
        expect(launcherMock.start).toHaveBeenCalledWith(expect.objectContaining({ monitorPort: port }));
        expect(monitor.start).toHaveBeenCalledWith(port);
        expect(monitor.start.mock.invocationCallOrder[0]).toBeGreaterThan(launcherMock.start.mock.invocationCallOrder[0]);
    });

    it('reselects the port on reconnect and shares fallback ports with the monitor', async () => {
        vi.mocked(selectSdsioMonitorPort).mockResolvedValueOnce(49152).mockResolvedValueOnce(49153);
        const monitor = new FakeMonitor();
        const configManager = createConfigManager();
        const service = new SdsIoControlService(configManager as never, monitor as never, 'extension');
        await service.connectServer();
        launcherState.hasTerminal = true;
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: vi.fn(() => 7070) } as never);
        await configManager.triggerConfigFileChange();

        expect(selectSdsioMonitorPort).toHaveBeenNthCalledWith(1, 6060);
        expect(selectSdsioMonitorPort).toHaveBeenNthCalledWith(2, 7070);
        expect(launcherMock.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ monitorPort: 49152 }));
        expect(launcherMock.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ monitorPort: 49153 }));
        expect(monitor.start).toHaveBeenNthCalledWith(1, 49152);
        expect(monitor.start).toHaveBeenNthCalledWith(2, 49153);
    });

    it('does not connect the client when port selection or server launch fails', async () => {
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(createConfigManager() as never, monitor as never, 'extension');
        vi.mocked(selectSdsioMonitorPort).mockRejectedValueOnce(new Error('no available port'));
        await expect(service.connectServer()).resolves.toBe(false);
        expect(launcherMock.start).not.toHaveBeenCalled();
        expect(monitor.start).not.toHaveBeenCalled();

        launcherMock.start.mockResolvedValueOnce(false);
        await expect(service.connectServer()).resolves.toBe(false);
        expect(monitor.start).not.toHaveBeenCalled();
        expect(monitor.stop).toHaveBeenCalled();
    });

    it('shares in-flight port selection and cancels startup on disconnect', async () => {
        let resolvePort!: (port: number) => void;
        vi.mocked(selectSdsioMonitorPort).mockReturnValueOnce(new Promise((resolve) => { resolvePort = resolve; }));
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(createConfigManager() as never, monitor as never, 'extension');
        const first = service.connectServer();
        expect(service.connectServer()).toBe(first);
        const disconnect = service.disconnectServer();
        resolvePort(49152);

        await expect(first).resolves.toBe(false);
        await disconnect;
        expect(selectSdsioMonitorPort).toHaveBeenCalledTimes(1);
        expect(launcherMock.start).not.toHaveBeenCalled();
        expect(monitor.start).not.toHaveBeenCalled();
        expect(monitor.stop).toHaveBeenCalled();
    });

    it('stops a retrying, disconnected monitor on shutdown', async () => {
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(createConfigManager() as never, monitor as never, 'extension');
        await service.shutdown();
        expect(monitor.stop).toHaveBeenCalled();
    });

    it('reconnect path stops existing terminal and restarts through launcher', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();

        launcherMock.hasTerminal
            .mockReturnValueOnce(true)
            .mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await configManager.triggerConfigFileChange();

        expect(launcherMock.stop).toHaveBeenCalledWith('Terminating existing SDSIO server terminal due to config file change');
        expect(launcherMock.start).toHaveBeenCalledWith({
            basePath: 'c:/workspace/ext',
            configFile: 'active.sdsio.yml',
            monitorPort: 6060,
        });
    });

    it('does not start launcher when no config file is selected', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager(undefined);
        const provider = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        const connected = await provider.connectServer();

        expect(connected).toBe(false);
        expect(launcherMock.start).not.toHaveBeenCalled();
    });

    it('creates 8 sdsFlag tree items with checkbox metadata', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        const items = service.getFlagTreeItems();

        expect(items).toHaveLength(8);
        expect(items[0].itemType).toBe('sdsFlag');
        expect(items[0].filePath).toBe('flag-0');
        expect(items[0].description).toBe('(unset)');
        expect(items[0].checkboxState).toBe(0);
    });

    it('sends targeted monitor update for one changed checkbox when connected', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();

        const item = service.getFlagTreeItems()[2];
        service.setEnabledByTreeItems([[item, 1] as never]);

        expect(monitor.setFlag).toHaveBeenCalledWith(2);
        expect(monitor.sendFlags).not.toHaveBeenCalled();
    });

    it('sends full flag mask when multiple checkboxes change', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();

        const items = service.getFlagTreeItems();
        service.setEnabledByTreeItems([
            [items[0], 1] as never,
            [items[1], 1] as never,
        ]);

        expect(monitor.sendFlags).toHaveBeenCalledWith(3, 252);
    });

    it('disconnectServer stops launcher and monitor and toggles canDisconnect', async () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(false);
        launcherMock.start.mockResolvedValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();
        expect(service.canDisconnect()).toBe(true);

        await service.disconnectServer();

        expect(launcherMock.stop).toHaveBeenCalledWith('Disconnecting SDSIO server terminal on user request');
        expect(monitor.stop).toHaveBeenCalled();
        expect(service.canDisconnect()).toBe(false);
    });

    it('canDisconnect is true only when monitor is connected', () => {
        launcherMock.hasTerminal.mockReset();
        launcherMock.stop.mockReset();
        launcherMock.start.mockReset();
        launcherMock.hasTerminal.mockReturnValue(true);

        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        expect(service.canDisconnect()).toBe(false);
    });

    it('renames flags through input validation, normalizes invalid input, and ignores non-flag items', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        const items = service.getFlagTreeItems();
        vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (options: unknown) => {
            const validateInput = (options as { validateInput: (value: string) => string | undefined }).validateInput;
            expect(validateInput('')).toBeUndefined();
            expect(validateInput('Bad#Name')).toBe('Allowed characters: a-z, A-Z, 0-9, - _ . , + / ( )');
            expect(validateInput('2')).toBe('Name already exists');
            expect(validateInput('Renamed Flag')).toBeUndefined();
            return ' Renamed Flag ';
        });

        await service.renameFlag({ itemType: 'sdsFile', filePath: 'flag-0' } as never);
        await service.renameFlag({ itemType: 'sdsFlag', filePath: 'flag-99' } as never);
        await service.renameFlag(items[1]);

        expect(vscode.window.showInputBox).toHaveBeenCalledTimes(1);
        expect(configManager.setFlagName).toHaveBeenCalledWith(1, 'Renamed Flag');
        expect(service.getFlagTreeItems()[1].label).toBe('1: Renamed Flag');

        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('###');
        await service.renameFlag(service.getFlagTreeItems()[0]);

        expect(configManager.setFlagName).toHaveBeenLastCalledWith(0, '0');
    });

    it('falls back to a generated name when flag rename is cancelled', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce(undefined);

        await service.renameFlag(service.getFlagTreeItems()[3]);

        expect(configManager.setFlagName).toHaveBeenCalledWith(3, '3');
    });

    it('notifies directly when a found flag cannot be indexed', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        let changes = 0;
        service.onDidChange(() => {
            changes += 1;
        });
        (service as unknown as { flags: Array<unknown> }).flags.indexOf = vi.fn(() => -1);
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('Unindexed');

        await service.renameFlag(service.getFlagTreeItems()[0]);

        expect(configManager.setFlagName).not.toHaveBeenCalled();
        expect(changes).toBe(1);
    });

    it('syncs flag names from config changes and formats numbered labels', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        configManager.getConfig.mockReturnValue({
            flagNames: new Map<number, string>([[0, 'Ready'], [7, '7']]),
        });
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        expect(service.getFlagTreeItems()[0].label).toBe('0: Ready');
        expect(service.getFlagTreeItems()[7].label).toBe('7');

        configManager.getConfig.mockReturnValue({
            flagNames: new Map<number, string>([[1, 'One']]),
        });
        configManager.triggerConfigChange();

        expect(service.getFlagTreeItems()[0].label).toBe('0');
        expect(service.getFlagTreeItems()[1].label).toBe('1: One');
    });

    it('does not notify or send monitor traffic when checkbox updates do not change managed flags', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        let changes = 0;
        service.onDidChange(() => {
            changes += 1;
        });

        service.setEnabledByTreeItems([
            [{ itemType: 'sdsFile', filePath: 'file.0.sds' }, 1] as never,
            [{ itemType: 'sdsFlag', filePath: 'flag-99' }, 1] as never,
            [service.getFlagTreeItems()[0], 0] as never,
        ]);

        expect(changes).toBe(0);
        expect(monitor.setFlag).not.toHaveBeenCalled();
        expect(monitor.clearFlag).not.toHaveBeenCalled();
        expect(monitor.sendFlags).not.toHaveBeenCalled();
    });

    it('emits flag changes only when flag values actually change', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        const events: SdsIoNotifyEvent[] = [];
        service.onDidChange((event) => {
            events.push(event.event);
        });

        service.setEnabledByTreeItems([[service.getFlagTreeItems()[0], 1] as never]);
        service.setEnabledByTreeItems([[service.getFlagTreeItems()[0], 1] as never]);
        service.setEnabledByTreeItems([[service.getFlagTreeItems()[0], 0] as never]);

        expect(events).toEqual([
            SdsIoNotifyEvent.Flags,
            SdsIoNotifyEvent.Flags,
        ]);
    });

    it('changes checkbox state while disconnected without sending flags', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        service.setEnabledByTreeItems([[service.getFlagTreeItems()[4], 1] as never]);

        expect(service.getFlagMasks()).toEqual({ setMask: 16, unsetMask: 239 });
        expect(monitor.sendFlags).not.toHaveBeenCalled();
    });

    it('falls back to full mask sending when targeted set fails and clears one flag directly', async () => {
        const monitor = new FakeMonitor();
        monitor.setFlag.mockReturnValueOnce(false);
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();

        const flag0 = service.getFlagTreeItems()[0];
        service.setEnabledByTreeItems([[flag0, 1] as never]);

        expect(monitor.setFlag).toHaveBeenCalledWith(0);
        expect(monitor.sendFlags).toHaveBeenCalledWith(1, 254);

        const updatedFlag0 = service.getFlagTreeItems()[0];
        service.setEnabledByTreeItems([[updatedFlag0, 0] as never]);

        expect(monitor.clearFlag).toHaveBeenCalledWith(0);
    });

    it('updates play, record, and stop state with and without monitor connection', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        expect(service.canPlay()).toBe(false);
        expect(service.canRecord()).toBe(false);
        expect(service.canStop()).toBe(false);

        await service.connectServer();

        expect(service.canPlay()).toBe(true);
        expect(service.canRecord()).toBe(true);
        expect(service.canStop()).toBe(false);

        service.play(0);
        expect(service.canPlay()).toBe(false);
        expect(service.canRecord()).toBe(false);
        expect(service.canStop()).toBe(true);
        expect(monitor.startPlayback).toHaveBeenCalledTimes(1);
        expect(monitor.startPlayback).toHaveBeenCalledWith(0);

        service.stop();
        service.record();
        service.stop();

        expect(monitor.startRecording).toHaveBeenCalledTimes(1);
        expect(monitor.stopRecordingOrPlayback).toHaveBeenCalled();
        expect(service.canStop()).toBe(false);
    });

    it('forwards the all-test-cases sentinel for playback without a selection', async () => {
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();

        service.play();

        expect(monitor.startPlayback).toHaveBeenCalledWith(0xffffffff);
    });

    it('accepts and forwards the configured first playback step', async () => {
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();

        expect(service.play(0, 'First case')).toBe(true);
        expect(monitor.startPlayback).toHaveBeenCalledWith(0);
    });

    it('rejects playback test cases missing from the current configuration', async () => {
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();

        expect(service.play(2)).toBe(false);
        expect(monitor.startPlayback).not.toHaveBeenCalled();
        expect(service.canPlay()).toBe(true);
        expect(service.canStop()).toBe(false);
    });

    it('updates command state from hardware monitor open and close events', async () => {
        const monitor = new FakeMonitor();
        const service = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();

        const events: SdsIoNotifyEvent[] = [];
        service.onDidChange((event) => events.push(event.event));

        monitor.emit('open', { mode: 0, fileName: 'playback.0.sds' });
        expect(service.canPlay()).toBe(false);
        expect(service.canRecord()).toBe(false);
        expect(service.canStop()).toBe(true);

        monitor.emit('open', { mode: 0, fileName: 'playback.0.sds' });
        monitor.emit('close', 'playback.0.sds');
        expect(service.canPlay()).toBe(true);
        expect(service.canRecord()).toBe(true);
        expect(service.canStop()).toBe(false);

        monitor.emit('open', { mode: 1, fileName: 'recording.0.sds' });
        expect(service.canPlay()).toBe(false);
        expect(service.canRecord()).toBe(false);
        expect(service.canStop()).toBe(true);

        monitor.emit('close', 'recording.0.sds');
        expect(events).toEqual([
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.FileUpdate,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.FileUpdate,
        ]);
    });

    it('does not transition mode when the connected monitor rejects the operation', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();

        const events: SdsIoNotifyEvent[] = [];
        service.onDidChange((event) => {
            events.push(event.event);
        });

        monitor.startPlayback.mockReturnValueOnce(false);
        service.play(0);

        expect(events).toEqual([]);
        expect(service.canPlay()).toBe(true);
        expect(service.canStop()).toBe(false);

        monitor.startRecording.mockReturnValueOnce(false);
        service.record();

        expect(events).toEqual([]);
        expect(service.canRecord()).toBe(true);
        expect(service.canStop()).toBe(false);

        service.play(0);
        monitor.stopRecordingOrPlayback.mockReturnValueOnce(false);
        service.stop();

        expect(events).toEqual([SdsIoNotifyEvent.Mode]);
        expect(service.canPlay()).toBe(false);
        expect(service.canStop()).toBe(true);
    });

    it('emits mode events on stop and file update only after monitor close', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();

        const events: SdsIoNotifyEvent[] = [];
        service.onDidChange((event) => {
            events.push(event.event);
        });

        service.play(0);
        service.play(0);
        service.stop();
        service.stop();
        service.record();
        service.record();
        service.stop();

        expect(events).toEqual([
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
        ]);

        monitor.emit('close', 'capture.0.sds');

        expect(events).toEqual([
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.Mode,
            SdsIoNotifyEvent.FileUpdate,
        ]);
        expect(monitor.startPlayback).toHaveBeenCalledTimes(1);
        expect(monitor.startRecording).toHaveBeenCalledTimes(1);
        expect(monitor.stopRecordingOrPlayback).toHaveBeenCalledTimes(2);
    });

    it('covers connectServer failure and already-connected branches', async () => {
        const noMonitorService = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            undefined,
            'c:/workspace/ext',
        );
        await expect(noMonitorService.connectServer()).resolves.toBe(false);

        const noBasePathService = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            new FakeMonitor() as never,
            undefined,
        );
        await expect(noBasePathService.connectServer()).resolves.toBe(false);

        const rejectingMonitor = new FakeMonitor();
        rejectingMonitor.start.mockRejectedValueOnce(new Error('connect failed'));
        const rejectingService = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            rejectingMonitor as never,
            'c:/workspace/ext',
        );
        await expect(rejectingService.connectServer()).resolves.toBe(false);

        launcherMock.start.mockRejectedValueOnce(new Error('spawn failed'));
        const monitor = new FakeMonitor();
        const connectedService = new SdsIoControlService(
            createConfigManager('active.sdsio.yml') as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await expect(connectedService.connectServer()).resolves.toBe(false);
        expect(monitor.start).not.toHaveBeenCalled();
        await expect(connectedService.connectServer()).resolves.toBe(true);
        monitor.start.mockClear();
        await expect(connectedService.connectServer()).resolves.toBe(true);
        expect(monitor.start).not.toHaveBeenCalled();
    });

    it('returns false when monitor startup never reaches connected state', async () => {
        vi.useFakeTimers();
        try {
            const monitor = new FakeMonitor();
            monitor.start.mockImplementationOnce(async () => undefined);
            const service = new SdsIoControlService(
                createConfigManager('active.sdsio.yml') as never,
                monitor as never,
                'c:/workspace/ext',
            );

            const connected = service.connectServer();
            await vi.runAllTimersAsync();

            await expect(connected).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops an existing terminal before connecting', async () => {
        launcherState.hasTerminal = true;
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        await service.connectServer();

        expect(launcherMock.stop).toHaveBeenCalledWith('Terminating existing SDSIO server terminal before connecting');
        expect(launcherMock.start).toHaveBeenCalledWith({
            basePath: 'c:/workspace/ext',
            configFile: 'active.sdsio.yml',
            monitorPort: 6060,
        });
    });

    it('reconnects from config changes by stopping a connected monitor first', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();
        monitor.stop.mockClear();
        launcherState.hasTerminal = true;

        await configManager.triggerConfigFileChange();

        expect(monitor.stop).toHaveBeenCalled();
        expect(monitor.stop.mock.invocationCallOrder[0]).toBeLessThan(launcherMock.stop.mock.invocationCallOrder[0]);
        expect(service.canDisconnect()).toBe(true);
    });

    it('shuts down once while a shutdown is already in progress', async () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        await service.connectServer();
        let resolveStop: (() => void) | undefined;
        launcherMock.stop.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
            resolveStop = () => resolve(undefined);
        }));

        const first = service.shutdown('closing');
        const second = service.shutdown('closing again');

        expect(launcherMock.stop).toHaveBeenCalledTimes(1);
        resolveStop?.();
        await Promise.all([first, second]);

        expect(monitor.stop).toHaveBeenCalled();
        expect(launcherMock.dispose).toHaveBeenCalledTimes(1);
    });

    it('updates flags and connection state from monitor events', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );

        monitor.emit('connected');
        monitor.emit('info', { sdsFlags: 0b00000101 });

        expect(service.canDisconnect()).toBe(true);
        expect(service.getFlagMasks()).toEqual({ setMask: 5, unsetMask: 250 });
        expect(service.getFlagTreeItems()[0].description).toBe('(set)');
        expect(service.getFlagTreeItems()[1].description).toBe('(unset)');
        expect(service.getConnectionState()).toBe('');

        monitor.emit('disconnected');
        expect(service.canConnect()).toBe(true);
    });

    it('deduplicates repeated monitor connection and flag info events', () => {
        const monitor = new FakeMonitor();
        const configManager = createConfigManager('active.sdsio.yml');
        const service = new SdsIoControlService(
            configManager as never,
            monitor as never,
            'c:/workspace/ext',
        );
        const events: SdsIoNotifyEvent[] = [];
        service.onDidChange((event) => {
            events.push(event.event);
        });

        monitor.emit('connected');
        monitor.emit('connected');
        monitor.emit('info', { sdsFlags: 0b00000101 });
        monitor.emit('info', { sdsFlags: 0b00000101 });
        monitor.emit('info', { sdsFlags: 0b00000100 });
        monitor.emit('disconnected');
        monitor.emit('disconnected');

        expect(events).toEqual([
            SdsIoNotifyEvent.Connected,
            SdsIoNotifyEvent.Flags,
            SdsIoNotifyEvent.Flags,
            SdsIoNotifyEvent.Connected,
        ]);
    });
});
