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
import * as fs from 'fs';

const watcherMockState = vi.hoisted(() => ({
    watchers: [] as Array<{
        onDidCreate: ReturnType<typeof vi.fn>;
        onDidDelete: ReturnType<typeof vi.fn>;
        onDidChange: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        triggerCreate: () => void;
        triggerDelete: () => void;
        triggerChange: () => void;
    }>,
}));

vi.mock('vscode', () => {
    class EventEmitter<T> {
        private listeners: Array<(event: T) => void> = [];

        readonly event = (listener: (event: T) => void) => {
            this.listeners.push(listener);
            return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
        };

        fire(event: T): void {
            for (const listener of this.listeners) {
                listener(event);
            }
        }
    }

    class TreeItem {
        contextValue?: string;
        tooltip?: string;
        iconPath?: unknown;
        command?: unknown;
        description?: string;
        resourceUri?: unknown;

        constructor(public label: string, public collapsibleState?: number) { }
    }

    class ThemeIcon {
        constructor(public id: string) { }
    }

    const createFileSystemWatcher = () => {
        let onCreate: (() => void) | undefined;
        let onDelete: (() => void) | undefined;
        let onChange: (() => void) | undefined;
        const watcher = {
            onDidCreate: vi.fn((listener: () => void) => {
                onCreate = listener;
                return { dispose: vi.fn() };
            }),
            onDidDelete: vi.fn((listener: () => void) => {
                onDelete = listener;
                return { dispose: vi.fn() };
            }),
            onDidChange: vi.fn((listener: () => void) => {
                onChange = listener;
                return { dispose: vi.fn() };
            }),
            dispose: vi.fn(),
            triggerCreate: () => onCreate?.(),
            triggerDelete: () => onDelete?.(),
            triggerChange: () => onChange?.(),
        };
        watcherMockState.watchers.push(watcher);
        return watcher;
    };

    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        workspace: {
            workspaceFolders: [{ name: 'workspace', uri: { fsPath: 'c:/workspace' } }],
            createFileSystemWatcher,
        },
        Uri: { file: (filePath: string) => ({ fsPath: filePath }) },
        window: {
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

vi.mock('fs', () => ({
    existsSync: vi.fn(() => false),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ size: 0 })),
}));

vi.mock('../../src/sds/writer', () => ({
    parseMetadataFile: vi.fn(),
}));

vi.mock('../../src/sds/types', async () => {
    const actual = await vi.importActual('../../src/sds/types');
    return {
        ...actual,
        detectMediaType: vi.fn(() => 'sensor'),
    };
});

import { SdsExplorerProvider, SdsTreeItem } from '../../src/providers/sdsExplorerProvider';
import * as vscode from 'vscode';
import { parseMetadataFile } from '../../src/sds/writer';
import { detectMediaType } from '../../src/sds/types';

function createDirent(name: string, kind: 'file' | 'directory') {
    return {
        name,
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
    };
}

describe('SdsExplorerProvider', () => {
    beforeEach(() => {
        watcherMockState.watchers.length = 0;
        vi.mocked(fs.existsSync).mockReset();
        vi.mocked(fs.existsSync).mockImplementation(() => false);
        vi.mocked(fs.readdirSync).mockReset();
        vi.mocked(fs.readdirSync).mockImplementation(() => [] as never);
        vi.mocked(fs.statSync).mockReset();
        vi.mocked(fs.statSync).mockImplementation(() => ({ size: 0 }) as never);
        vi.mocked(parseMetadataFile).mockReset();
        vi.mocked(detectMediaType).mockReset();
        vi.mocked(detectMediaType).mockReturnValue('sensor');
        (vscode.workspace as unknown as { workspaceFolders?: Array<{ name?: string; uri: { fsPath: string } }> }).workspaceFolders = [
            { name: 'workspace', uri: { fsPath: 'c:/workspace' } },
        ];
    });

    it('sets icons, commands, and collapsible state for special tree item types', () => {
        const group = new SdsTreeItem('stream', 'group', 'stream.sds.yml', 2);
        const info = new SdsTreeItem('No files', 'info', '', 0);
        const metadata = new SdsTreeItem('stream.sds.yml', 'metadataFile', 'c:/workspace/stream.sds.yml', 0);

        expect((group.iconPath as { id: string }).id).toBe('library');
        expect(group.collapsibleState).toBe(1);
        expect((info.iconPath as { id: string }).id).toBe('info');
        expect((metadata.iconPath as { id: string }).id).toBe('file-code');
        expect(metadata.command).toEqual({
            command: 'vscode.open',
            title: 'Open Metadata',
            arguments: [{ fsPath: 'c:/workspace/stream.sds.yml' }],
        });
    });

    it('fires refresh events from public refresh and file/config watcher callbacks, and disposes watchers', () => {
        let configChangeHandler: (() => void) | undefined;
        const configManager = {
            onDidChangeConfig: vi.fn((handler: () => void) => {
                configChangeHandler = handler;
            }),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };
        const provider = new SdsExplorerProvider(configManager as never);
        let refreshEvents = 0;
        provider.onDidChangeTreeData(() => {
            refreshEvents += 1;
        });
        const item = new SdsTreeItem('stream', 'sdsFile', 'stream.0.sds', 0);

        provider.refresh();
        watcherMockState.watchers[0].triggerCreate();
        watcherMockState.watchers[1].triggerDelete();
        watcherMockState.watchers[2].triggerChange();
        configChangeHandler?.();

        expect(provider.getTreeItem(item)).toBe(item);
        expect(refreshEvents).toBe(5);

        provider.dispose();

        expect(watcherMockState.watchers.every((watcher) => watcher.dispose.mock.calls.length === 1)).toBe(true);
    });

    it('returns no children without workspace folders and returns element children directly', async () => {
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };
        const child = new SdsTreeItem('child.0.sds', 'sdsFile', 'child.0.sds', 0);
        const parent = new SdsTreeItem('parent', 'folder', '', 2, [child]);
        const provider = new SdsExplorerProvider(configManager as never);

        (vscode.workspace as unknown as { workspaceFolders?: Array<{ uri: { fsPath: string } }> }).workspaceFolders = undefined;
        await expect(provider.getChildren()).resolves.toEqual([]);

        (vscode.workspace as unknown as { workspaceFolders?: Array<{ uri: { fsPath: string } }> }).workspaceFolders = [{ uri: { fsPath: 'c:/workspace' } }];
        await expect(provider.getChildren(parent)).resolves.toEqual([child]);
    });

    it('returns two root nodes and includes flags node with description from flags source', async () => {
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };

        const flagItem = new SdsTreeItem('0: Flag 0', 'sdsFlag', 'flag-0', 0);
        const flagsSource = {
            getFlagTreeItems: vi.fn(() => [flagItem]),
            getConnectionState: vi.fn(() => 'connected'),
        };

        const provider = new SdsExplorerProvider(configManager as never, flagsSource);

        const rootItems = await provider.getChildren();

        expect(rootItems).toHaveLength(2);
        expect(rootItems[0].label).toBe('SDS Files');
        expect(rootItems[1].label).toBe('SDS Flags');
        expect(rootItems[1].description).toBe('connected');
        expect(rootItems[1].children).toEqual([flagItem]);
    });

    it('returns empty list when no active config file is selected', async () => {
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => undefined),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };

        const provider = new SdsExplorerProvider(configManager as never);
        const rootItems = await provider.getChildren();

        expect(rootItems).toEqual([]);
    });

    it('scanDirectory groups recursive files by stream name and keeps label and playback variants', async () => {
        const readdirSyncMock = vi.mocked(fs.readdirSync);
        const existsSyncMock = vi.mocked(fs.existsSync);
        const statSyncMock = vi.mocked(fs.statSync);

        readdirSyncMock.mockImplementation((dirPath: fs.PathLike) => {
            const normalized = String(dirPath).replace(/\\/g, '/');
            switch (normalized) {
                case 'c:/workspace':
                    return [
                        createDirent('acc', 'directory'),
                        createDirent('ml', 'directory'),
                    ] as never;
                case 'c:/workspace/acc':
                    return [
                        createDirent('acc.sds.yml', 'file'),
                        createDirent('acc.0.sds', 'file'),
                    ] as never;
                case 'c:/workspace/ml':
                    return [
                        createDirent('ml_in.sds.yml', 'file'),
                        createDirent('ml_in.0.sds', 'file'),
                        createDirent('ml_in.1.p.sds', 'file'),
                        createDirent('ml_in.rock.2.sds', 'file'),
                        createDirent('ml_in.rock.3.p.sds', 'file'),
                    ] as never;
                default:
                    return [] as never;
            }
        });

        existsSyncMock.mockImplementation((targetPath: fs.PathLike) => {
            const normalized = String(targetPath).replace(/\\/g, '/');
            return normalized.endsWith('/acc.sds.yml') || normalized.endsWith('/ml_in.sds.yml');
        });
        statSyncMock.mockImplementation(() => ({ size: 32 }) as never);

        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };

        const provider = new SdsExplorerProvider(configManager as never);
        const groups = new Map<string, SdsTreeItem[]>();

        await (provider as unknown as {
            scanDirectory: (
                dirPath: string,
                groups: Map<string, SdsTreeItem[]>,
                recursive: boolean,
                metadataByStream?: Map<string, string>,
                usedMetadataFiles?: Set<string>
            ) => Promise<void>;
        }).scanDirectory('c:/workspace', groups, true);

        const actual = new Map(
            [...groups.entries()].map(([groupName, items]) => [
                groupName,
                items
                    .filter((item) => item.itemType === 'sdsFile')
                    .map((item) => item.filePath.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.sds$/i, '')),
            ])
        );

        expect(actual).toEqual(new Map([
            ['acc', ['acc.0']],
            ['ml_in', ['ml_in.0', 'ml_in.1.p', 'ml_in.rock.2', 'ml_in.rock.3.p']],
        ]));
    });

    it('scans configured metadata and SDS directories, adds metadata-only groups, and routes media files', async () => {
        vi.mocked(fs.readdirSync).mockImplementation((dirPath: fs.PathLike) => {
            const normalized = String(dirPath).replace(/\\/g, '/');
            switch (normalized) {
                case 'c:/meta':
                    return [
                        createDirent('sensor.sds.yml', 'file'),
                        createDirent('unused.sds.yml', 'file'),
                        createDirent('nested', 'directory'),
                        createDirent('.hidden', 'directory'),
                        createDirent('node_modules', 'directory'),
                        createDirent('notes.txt', 'file'),
                    ] as never;
                case 'c:/meta/nested':
                    return [
                        createDirent('image.sds.yml', 'file'),
                    ] as never;
                case 'c:/data':
                    return [
                        createDirent('sensor.0.sds', 'file'),
                        createDirent('sub', 'directory'),
                    ] as never;
                case 'c:/data/sub':
                    return [
                        createDirent('image.0.sds', 'file'),
                    ] as never;
                default:
                    return [] as never;
            }
        });
        vi.mocked(fs.existsSync).mockImplementation((targetPath: fs.PathLike) => {
            const normalized = String(targetPath).replace(/\\/g, '/');
            return [
                'c:/meta',
                'c:/meta/sensor.sds.yml',
                'c:/meta/unused.sds.yml',
                'c:/meta/nested/image.sds.yml',
            ].includes(normalized);
        });
        vi.mocked(fs.statSync).mockImplementation((targetPath: fs.PathLike) => {
            const normalized = String(targetPath).replace(/\\/g, '/');
            return { size: normalized.endsWith('image.0.sds') ? 2 * 1024 * 1024 : 512 } as never;
        });
        vi.mocked(parseMetadataFile).mockImplementation((metadataPath: string) => ({ metadataPath }) as never);
        vi.mocked(detectMediaType).mockImplementation((metadata: unknown) => {
            return String((metadata as { metadataPath: string }).metadataPath).includes('image') ? 'image' : 'sensor';
        });
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: 'c:/data', metadir: 'c:/meta' })),
        };
        const provider = new SdsExplorerProvider(configManager as never);

        const rootItems = await provider.getChildren();
        const filesRoot = rootItems[0];
        const groups = filesRoot.children ?? [];
        const imageGroup = groups.find((item) => item.label === 'image');
        const sensorGroup = groups.find((item) => item.label === 'sensor');
        const unusedGroup = groups.find((item) => item.label === 'unused');
        const imageFile = imageGroup?.children?.[0];
        const sensorFile = sensorGroup?.children?.[0];

        expect(imageGroup?.contextValue).toBe('groupMetadata');
        expect(imageGroup?.filePath.replace(/\\/g, '/')).toBe('c:/meta/nested/image.sds.yml');
        expect(imageFile?.command).toEqual({
            command: 'arm-sds.openMediaViewer',
            title: 'Open in Media Viewer',
            arguments: [imageFile],
        });
        expect((imageFile?.iconPath as { id: string }).id).toBe('paintcan');
        expect(imageFile?.description).toBe('2.0 MB');
        expect(sensorFile?.description).toBe('512 B');
        expect(unusedGroup?.contextValue).toBe('groupMetadata');
        expect(unusedGroup?.description).toBe('0 recordings');
        expect(unusedGroup?.children).toEqual([]);
    });

    it('scans workdir-only configs and sorts groups before standalone SDS files', async () => {
        vi.mocked(fs.readdirSync).mockImplementation((dirPath: fs.PathLike) => {
            const normalized = String(dirPath).replace(/\\/g, '/');
            if (normalized === 'c:/work') {
                return [
                    createDirent('beta.0.sds', 'file'),
                    createDirent('alpha.sds.yml', 'file'),
                    createDirent('alpha.0.sds', 'file'),
                ] as never;
            }
            return [] as never;
        });
        vi.mocked(fs.existsSync).mockImplementation((targetPath: fs.PathLike) => String(targetPath).replace(/\\/g, '/').endsWith('alpha.sds.yml'));
        vi.mocked(fs.statSync).mockImplementation((targetPath: fs.PathLike) => {
            const normalized = String(targetPath).replace(/\\/g, '/');
            return { size: normalized.endsWith('beta.0.sds') ? 1536 : 1024 } as never;
        });
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: 'c:/work', metadir: undefined })),
        };
        const provider = new SdsExplorerProvider(configManager as never);

        const rootItems = await provider.getChildren();
        const files = rootItems[0].children ?? [];

        expect(files.map((item) => item.label)).toEqual(['alpha', 'beta.0.sds']);
        expect(files[0].itemType).toBe('group');
        expect(files[1].itemType).toBe('sdsFile');
        expect(files[1].description).toBe('1.5 KB');
    });
});
