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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let lastWatcher: { triggerChange: () => void; dispose: ReturnType<typeof vi.fn> } | undefined;

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

        dispose(): void {
            this.listeners = [];
        }
    }

    class RelativePattern {
        constructor(public base: { fsPath: string }, public pattern: string) { }
    }

    const workspace = {
        createFileSystemWatcher: vi.fn(() => {
            let onDidChange: (() => void) | undefined;
            const dispose = vi.fn();
            lastWatcher = {
                triggerChange: () => onDidChange?.(),
                dispose,
            };
            return {
                onDidChange: (listener: () => void) => {
                    onDidChange = listener;
                    return { dispose: vi.fn() };
                },
                dispose,
            };
        }),
    };

    const Uri = {
        file: (fsPath: string) => ({ fsPath }),
    };

    return {
        EventEmitter,
        RelativePattern,
        Uri,
        workspace,
    };
});

import { SdsioConfigManager } from '../../src/controller/sdsioConfigManager';

describe('SdsioConfigManager', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsio-config-manager-'));
        lastWatcher = undefined;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('parses workdir, metadir and valid flag names from config file', () => {
        const configPath = path.join(tmpDir, '.sdsio.yml');
        fs.writeFileSync(configPath, [
            'workdir: ./work',
            'metadir: "./meta dir"',
            'flag-info:',
            '  - 0: Zero',
            '  - 7: Seven',
            '  - 8: IgnoredOutOfRange',
            '',
        ].join('\n'), 'utf-8');

        const manager = new SdsioConfigManager();
        manager.setConfigFile(configPath);

        const parsed = manager.getConfig();
        expect(manager.getConfigFile()).toBe(configPath);
        expect(parsed.workdir).toBe(path.resolve(tmpDir, './work'));
        expect(parsed.metadir).toBe(path.resolve(tmpDir, './meta dir'));
        expect(parsed.flagNames.get(0)).toBe('Zero');
        expect(parsed.flagNames.get(7)).toBe('Seven');
        expect(parsed.flagNames.has(8)).toBe(false);

        manager.dispose();
    });

    it('re-parses and notifies on watcher content change', () => {
        const configPath = path.join(tmpDir, '.sdsio.yml');
        fs.writeFileSync(configPath, 'workdir: ./a\n', 'utf-8');

        const manager = new SdsioConfigManager();
        let events = 0;
        manager.onDidChangeConfig(() => {
            events += 1;
        });

        manager.setConfigFile(configPath);
        expect(events).toBe(1);
        expect(lastWatcher).toBeDefined();
        expect(manager.getConfig().workdir).toBe(path.resolve(tmpDir, './a'));

        fs.writeFileSync(configPath, 'workdir: ./b\n', 'utf-8');
        lastWatcher?.triggerChange();

        expect(manager.getConfig().workdir).toBe(path.resolve(tmpDir, './b'));
        expect(events).toBe(2);

        manager.dispose();
    });

    it('setFlagName updates in-memory data and writes updated flag-info block', () => {
        const configPath = path.join(tmpDir, '.sdsio.yml');
        fs.writeFileSync(configPath, [
            'workdir: ./work',
            'flag-info:',
            '  - 0: Old',
            '',
        ].join('\n'), 'utf-8');

        const manager = new SdsioConfigManager();
        let events = 0;
        manager.onDidChangeConfig(() => {
            events += 1;
        });

        manager.setConfigFile(configPath);
        manager.setFlagName(0, 'New');
        manager.setFlagName(1, 'One');

        const parsed = manager.getConfig();
        expect(parsed.flagNames.get(0)).toBe('New');
        expect(parsed.flagNames.get(1)).toBe('One');

        const updated = fs.readFileSync(configPath, 'utf-8');
        expect(updated).toContain('flag-info:');
        expect(updated).toContain('- 0: New');
        expect(updated).toContain('- 1: One');
        expect(updated).not.toContain('- 0: Old');
        expect(events).toBe(3);

        manager.dispose();
    });

    it('setFlagName removes default labels and deletes empty flag-info block', () => {
        const configPath = path.join(tmpDir, '.sdsio.yml');
        fs.writeFileSync(configPath, [
            'workdir: ./work',
            'flag-info:',
            '  - 0: KeepMeForNow',
            '',
        ].join('\n'), 'utf-8');

        const manager = new SdsioConfigManager();
        manager.setConfigFile(configPath);

        manager.setFlagName(0, '0');

        expect(manager.getConfig().flagNames.size).toBe(0);
        const updated = fs.readFileSync(configPath, 'utf-8');
        expect(updated).not.toContain('flag-info:');

        manager.dispose();
    });

    it('suppresses the immediate watcher change after internal write-back', () => {
        const configPath = path.join(tmpDir, '.sdsio.yml');
        fs.writeFileSync(configPath, 'workdir: ./work\n', 'utf-8');

        const manager = new SdsioConfigManager();
        let events = 0;
        manager.onDidChangeConfig(() => {
            events += 1;
        });

        manager.setConfigFile(configPath);
        expect(events).toBe(1);

        manager.setFlagName(2, 'Custom');
        expect(events).toBe(2);

        // First watcher signal right after write-back should be ignored.
        lastWatcher?.triggerChange();
        expect(events).toBe(2);

        // Subsequent watcher signal should be processed normally.
        lastWatcher?.triggerChange();
        expect(events).toBe(3);

        manager.dispose();
    });

    it('deactivates config when path is missing and resets parsed data', () => {
        const manager = new SdsioConfigManager();
        let events = 0;
        manager.onDidChangeConfig(() => {
            events += 1;
        });

        manager.setConfigFile(path.join(tmpDir, 'does-not-exist.yml'));

        expect(manager.getConfigFile()).toBeUndefined();
        expect(manager.getConfig().workdir).toBeUndefined();
        expect(manager.getConfig().metadir).toBeUndefined();
        expect(manager.getConfig().flagNames.size).toBe(0);
        expect(events).toBe(1);

        manager.dispose();
    });
});
