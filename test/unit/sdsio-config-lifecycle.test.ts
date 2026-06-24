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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const vscodeMockState = vi.hoisted(() => {
    const state = {
        asRelativePathMock: vi.fn((uri: { fsPath: string }) => uri.fsPath),
        configValue: '',
        executeCommandMock: vi.fn(async () => undefined),
        getWorkspaceFolderMock: vi.fn(),
        onDidChangeConfigurationMock: vi.fn((listener: (event: { affectsConfiguration: (section: string) => boolean }) => void) => {
            state.configurationChangeListener = listener;
            return { dispose: vi.fn() };
        }),
        updateMock: vi.fn(async () => undefined),
        workspaceFolders: [] as Array<{ name: string; uri: { fsPath: string } }>,
        configurationChangeListener: undefined as ((event: { affectsConfiguration: (section: string) => boolean }) => void) | undefined,
    };

    return state;
});

vi.mock('vscode', () => ({
    commands: {
        executeCommand: vscodeMockState.executeCommandMock,
    },
    ConfigurationTarget: {
        Workspace: 1,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
    },
    workspace: {
        asRelativePath: vscodeMockState.asRelativePathMock,
        getConfiguration: vi.fn(() => ({
            get: vi.fn(() => vscodeMockState.configValue),
            update: vscodeMockState.updateMock,
        })),
        getWorkspaceFolder: vscodeMockState.getWorkspaceFolderMock,
        get workspaceFolders() {
            return vscodeMockState.workspaceFolders;
        },
        onDidChangeConfiguration: vscodeMockState.onDidChangeConfigurationMock,
    },
}));

import * as vscode from 'vscode';
import { setupSdsioConfigLifecycle } from '../../src/config/sdsioConfigLifecycle';

function createContext() {
    return {
        subscriptions: [] as Array<{ dispose: () => void }>,
    };
}

function createHarness() {
    const context = createContext();
    const configManager = {
        setConfigFile: vi.fn(),
    };
    const explorerTreeView = {
        title: 'Files',
    };
    const lifecycle = setupSdsioConfigLifecycle(
        context as never,
        configManager as never,
        explorerTreeView as never,
        '.sdsio.yml'
    );

    return { configManager, context, explorerTreeView, lifecycle };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function createWorkspaceFolder(name: string, fsPath: string) {
    return {
        name,
        uri: { fsPath },
    };
}

describe('setupSdsioConfigLifecycle', () => {
    let tmpDir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsio-config-lifecycle-'));
        vscodeMockState.asRelativePathMock.mockImplementation((uri: { fsPath: string }) => uri.fsPath);
        vscodeMockState.configValue = '';
        vscodeMockState.configurationChangeListener = undefined;
        vscodeMockState.getWorkspaceFolderMock.mockReturnValue(undefined);
        vscodeMockState.updateMock.mockResolvedValue(undefined);
        vscodeMockState.workspaceFolders = [];
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('initializes from a configured workspace-relative file and updates explorer UI', async () => {
        const configPath = path.join(tmpDir, 'target.sdsio.yml');
        fs.writeFileSync(configPath, 'sdsio:\n', 'utf-8');
        vscodeMockState.configValue = 'target.sdsio.yml';
        vscodeMockState.workspaceFolders = [createWorkspaceFolder('root', tmpDir)];

        const { configManager, context, explorerTreeView, lifecycle } = createHarness();
        await flushPromises();

        expect(lifecycle.resolveConfigPathFromSettings()).toBe(configPath);
        expect(configManager.setConfigFile).toHaveBeenCalledWith(configPath);
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', 'arm-sds.sdsio.hasConfig', true);
        expect(explorerTreeView.title).toBe('target');
        expect(context.subscriptions).toHaveLength(1);
        expect(vscode.workspace.onDidChangeConfiguration).toHaveBeenCalledTimes(1);
    });

    it('persists a selected config as a single-workspace relative path and can clear it', async () => {
        const configPath = path.join(tmpDir, 'configs', 'target.sdsio.yml');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, 'sdsio:\n', 'utf-8');
        const owningFolder = createWorkspaceFolder('root', tmpDir);
        vscodeMockState.workspaceFolders = [owningFolder];
        vscodeMockState.getWorkspaceFolderMock.mockReturnValue(owningFolder);
        const { configManager, explorerTreeView, lifecycle } = createHarness();
        await flushPromises();
        vi.clearAllMocks();

        await lifecycle.setActiveConfig(configPath, true);

        expect(configManager.setConfigFile).toHaveBeenCalledWith(configPath);
        expect(explorerTreeView.title).toBe('target');
        expect(vscodeMockState.updateMock).toHaveBeenCalledWith(
            'configFile',
            ['configs', 'target.sdsio.yml'].join('/'),
            vscode.ConfigurationTarget.Workspace
        );

        await lifecycle.setActiveConfig(undefined, true);

        expect(configManager.setConfigFile).toHaveBeenLastCalledWith(undefined);
        expect(explorerTreeView.title).toBe('Files');
        expect(vscodeMockState.updateMock).toHaveBeenLastCalledWith(
            'configFile',
            '',
            vscode.ConfigurationTarget.Workspace
        );
    });

    it('persists multi-root configs with the owning workspace folder name', async () => {
        const appRoot = path.join(tmpDir, 'app');
        const docsRoot = path.join(tmpDir, 'docs');
        const configPath = path.join(appRoot, 'nested', 'board.sdsio.yml');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, 'sdsio:\n', 'utf-8');
        const appFolder = createWorkspaceFolder('app', appRoot);
        vscodeMockState.workspaceFolders = [
            appFolder,
            createWorkspaceFolder('docs', docsRoot),
        ];
        vscodeMockState.getWorkspaceFolderMock.mockReturnValue(appFolder);
        const { lifecycle } = createHarness();
        await flushPromises();
        vi.clearAllMocks();

        await lifecycle.setActiveConfig(configPath, true);

        expect(vscodeMockState.updateMock).toHaveBeenCalledWith(
            'configFile',
            'app/nested/board.sdsio.yml',
            vscode.ConfigurationTarget.Workspace
        );
    });

    it('falls back to asRelativePath when persisting a config outside workspace ownership', async () => {
        const configPath = path.join(tmpDir, 'external.sdsio.yml');
        fs.writeFileSync(configPath, 'sdsio:\n', 'utf-8');
        vscodeMockState.getWorkspaceFolderMock.mockReturnValue(undefined);
        vscodeMockState.asRelativePathMock.mockReturnValue('external/target.sdsio.yml');
        const { lifecycle } = createHarness();
        await flushPromises();
        vi.clearAllMocks();

        await lifecycle.setActiveConfig(configPath, true);

        expect(vscode.workspace.asRelativePath).toHaveBeenCalledWith({ fsPath: configPath }, true);
        expect(vscodeMockState.updateMock).toHaveBeenCalledWith(
            'configFile',
            'external/target.sdsio.yml',
            vscode.ConfigurationTarget.Workspace
        );
    });

    it('resolves multi-root folder-prefixed settings and returns undefined for missing files', async () => {
        const appRoot = path.join(tmpDir, 'app');
        const docsRoot = path.join(tmpDir, 'docs');
        const configPath = path.join(appRoot, 'configs', 'target.sdsio.yml');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, 'sdsio:\n', 'utf-8');
        vscodeMockState.workspaceFolders = [
            createWorkspaceFolder('app', appRoot),
            createWorkspaceFolder('docs', docsRoot),
        ];
        vscodeMockState.configValue = ['app', 'configs', 'target.sdsio.yml'].join(path.sep);
        const { lifecycle } = createHarness();
        await flushPromises();

        expect(lifecycle.resolveConfigPathFromSettings()).toBe(configPath);

        vscodeMockState.configValue = 'missing.sdsio.yml';

        expect(lifecycle.resolveConfigPathFromSettings()).toBeUndefined();
    });

    it('applies external configuration changes and ignores changes caused by its own persistence', async () => {
        const activePath = path.join(tmpDir, 'active.sdsio.yml');
        const changedPath = path.join(tmpDir, 'changed.sdsio.yml');
        fs.writeFileSync(activePath, 'sdsio:\n', 'utf-8');
        fs.writeFileSync(changedPath, 'sdsio:\n', 'utf-8');
        vscodeMockState.workspaceFolders = [createWorkspaceFolder('root', tmpDir)];
        const { configManager, lifecycle } = createHarness();
        await flushPromises();
        vi.clearAllMocks();

        vscodeMockState.configurationChangeListener?.({
            affectsConfiguration: vi.fn(() => false),
        });
        await flushPromises();

        expect(configManager.setConfigFile).not.toHaveBeenCalled();

        vscodeMockState.configValue = 'changed.sdsio.yml';
        vscodeMockState.configurationChangeListener?.({
            affectsConfiguration: vi.fn((section) => section === 'cmsis-sds.sdsio.configFile'),
        });
        await flushPromises();

        expect(configManager.setConfigFile).toHaveBeenCalledWith(changedPath);

        vi.clearAllMocks();
        vscodeMockState.getWorkspaceFolderMock.mockReturnValue(createWorkspaceFolder('root', tmpDir));
        vscodeMockState.updateMock.mockImplementationOnce(async () => {
            vscodeMockState.configurationChangeListener?.({
                affectsConfiguration: vi.fn((section) => section === 'cmsis-sds.sdsio.configFile'),
            });
        });

        await lifecycle.setActiveConfig(activePath, true);

        expect(configManager.setConfigFile).toHaveBeenCalledTimes(1);
        expect(configManager.setConfigFile).toHaveBeenCalledWith(activePath);

        vscodeMockState.configurationChangeListener?.({
            affectsConfiguration: vi.fn((section) => section === 'cmsis-sds.sdsio.configFile'),
        });
        await flushPromises();

        expect(configManager.setConfigFile).toHaveBeenCalledTimes(2);
        expect(configManager.setConfigFile).toHaveBeenLastCalledWith(changedPath);
    });

    it('normalizes missing active config paths to undefined without persisting when requested not to', async () => {
        const missingPath = path.join(tmpDir, 'missing.sdsio.yml');
        const { configManager, explorerTreeView, lifecycle } = createHarness();
        await flushPromises();
        vi.clearAllMocks();

        await lifecycle.setActiveConfig(missingPath, false);

        expect(configManager.setConfigFile).toHaveBeenCalledWith(undefined);
        expect(explorerTreeView.title).toBe('Files');
        expect(vscodeMockState.updateMock).not.toHaveBeenCalled();
    });
});
