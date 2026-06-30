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

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';

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

        constructor(public label: string, public collapsibleState?: number) { }
    }

    class ThemeIcon {
        constructor(public id: string) { }
    }

    const createFileSystemWatcher = () => ({
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        onDidChange: vi.fn(),
        dispose: vi.fn(),
    });

    return {
        EventEmitter,
        TreeItem,
        ThemeIcon,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        workspace: {
            workspaceFolders: [{ uri: { fsPath: 'c:/workspace' } }],
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

function createDirent(name: string, kind: 'file' | 'directory') {
    return {
        name,
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
    };
}

describe('SdsExplorerProvider', () => {
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

        const flagItems = await provider.getChildren(rootItems[1]);

        expect(flagItems).toEqual([flagItem]);
    });

    it('fires targeted refresh events for stable files and flags root nodes', async () => {
        const configManager = {
            onDidChangeConfig: vi.fn(),
            getConfigFile: vi.fn(() => 'active.sdsio.yml'),
            getConfig: vi.fn(() => ({ workdir: undefined, metadir: undefined })),
        };

        const provider = new SdsExplorerProvider(configManager as never);
        const rootItems = await provider.getChildren();
        const refreshedItems: Array<SdsTreeItem | undefined | null> = [];
        provider.onDidChangeTreeData((item) => {
            refreshedItems.push(item);
        });

        provider.refreshFiles();
        provider.refreshFlags();
        provider.refresh();

        expect(refreshedItems).toEqual([rootItems[0], rootItems[1], undefined]);
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
});
