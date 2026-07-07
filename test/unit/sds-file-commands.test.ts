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
            registerCommand: commandMockState.registerCommandMock,
        },
        Uri,
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        window: {
            createTerminal: vi.fn(() => ({
                sendText: vi.fn(),
                show: vi.fn(),
            })),
            showErrorMessage: vi.fn(),
            showInformationMessage: vi.fn(),
            showOpenDialog: vi.fn(),
            showQuickPick: vi.fn(),
            showSaveDialog: vi.fn(),
            showTextDocument: vi.fn(),
            showWarningMessage: vi.fn(),
        },
        workspace: {
            asRelativePath: vi.fn((uri: { fsPath: string }) => uri.fsPath),
            findFiles: vi.fn(async () => []),
            openTextDocument: vi.fn(async (uri: Uri | string) => ({ uri })),
        },
    };
});

vi.mock('../../src/providers/sdsExplorerProvider', () => {
    class SdsTreeItem {
        constructor(public label: string, public itemType: string, public filePath: string) { }
    }

    class SdsExplorerProvider {
        refresh = vi.fn();
        refreshFiles = vi.fn();
    }

    return {
        SdsExplorerProvider,
        SdsTreeItem,
    };
});

vi.mock('../../src/viewer/sdsViewerPanel', () => ({
    SdsViewerPanel: { createOrShow: vi.fn() },
}));

vi.mock('../../src/viewer/sdsMediaViewerPanel', () => ({
    SdsMediaViewerPanel: { createOrShow: vi.fn() },
}));

vi.mock('../../src/sds', () => ({
    decodeAllRecords: vi.fn(),
    exportToCsv: vi.fn(),
    parseMetadataFile: vi.fn(),
    parseSdsFile: vi.fn(),
    SDS_METADATA_EXTENSION: '.sds.yml',
}));

import * as vscode from 'vscode';
import { SdsTreeItem } from '../../src/providers/sdsExplorerProvider';
import { SdsViewerPanel } from '../../src/viewer/sdsViewerPanel';
import { SdsMediaViewerPanel } from '../../src/viewer/sdsMediaViewerPanel';
import {
    decodeAllRecords,
    exportToCsv,
    parseMetadataFile,
    parseSdsFile,
} from '../../src/sds';
import { getCmsisPackRoot, registerSdsFileCommands } from '../../src/commands/sdsFileCommands';

function createContext() {
    return {
        subscriptions: [] as Array<{ dispose: () => void }>,
        extensionUri: vscode.Uri.file('/extension'),
    };
}

function registerCommands() {
    const context = createContext();
    const explorerProvider = {
        refresh: vi.fn(),
        refreshFiles: vi.fn(),
    };
    const configManager = {};

    registerSdsFileCommands({
        context: context as never,
        explorerProvider: explorerProvider as never,
        configManager: configManager as never,
    });

    return { context, explorerProvider, configManager };
}

function getCommand(command: string): (...args: unknown[]) => unknown {
    const registration = commandMockState.registeredDisposables.find((disposable) => disposable.command === command);
    if (!registration) {
        throw new Error(`Command was not registered: ${command}`);
    }
    return registration.callback;
}

function resetVscodeMockDefaults(): void {
    const asRelativePathMock = vi.mocked(vscode.workspace.asRelativePath) as unknown as ReturnType<typeof vi.fn>;
    const openTextDocumentMock = vi.mocked(vscode.workspace.openTextDocument) as unknown as ReturnType<typeof vi.fn>;
    const createTerminalMock = vi.mocked(vscode.window.createTerminal) as unknown as ReturnType<typeof vi.fn>;

    asRelativePathMock.mockReset();
    asRelativePathMock.mockImplementation((pathOrUri: string | { fsPath: string }) => {
        return typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    });
    openTextDocumentMock.mockReset();
    openTextDocumentMock.mockImplementation(async (uri: unknown) => ({ uri }));
    createTerminalMock.mockReset();
    createTerminalMock.mockImplementation(() => ({
        sendText: vi.fn(),
        show: vi.fn(),
    }));
}

describe('registerSdsFileCommands', () => {
    let tmpDir: string;
    const originalCmsisPackRoot = process.env.CMSIS_PACK_ROOT;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(SdsViewerPanel.createOrShow).mockReset();
        vi.mocked(SdsMediaViewerPanel.createOrShow).mockReset();
        resetVscodeMockDefaults();
        vi.mocked(vscode.workspace.findFiles).mockReset();
        vi.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
        vi.mocked(vscode.window.showOpenDialog).mockReset();
        vi.mocked(vscode.window.showQuickPick).mockReset();
        vi.mocked(vscode.window.showSaveDialog).mockReset();
        vi.mocked(vscode.window.showWarningMessage).mockReset();
        commandMockState.registeredDisposables.length = 0;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-file-commands-'));
        if (originalCmsisPackRoot === undefined) {
            delete process.env.CMSIS_PACK_ROOT;
        } else {
            process.env.CMSIS_PACK_ROOT = originalCmsisPackRoot;
        }
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (originalCmsisPackRoot === undefined) {
            delete process.env.CMSIS_PACK_ROOT;
        } else {
            process.env.CMSIS_PACK_ROOT = originalCmsisPackRoot;
        }
    });

    it('pushes every command registration disposable into the extension context subscriptions', () => {
        const { context } = registerCommands();

        const expectedCommands = [
            'arm-sds.openViewer',
            'arm-sds.createMetadata',
            'arm-sds.openGroupMetadata',
            'arm-sds.exportCsv',
            'arm-sds.deleteFile',
            'arm-sds.openMediaViewer',
            'arm-sds.quickOpen',
            'arm-sds.sdsCheck',
        ];

        expect(commandMockState.registerCommandMock).toHaveBeenCalledTimes(expectedCommands.length);
        expect(commandMockState.registerCommandMock.mock.calls.map(([command]) => command)).toEqual(expectedCommands);
        expect(context.subscriptions).toEqual(commandMockState.registeredDisposables);
        expect(context.subscriptions).toHaveLength(expectedCommands.length);
        expect(context.subscriptions.every((subscription) => typeof subscription.dispose === 'function')).toBe(true);
    });

    it('opens the waveform viewer from a tree item or a selected file', async () => {
        const { configManager } = registerCommands();
        const command = getCommand('arm-sds.openViewer');
        const selected = vscode.Uri.file(path.join(tmpDir, 'selected.0.sds'));

        await command({ filePath: path.join(tmpDir, 'tree.0.sds') });
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce([selected]);
        await command();

        expect(SdsViewerPanel.createOrShow).toHaveBeenNthCalledWith(1, vscode.Uri.file('/extension'), path.join(tmpDir, 'tree.0.sds'), configManager);
        expect(SdsViewerPanel.createOrShow).toHaveBeenNthCalledWith(2, vscode.Uri.file('/extension'), selected.fsPath, configManager);
        expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
            canSelectMany: false,
            filters: { 'SDS files': ['sds'] },
            title: 'Select SDS data file',
        });
    });

    it('does not open the waveform viewer when selection is cancelled and reports viewer errors', async () => {
        registerCommands();
        const command = getCommand('arm-sds.openViewer');
        vi.mocked(vscode.window.showOpenDialog).mockResolvedValueOnce(undefined);

        await command({});

        expect(SdsViewerPanel.createOrShow).not.toHaveBeenCalled();

        vi.mocked(SdsViewerPanel.createOrShow).mockImplementationOnce(() => {
            throw new Error('viewer exploded');
        });

        await command(path.join(tmpDir, 'bad.0.sds'));

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to open viewer: viewer exploded');
    });

    it('creates metadata next to an SDS file and opens it', async () => {
        registerCommands();
        const sdsPath = path.join(tmpDir, 'temperature.0.sds');
        const metadataPath = path.join(tmpDir, 'temperature.sds.yml');

        await getCommand('arm-sds.createMetadata')(sdsPath);

        expect(fs.readFileSync(metadataPath, 'utf-8')).toContain('  name: temperature');
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(metadataPath);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri: metadataPath });
    });

    it('creates metadata from file selection and returns when selection is cancelled', async () => {
        registerCommands();
        const selected = vscode.Uri.file(path.join(tmpDir, 'selected.0.sds'));
        const metadataPath = path.join(tmpDir, 'selected.sds.yml');
        const command = getCommand('arm-sds.createMetadata');
        vi.mocked(vscode.window.showOpenDialog)
            .mockResolvedValueOnce([selected])
            .mockResolvedValueOnce(undefined);

        await command();
        await command();

        expect(fs.readFileSync(metadataPath, 'utf-8')).toContain('  name: selected');
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledTimes(1);
        expect(vscode.window.showTextDocument).toHaveBeenCalledTimes(1);
    });

    it('opens existing metadata without overwriting it', async () => {
        registerCommands();
        const sdsPath = path.join(tmpDir, 'camera.0.p.sds');
        const metadataPath = path.join(tmpDir, 'camera.sds.yml');
        fs.writeFileSync(metadataPath, 'existing: true\n', 'utf-8');

        await getCommand('arm-sds.createMetadata')(vscode.Uri.file(sdsPath));

        expect(fs.readFileSync(metadataPath, 'utf-8')).toBe('existing: true\n');
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(metadataPath);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri: metadataPath });
    });

    it('reports invalid metadata paths and write failures', async () => {
        registerCommands();
        const command = getCommand('arm-sds.createMetadata');

        await command(path.join(tmpDir, 'not-an-sds-file.txt'));
        await command(path.join(tmpDir, 'missing-parent', 'broken.0.sds'));

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Could not determine metadata file path.');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to create metadata:'));
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    });

    it('reports missing group metadata and opens an existing metadata item', async () => {
        registerCommands();
        const metadataPath = path.join(tmpDir, 'group.sds.yml');
        const command = getCommand('arm-sds.openGroupMetadata');

        await command({ filePath: metadataPath });
        fs.writeFileSync(metadataPath, 'sds:\n  name: group\n', 'utf-8');
        await command({ filePath: metadataPath });

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Metadata file not found: ${metadataPath}`);
        expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(metadataPath);
        expect(vscode.window.showTextDocument).toHaveBeenCalledWith({ uri: metadataPath });
    });

    it('reports missing group metadata arguments and document open failures', async () => {
        registerCommands();
        const metadataPath = path.join(tmpDir, 'throws.sds.yml');
        fs.writeFileSync(metadataPath, 'sds:\n  name: throws\n', 'utf-8');
        vi.mocked(vscode.workspace.openTextDocument).mockRejectedValueOnce(new Error('document failed'));
        const command = getCommand('arm-sds.openGroupMetadata');

        await command();
        await command(metadataPath);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No metadata file found for this SDS group.');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to open metadata: document failed');
    });

    it('exports CSV when metadata exists and reports the decoded sample count', async () => {
        registerCommands();
        const sdsPath = path.join(tmpDir, 'accel.0.sds');
        const metadataPath = path.join(tmpDir, 'accel.sds.yml');
        const csvPath = path.join(tmpDir, 'accel.csv');
        const metadata = { sds: { content: [{ value: 'x', type: 'float' }] } };
        const parsed = { records: [] };
        const samples = [{ x: 1 }, { x: 2 }];
        fs.writeFileSync(metadataPath, 'sds:\n  name: accel\n', 'utf-8');
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(vscode.Uri.file(csvPath));
        vi.mocked(parseMetadataFile).mockReturnValueOnce(metadata as never);
        vi.mocked(parseSdsFile).mockReturnValueOnce(parsed as never);
        vi.mocked(decodeAllRecords).mockReturnValueOnce(samples as never);

        await getCommand('arm-sds.exportCsv')(sdsPath);

        expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
            defaultUri: vscode.Uri.file(sdsPath.replace(/\.sds$/, '.csv')),
            filters: { 'CSV files': ['csv'] },
            title: 'Export SDS to CSV',
        });
        expect(parseMetadataFile).toHaveBeenCalledWith(metadataPath);
        expect(parseSdsFile).toHaveBeenCalledWith(sdsPath);
        expect(decodeAllRecords).toHaveBeenCalledWith(parsed, metadata);
        expect(exportToCsv).toHaveBeenCalledWith(samples, metadata.sds.content, csvPath, true);
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Exported 2 samples to accel.csv');
    });

    it('exports CSV from file selection and reports selection failures', async () => {
        registerCommands();
        const sdsPath = path.join(tmpDir, 'picked.0.sds');
        fs.writeFileSync(path.join(tmpDir, 'picked.sds.yml'), 'sds:\n  name: picked\n', 'utf-8');
        const command = getCommand('arm-sds.exportCsv');
        vi.mocked(vscode.window.showOpenDialog)
            .mockResolvedValueOnce([vscode.Uri.file(sdsPath)])
            .mockRejectedValueOnce(new Error('dialog failed'));
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(undefined);

        await command();
        await command();

        expect(vscode.window.showSaveDialog).toHaveBeenCalledWith({
            defaultUri: vscode.Uri.file(sdsPath.replace(/\.sds$/, '.csv')),
            filters: { 'CSV files': ['csv'] },
            title: 'Export SDS to CSV',
        });
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Export failed: dialog failed');
    });

    it('does not export CSV without metadata or when save is cancelled', async () => {
        registerCommands();
        const command = getCommand('arm-sds.exportCsv');
        const missingMetadataSds = path.join(tmpDir, 'missing.0.sds');
        const cancelledSds = path.join(tmpDir, 'cancelled.0.sds');
        fs.writeFileSync(path.join(tmpDir, 'cancelled.sds.yml'), 'sds:\n  name: cancelled\n', 'utf-8');
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(undefined);

        await command(missingMetadataSds);
        await command(cancelledSds);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No metadata (.sds.yml) file found. Cannot decode data for CSV export.');
        expect(exportToCsv).not.toHaveBeenCalled();
    });

    it('reports CSV decode/export failures after the destination is selected', async () => {
        registerCommands();
        const sdsPath = path.join(tmpDir, 'throws.0.sds');
        const metadataPath = path.join(tmpDir, 'throws.sds.yml');
        const csvPath = path.join(tmpDir, 'throws.csv');
        fs.writeFileSync(metadataPath, 'sds:\n  name: throws\n', 'utf-8');
        vi.mocked(vscode.window.showSaveDialog).mockResolvedValueOnce(vscode.Uri.file(csvPath));
        vi.mocked(parseMetadataFile).mockImplementationOnce(() => {
            throw new Error('metadata parse failed');
        });

        await getCommand('arm-sds.exportCsv')(sdsPath);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Export failed: metadata parse failed');
    });

    it('deletes a file only after confirmation and refreshes the explorer', async () => {
        const { explorerProvider } = registerCommands();
        const filePath = path.join(tmpDir, 'delete-me.0.sds');
        fs.writeFileSync(filePath, '', 'utf-8');
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Delete' as never);

        await getCommand('arm-sds.deleteFile')({ filePath });

        expect(fs.existsSync(filePath)).toBe(false);
        expect(explorerProvider.refreshFiles).toHaveBeenCalled();
        expect(explorerProvider.refresh).not.toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Deleted delete-me.0.sds');
    });

    it('returns for missing delete items and reports delete failures', async () => {
        const { explorerProvider } = registerCommands();
        const missingPath = path.join(tmpDir, 'missing-delete.0.sds');
        const command = getCommand('arm-sds.deleteFile');
        vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Delete' as never);

        await command(undefined);
        await command({ filePath: missingPath });

        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        expect(explorerProvider.refreshFiles).not.toHaveBeenCalled();
        expect(explorerProvider.refresh).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to delete:'));
    });

    it('opens the media viewer and quick-opens a picked SDS file', async () => {
        const { configManager } = registerCommands();
        const mediaPath = path.join(tmpDir, 'image.0.sds');
        const quickPath = path.join(tmpDir, 'quick.0.sds');
        vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([vscode.Uri.file(quickPath)]);
        vi.mocked(vscode.window.showQuickPick).mockImplementationOnce(async (items: unknown) => {
            return Array.isArray(items) ? items[0] : undefined;
        });

        await getCommand('arm-sds.openMediaViewer')(new SdsTreeItem('image', 'sdsFile', mediaPath, vscode.TreeItemCollapsibleState.None));
        await getCommand('arm-sds.quickOpen')();

        expect(SdsMediaViewerPanel.createOrShow).toHaveBeenCalledWith(vscode.Uri.file('/extension'), mediaPath, configManager);
        expect(SdsViewerPanel.createOrShow).toHaveBeenCalledWith(vscode.Uri.file('/extension'), quickPath, configManager);
    });

    it('opens the media viewer from selection, returns on cancel, and reports viewer errors', async () => {
        const { configManager } = registerCommands();
        const selected = vscode.Uri.file(path.join(tmpDir, 'selected-media.0.sds'));
        const command = getCommand('arm-sds.openMediaViewer');
        vi.mocked(vscode.window.showOpenDialog)
            .mockResolvedValueOnce([selected])
            .mockResolvedValueOnce(undefined);

        await command();
        await command();

        expect(SdsMediaViewerPanel.createOrShow).toHaveBeenCalledWith(vscode.Uri.file('/extension'), selected.fsPath, configManager);
        expect(SdsMediaViewerPanel.createOrShow).toHaveBeenCalledTimes(1);

        vi.mocked(SdsMediaViewerPanel.createOrShow).mockImplementationOnce(() => {
            throw new Error('media exploded');
        });

        await command(path.join(tmpDir, 'bad-media.0.sds'));

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to open media viewer: media exploded');
    });

    it('shows an information message when quick open has no SDS files', async () => {
        registerCommands();
        vi.mocked(vscode.workspace.findFiles).mockResolvedValueOnce([]);

        await getCommand('arm-sds.quickOpen')();

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No SDS files found in workspace.');
        expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    });

    it('returns when quick open is cancelled and reports quick open failures', async () => {
        registerCommands();
        const quickPath = path.join(tmpDir, 'cancelled.0.sds');
        const command = getCommand('arm-sds.quickOpen');
        vi.mocked(vscode.workspace.findFiles)
            .mockResolvedValueOnce([vscode.Uri.file(quickPath)])
            .mockRejectedValueOnce(new Error('find failed'));
        vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

        await command();
        await command();

        expect(SdsViewerPanel.createOrShow).not.toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Quick open failed: find failed');
    });

    it('validates sds-check prerequisites and runs the latest bundled checker', () => {
        registerCommands();
        const command = getCommand('arm-sds.sdsCheck');
        const sdsPath = path.join(tmpDir, 'checked.0.sds');
        fs.writeFileSync(sdsPath, '', 'utf-8');

        command();
        command(path.join(tmpDir, 'missing.0.sds'));

        process.env.CMSIS_PACK_ROOT = path.join(tmpDir, 'does-not-exist');
        command(sdsPath);

        process.env.CMSIS_PACK_ROOT = tmpDir;
        command(sdsPath);

        const packRoot = path.join(tmpDir, 'ARM', 'SDS');
        fs.mkdirSync(packRoot, { recursive: true });
        command(sdsPath);

        fs.mkdirSync(path.join(packRoot, '1.0.0', 'utilities'), { recursive: true });
        const missingCheckerPath = path.join(packRoot, '1.0.0', 'utilities', 'sds-check.py');
        command(sdsPath);

        fs.mkdirSync(path.join(packRoot, '2.0.0', 'utilities'), { recursive: true });
        const checkerPath = path.join(packRoot, '2.0.0', 'utilities', 'sds-check.py');
        fs.writeFileSync(checkerPath, '', 'utf-8');
        const terminal = { sendText: vi.fn(), show: vi.fn() };
        vi.mocked(vscode.window.createTerminal).mockReturnValueOnce(terminal as never);

        command(vscode.Uri.file(sdsPath));

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No SDS file selected for sds-check.');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Selected SDS file does not exist: ${path.join(tmpDir, 'missing.0.sds')}`);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Default pack root doesn\'t exist or CMSIS_PACK_ROOT environment variable is not set. Please set it to the CMSIS Pack root directory.');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`SDS Pack root directory does not exist: ${packRoot}`);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`No version folders found in SDS Pack root: ${packRoot}`);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`sds-check.py not found in SDS Pack: ${missingCheckerPath}`);
        expect(vscode.window.createTerminal).toHaveBeenCalledWith('SDS Check');
        expect(terminal.show).toHaveBeenCalled();
        expect(terminal.sendText).toHaveBeenCalledWith(`python "${checkerPath}" -i "${sdsPath}"`);
    });

    it('resolves CMSIS pack roots from the environment or platform default', () => {
        const defaultSuffix = os.platform() === 'win32' ? path.join('arm', 'packs') : path.join('.cache', 'arm', 'packs');

        expect(getCmsisPackRoot({ CMSIS_PACK_ROOT: '/custom/packs' })).toBe('/custom/packs');
        expect(getCmsisPackRoot({})).toContain(defaultSuffix);
    });
});
