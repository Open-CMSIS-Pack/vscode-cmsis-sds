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

const diagnosticsMockState = vi.hoisted(() => ({
    diagnostics: {
        clear: vi.fn(),
        show: vi.fn(),
    },
}));

vi.mock('vscode', () => {
    class Uri {
        constructor(public fsPath: string) { }

        static file(fsPath: string): Uri {
            return new Uri(fsPath);
        }

        static joinPath(base: Uri, ...segments: string[]): Uri {
            return new Uri([base.fsPath, ...segments].join('/').replace(/\/+/g, '/'));
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
        },
        workspace: {
            fs: {
                createDirectory: vi.fn(async () => undefined),
                writeFile: vi.fn(async () => undefined),
            },
            workspaceFolders: undefined,
        },
    };
});

vi.mock('../../src/diagnostics/sdsDiagnostics', () => ({
    diag: vi.fn(() => diagnosticsMockState.diagnostics),
}));

import * as vscode from 'vscode';
import { diag } from '../../src/diagnostics/sdsDiagnostics';
import { registerWorkspaceCommands } from '../../src/commands/workspaceCommands';

function createContext() {
    return {
        subscriptions: [] as Array<{ dispose: () => void }>,
    };
}

function registerCommands() {
    const context = createContext();
    registerWorkspaceCommands({ context: context as never });
    return { context };
}

function getCommand(command: string): (...args: unknown[]) => unknown {
    const registration = commandMockState.registeredDisposables.find((disposable) => disposable.command === command);
    if (!registration) {
        throw new Error(`Command was not registered: ${command}`);
    }
    return registration.callback;
}

describe('registerWorkspaceCommands', () => {
    let tmpDir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        commandMockState.registeredDisposables.length = 0;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-commands-'));
        (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined }).workspaceFolders = undefined;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('pushes every command registration into the extension context subscriptions', () => {
        const { context } = registerCommands();

        expect(commandMockState.registerCommandMock.mock.calls.map(([command]) => command)).toEqual([
            'arm-sds.initWorkspace',
            'arm-sds.showDiagnostics',
            'arm-sds.clearDiagnostics',
        ]);
        expect(context.subscriptions).toEqual(commandMockState.registeredDisposables);
    });

    it('opens an existing folder when initializing without a workspace', async () => {
        registerCommands();
        const folderUri = vscode.Uri.file(tmpDir);
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Open Folder' as never);
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([folderUri]);

        await getCommand('arm-sds.initWorkspace')();

        expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Open as SDS Workspace',
        });
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', folderUri);
    });

    it('creates a new folder workspace with starter files', async () => {
        registerCommands();
        const parentUri = vscode.Uri.file(tmpDir);
        vi.mocked(vscode.window.showInformationMessage).mockResolvedValueOnce('Create New Folder' as never);
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([parentUri]);
        vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async (options: unknown) => {
            const validateInput = (options as { validateInput: (value: string) => string | undefined }).validateInput;
            expect(validateInput('')).toBe('Name cannot be empty');
            expect(validateInput('a/b')).toBe('Invalid characters in name');
            expect(validateInput('demo')).toBeUndefined();
            return ' demo-project ';
        });

        await getCommand('arm-sds.initWorkspace')();

        const newFolder = vscode.Uri.joinPath(parentUri, 'demo-project');
        const recordingsFolder = vscode.Uri.joinPath(newFolder, 'sds_recordings');
        const readme = vscode.Uri.joinPath(newFolder, 'README.md');
        const gitignore = vscode.Uri.joinPath(newFolder, '.gitignore');

        expect(vscode.workspace.fs.createDirectory).toHaveBeenNthCalledWith(1, newFolder);
        expect(vscode.workspace.fs.createDirectory).toHaveBeenNthCalledWith(2, recordingsFolder);
        expect(vscode.workspace.fs.writeFile).toHaveBeenNthCalledWith(1, readme, expect.any(Buffer));
        expect(Buffer.from(vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0][1] as Uint8Array).toString('utf-8')).toContain('# demo-project');
        expect(vscode.workspace.fs.writeFile).toHaveBeenNthCalledWith(2, gitignore, expect.any(Buffer));
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('vscode.openFolder', newFolder);
    });

    it('creates the recordings directory when a workspace is already open', async () => {
        registerCommands();
        (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> }).workspaceFolders = [{ uri: { fsPath: tmpDir } }];

        await getCommand('arm-sds.initWorkspace')();

        expect(fs.existsSync(path.join(tmpDir, 'sds_recordings'))).toBe(true);
    });

    it('reports initialization errors', async () => {
        registerCommands();
        const fileAsWorkspace = path.join(tmpDir, 'not-a-directory');
        fs.writeFileSync(fileAsWorkspace, '', 'utf-8');
        (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: { fsPath: string } }> }).workspaceFolders = [{ uri: { fsPath: fileAsWorkspace } }];

        await getCommand('arm-sds.initWorkspace')();

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Workspace init failed:'));
    });

    it('shows and clears diagnostics', () => {
        registerCommands();

        getCommand('arm-sds.showDiagnostics')();
        getCommand('arm-sds.clearDiagnostics')();

        expect(diag).toHaveBeenCalledTimes(2);
        expect(diagnosticsMockState.diagnostics.show).toHaveBeenCalledTimes(1);
        expect(diagnosticsMockState.diagnostics.clear).toHaveBeenCalledTimes(1);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('CMSIS SDS diagnostics log cleared.');
    });
});
