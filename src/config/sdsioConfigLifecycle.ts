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

import { SdsioConfigManager } from '../controller/sdsioConfigManager';

export interface SdsioConfigLifecycle {
    setActiveConfig(configPath: string | undefined, persist: boolean): Promise<void>;
    resolveConfigPathFromSettings(): string | undefined;
}

export function setupSdsioConfigLifecycle(
    context: vscode.ExtensionContext,
    configManager: SdsioConfigManager,
    explorerTreeView: vscode.TreeView<unknown>,
    configFileExtension: string
): SdsioConfigLifecycle {
    let isApplyingConfigSetting = false;

    const updateExplorerConfigUi = async (configPath: string | undefined) => {
        await vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.hasConfig', Boolean(configPath));
        explorerTreeView.title = configPath
            ? path.basename(configPath, configFileExtension)
            : 'Files';
    };

    const toWorkspaceRelativeConfigPath = (configUri: vscode.Uri): string => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const owningFolder = vscode.workspace.getWorkspaceFolder(configUri);
        if (!owningFolder) {
            return vscode.workspace.asRelativePath(configUri, true);
        }

        const relativePath = path.relative(owningFolder.uri.fsPath, configUri.fsPath).replace(/\\/g, '/');
        if (folders.length <= 1) {
            return relativePath;
        }

        return `${owningFolder.name}/${relativePath}`;
    };

    const setActiveConfig = async (configPath: string | undefined, persist: boolean) => {
        const normalizedPath = configPath && fs.existsSync(configPath) ? configPath : undefined;
        // One call replaces the config and notifies both providers via onDidChangeConfig.
        configManager.setConfigFile(normalizedPath);
        await updateExplorerConfigUi(normalizedPath);

        if (!persist) {
            return;
        }

        isApplyingConfigSetting = true;
        try {
            const relativePath = normalizedPath
                ? toWorkspaceRelativeConfigPath(vscode.Uri.file(normalizedPath))
                : '';
            await vscode.workspace
                .getConfiguration('cmsis-sds.sdsio')
                .update('configFile', relativePath, vscode.ConfigurationTarget.Workspace);
        } finally {
            isApplyingConfigSetting = false;
        }
    };

    const resolveConfigPathFromSettings = (): string | undefined => {
        const configured = vscode.workspace.getConfiguration('cmsis-sds.sdsio').get<string>('configFile');
        if (!configured) {
            return undefined;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of workspaceFolders) {
            const direct = path.join(folder.uri.fsPath, configured);
            if (fs.existsSync(direct)) {
                return direct;
            }

            const prefix = `${folder.name}${path.sep}`;
            if (configured.startsWith(prefix)) {
                const withoutPrefix = configured.slice(prefix.length);
                const prefixed = path.join(folder.uri.fsPath, withoutPrefix);
                if (fs.existsSync(prefixed)) {
                    return prefixed;
                }
            }
        }

        return undefined;
    };

    void setActiveConfig(resolveConfigPathFromSettings(), false);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (!event.affectsConfiguration('cmsis-sds.sdsio.configFile') || isApplyingConfigSetting) {
                return;
            }

            void setActiveConfig(resolveConfigPathFromSettings(), false);
        })
    );

    return {
        setActiveConfig,
        resolveConfigPathFromSettings,
    };
}
