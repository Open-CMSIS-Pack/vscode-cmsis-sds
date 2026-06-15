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

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { diag } from '../diagnostics/sdsDiagnostics';

export interface RegisterWorkspaceCommandsArgs {
    context: vscode.ExtensionContext;
}

export function registerWorkspaceCommands(args: RegisterWorkspaceCommandsArgs): void {
    const { context } = args;

    // Initialize / Open Workspace
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.initWorkspace', async () => {
            try {
                if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
                    const action = await vscode.window.showInformationMessage(
                        'CMSIS SDS needs an open workspace folder to store recordings and data.',
                        'Open Folder',
                        'Create New Folder'
                    );

                    if (action === 'Open Folder') {
                        const uris = await vscode.window.showOpenDialog({
                            canSelectFolders: true,
                            canSelectFiles: false,
                            canSelectMany: false,
                            openLabel: 'Open as SDS Workspace',
                        });
                        if (uris && uris.length > 0) {
                            await vscode.commands.executeCommand('vscode.openFolder', uris[0]);
                        }
                        return;
                    } else if (action === 'Create New Folder') {
                        const parentUri = await vscode.window.showOpenDialog({
                            canSelectFolders: true,
                            canSelectFiles: false,
                            canSelectMany: false,
                            openLabel: 'Select Parent Folder',
                        });
                        if (!parentUri || parentUri.length === 0) { return; }

                        const folderName = await vscode.window.showInputBox({
                            prompt: 'Name for the new SDS project folder',
                            value: 'sds-project',
                            validateInput: (v) => {
                                if (!v || v.trim().length === 0) { return 'Name cannot be empty'; }
                                if (/[/:]/.test(v)) { return 'Invalid characters in name'; }
                                return undefined;
                            },
                        });
                        if (!folderName) { return; }

                        const newFolder = vscode.Uri.joinPath(parentUri[0], folderName.trim());
                        await vscode.workspace.fs.createDirectory(newFolder);
                        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(newFolder, 'sds_recordings'));

                        const readmeContent = Buffer.from([
                            `# ${folderName.trim()}`,
                            '',
                            'SDS (Synchronous Data Stream) workspace created with CMSIS SDS.',
                            '',
                            '## Directory Structure',
                            '',
                            '- `sds_recordings/` — Raw SDS binary recordings and metadata',
                            '',
                            '## Getting Started',
                            '',
                            '1. Capture SDS data using SDSIO tools',
                            '2. View recordings with **CMSIS SDS: Open SDS Viewer**',
                            '3. Export with **CMSIS SDS: Export SDS to CSV**',
                            '',
                            '## Resources',
                            '',
                            '- [SDS Framework](https://arm-software.github.io/SDS-Framework/)',
                            '',
                        ].join('\n'));
                        await vscode.workspace.fs.writeFile(
                            vscode.Uri.joinPath(newFolder, 'README.md'),
                            readmeContent
                        );

                        const gitignoreContent = Buffer.from([
                            '# SDS workspace',
                            '.cmsis-sds',
                            '*.log',
                            '',
                        ].join('\n'));
                        await vscode.workspace.fs.writeFile(
                            vscode.Uri.joinPath(newFolder, '.gitignore'),
                            gitignoreContent
                        );

                        await vscode.commands.executeCommand('vscode.openFolder', newFolder);
                        return;
                    }
                    return;
                }

                // Workspace already open — ensure recordings directory exists
                const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const recordingsDir = path.join(wsRoot, 'sds_recordings');
                if (!fs.existsSync(recordingsDir)) {
                    fs.mkdirSync(recordingsDir, { recursive: true });
                }
            } catch (err) {
                vscode.window.showErrorMessage(`Workspace init failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        })
    );

    // ── Diagnostics Commands ────────────────────────────────────
    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.showDiagnostics', () => {
            diag().show();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.clearDiagnostics', () => {
            diag().clear();
            vscode.window.showInformationMessage('CMSIS SDS diagnostics log cleared.');
        })
    );
}
