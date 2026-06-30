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

vi.mock('vscode', () => {
    class Uri {
        constructor(public fsPath: string) { }

        static file(fsPath: string): Uri {
            return new Uri(fsPath);
        }
    }

    return {
        commands: {
            executeCommand: vi.fn(),
            registerCommand: commandMockState.registerCommandMock,
        },
        Uri,
        window: {
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showInputBox: vi.fn(),
            showOpenDialog: vi.fn(),
            showQuickPick: vi.fn(),
            showTextDocument: vi.fn(),
            showWarningMessage: vi.fn(),
        },
        workspace: {
            asRelativePath: vi.fn((uri: Uri) => uri.fsPath),
            findFiles: vi.fn(async () => []),
            getWorkspaceFolder: vi.fn(),
            openTextDocument: vi.fn(async (uri: Uri) => ({ uri })),
            workspaceFolders: undefined,
        },
    };
});

import * as vscode from 'vscode';
import { registerSdsioConfigCommands } from '../../src/commands/sdsioConfigCommands';

function createContext() {
    return {
        subscriptions: [] as Array<{ dispose: () => void }>,
    };
}

function registerCommands(overrides: Partial<Parameters<typeof registerSdsioConfigCommands>[0]> = {}) {
    const context = createContext();
    const args = {
        context: context as never,
        configManager: {
            getConfigFile: vi.fn(() => undefined),
        },
        configExtension: '.sdsio.yml',
        configTemplate: 'sdsio:\n  workdir: .\n',
        setActiveConfig: vi.fn(async () => undefined),
        resolveConfigPathFromSettings: vi.fn(() => undefined),
        ensureWorkspaceConfigFile: vi.fn(),
        ...overrides,
    };

    registerSdsioConfigCommands(args as Parameters<typeof registerSdsioConfigCommands>[0]);
    return { context, args };
}

function getCommand(command: string): (...args: unknown[]) => unknown {
    const registration = commandMockState.registeredDisposables.find((disposable) => disposable.command === command);
    if (!registration) {
        throw new Error(`Command was not registered: ${command}`);
    }
    return registration.callback;
}

describe('registerSdsioConfigCommands', () => {
    let tmpDir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        commandMockState.registeredDisposables.length = 0;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsio-config-commands-'));
        (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined }).workspaceFolders = undefined;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('pushes every command registration into the extension context subscriptions', () => {
        const { context } = registerCommands();

        expect(commandMockState.registerCommandMock.mock.calls.map(([command]) => command)).toEqual([
            'arm-sds.sds.newConfig',
            'arm-sds.sds.openConfig',
            'arm-sds.sds.selectConfig',
            'arm-sds.sds.closeConfig',
            'arm-sds.sds.editConfig',
        ]);
        expect(context.subscriptions).toEqual(commandMockState.registeredDisposables);
    });

    it('creates a new workspace config file and activates it', async () => {
        const { args } = registerCommands();
        (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> }).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
        vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (options: unknown) => {
            const validateInput = (options as { validateInput: (value: string) => string | undefined }).validateInput;
            expect(validateInput('')).toBe('Name cannot be empty.');
            expect(validateInput('a/b')).toBe('Do not include path separators or drive notation.');
            expect(validateInput('target')).toBeUndefined();
            return ' target-a ';
        });

        await getCommand('arm-sds.sds.newConfig')();

        const targetPath = path.join(tmpDir, 'target-a.sdsio.yml');
        expect(fs.readFileSync(targetPath, 'utf-8')).toBe('sdsio:\n  workdir: .\n');
        expect(args.setActiveConfig).toHaveBeenCalledWith(targetPath, true);
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(vscode.Uri.file(targetPath));
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri: vscode.Uri.file(targetPath) });
    });

    it('opens and activates an existing config when creation would overwrite it', async () => {
        const { args } = registerCommands();
        (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> }).workspaceFolders = [{ uri: { fsPath: tmpDir } }];
        const targetPath = path.join(tmpDir, 'existing.sdsio.yml');
        fs.writeFileSync(targetPath, 'already here\n', 'utf-8');
        vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce('existing');

        await getCommand('arm-sds.sds.newConfig')();

        expect(fs.readFileSync(targetPath, 'utf-8')).toBe('already here\n');
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Configuration already exists: existing.sdsio.yml');
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(vscode.Uri.file(targetPath));
        expect(args.setActiveConfig).toHaveBeenCalledWith(targetPath, true);
    });

    it('reports when new config is requested without a workspace folder', async () => {
        registerCommands();

        await getCommand('arm-sds.sds.newConfig')();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Open a workspace folder before creating an SDS configuration.');
        expect(vscode.window.showInputBox).not.toHaveBeenCalled();
    });

    it('opens and activates a selected config already inside the workspace', async () => {
        const { args } = registerCommands();
        const selectedUri = vscode.Uri.file(path.join(tmpDir, 'in-workspace.sdsio.yml'));
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([selectedUri]);
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValueOnce({ uri: { fsPath: tmpDir } } as never);

        await getCommand('arm-sds.sds.openConfig')();

        expect(args.setActiveConfig).toHaveBeenCalledWith(selectedUri.fsPath, true);
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(selectedUri);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri: selectedUri });
        expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('opens the selected config folder when the file is outside the workspace', async () => {
        const { args } = registerCommands();
        const selectedPath = path.join(tmpDir, 'external.sdsio.yml');
        const selectedUri = vscode.Uri.file(selectedPath);
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([selectedUri]);
        vi.mocked(vscode.workspace.getWorkspaceFolder).mockReturnValueOnce(undefined);

        await getCommand('arm-sds.sds.openConfig')();

        expect(args.ensureWorkspaceConfigFile).toHaveBeenCalledWith(tmpDir, 'external.sdsio.yml');
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', vscode.Uri.file(tmpDir), false);
    });

    it('selects a config from the current workspace', async () => {
        const { args } = registerCommands();
        const first = vscode.Uri.file(path.join(tmpDir, 'a.sdsio.yml'));
        const second = vscode.Uri.file(path.join(tmpDir, 'b.sdsio.yml'));
        vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([first, second]);
        vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items: unknown) => {
            return Array.isArray(items) ? items[1] : undefined;
        });

        await getCommand('arm-sds.sds.selectConfig')();

        expect(vscode.window.showQuickPick).toHaveBeenCalledWith([
            { label: 'a.sdsio.yml', description: first.fsPath, uri: first },
            { label: 'b.sdsio.yml', description: second.fsPath, uri: second },
        ], {
            placeHolder: 'Select SDS configuration file',
            matchOnDescription: true,
        });
        expect(args.setActiveConfig).toHaveBeenCalledWith(second.fsPath, true);
    });

    it('reports when no workspace configs are available', async () => {
        registerCommands();
        vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([]);

        await getCommand('arm-sds.sds.selectConfig')();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No .sdsio.yml files found in the current workspace.');
        expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('closes the active config', async () => {
        const { args } = registerCommands();

        await getCommand('arm-sds.sds.closeConfig')();

        expect(args.setActiveConfig).toHaveBeenCalledWith(undefined, true);
    });

    it('edits the active config from the manager or persisted settings', async () => {
        const managerPath = path.join(tmpDir, 'manager.sdsio.yml');
        const settingsPath = path.join(tmpDir, 'settings.sdsio.yml');
        fs.writeFileSync(managerPath, 'manager\n', 'utf-8');
        fs.writeFileSync(settingsPath, 'settings\n', 'utf-8');
        const configManager = { getConfigFile: vi.fn<() => string | undefined>(() => managerPath) };
        const resolveConfigPathFromSettings = vi.fn(() => settingsPath);
        registerCommands({ configManager: configManager as never, resolveConfigPathFromSettings });

        await getCommand('arm-sds.sds.editConfig')();
        configManager.getConfigFile.mockReturnValueOnce(undefined);
        await getCommand('arm-sds.sds.editConfig')();

        expect(vscode.workspace.openTextDocument).toHaveBeenNthCalledWith(1, vscode.Uri.file(managerPath));
        expect(vscode.workspace.openTextDocument).toHaveBeenNthCalledWith(2, vscode.Uri.file(settingsPath));
        expect(resolveConfigPathFromSettings).toHaveBeenCalledTimes(1);
    });

    it('reports when there is no active config to edit', async () => {
        registerCommands();

        await getCommand('arm-sds.sds.editConfig')();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No active SDS configuration file is selected.');
        expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
    });
});
