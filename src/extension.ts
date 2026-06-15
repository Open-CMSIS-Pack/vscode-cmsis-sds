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

/**
 * CMSIS SDS — VS Code Extension Entry Point
 *
 * Registers commands, views, providers, and webview panels
 * for the CMSIS SDS extension (viewer, media viewer).
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import { SdsExplorerProvider } from './providers/sdsExplorerProvider';
import { SdsIoControlService } from './providers/sdsIoControlService';
import { SdsioConfigManager } from './controller/sdsioConfigManager';
import { SdsioServerLauncher } from './controller/sdsioServerLauncher';
import { SdsioMonitorClient } from './recorder/sdsio/sdsIoMonitorClient';
import { SdsDiagnostics, DiagnosticSource, diag } from './diagnostics/sdsDiagnostics';
import { registerYamlSchemas } from './config/yamlSchemaRegistrar';
import { setupSdsioConfigLifecycle } from './config/sdsioConfigLifecycle';
import { registerSdsioConfigCommands } from './commands/sdsioConfigCommands';
import { registerSdsioInterfaceCommands } from './commands/sdsioInterfaceCommands';
import { registerSdsFileCommands } from './commands/sdsFileCommands';
import { registerWorkspaceCommands } from './commands/workspaceCommands';

export const SDSIO_SERVER_MONITOR_PORT = 6060;
const SDSIO_CONFIG_EXTENSION = '.sdsio.yml';
const SDSIO_TEMPLATE = [
    'sdsio:',
    '  interface:',
    '    usb:',
    '  workdir: .',
    '  metadir: .',
    '  flag-info:',
    '    - 0: Flag 0',
    '    - 1: Flag 1',
    '    - 2: Flag 2',
    '    - 3: Flag 3',
    '    - 4: Flag 4',
    '    - 5: Flag 5',
    '    - 6: Flag 6',
    '    - 7: Flag 7',
    '',
].join('\n');

let activeSdsIoControlService: SdsIoControlService | undefined;

export function activate(context: vscode.ExtensionContext) {
    // ── Diagnostics Output Channel ──────────────────────────────
    const diagnostics = SdsDiagnostics.getInstance();
    diagnostics.writeBanner();
    diagnostics.info(DiagnosticSource.Extension, 'CMSIS SDS extension activating...');
    context.subscriptions.push(diagnostics.outputChannel);

    configureTerminalPath(context, diagnostics);

    // ── Register YAML Schemas for SDS Metadata/Control Files ───
    void registerYamlSchemas(context);

    // ── SDSIO Monitor Client ────────────────────────────────────
    const monitor = new SdsioMonitorClient({ port: SDSIO_SERVER_MONITOR_PORT });
    context.subscriptions.push({
        dispose: () => {
            monitor.stop();
        },
    });
    // Start monitor in background
    monitor.start().catch((err) => {
        diagnostics.error(DiagnosticSource.Extension, `Failed to start monitor: ${err instanceof Error ? err.message : String(err)}`);
    });

    // ── Config Manager ──────────────────────────────────────────
    const configManager = new SdsioConfigManager();
    context.subscriptions.push({ dispose: () => configManager.dispose() });

    // ── Tree Views ──────────────────────────────────────────────
    const sdsIoControlService = new SdsIoControlService(configManager, monitor, context.extensionPath);
    activeSdsIoControlService = sdsIoControlService;

    const explorerProvider = new SdsExplorerProvider(configManager, sdsIoControlService);
    const explorerTreeView = vscode.window.createTreeView('sdsExplorer', {
        treeDataProvider: explorerProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(explorerTreeView);

    const { setActiveConfig, resolveConfigPathFromSettings } = setupSdsioConfigLifecycle(
        context,
        configManager,
        explorerTreeView,
        SDSIO_CONFIG_EXTENSION
    );

    registerSdsioInterfaceCommands({
        context,
        sdsIoControlService,
        explorerProvider,
        explorerTreeView,
    });

    // ── Commands ────────────────────────────────────────────────

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.refreshExplorer', () => {
            explorerProvider.refresh();
        })
    );

    registerSdsioConfigCommands({
        context,
        configManager,
        configExtension: SDSIO_CONFIG_EXTENSION,
        configTemplate: SDSIO_TEMPLATE,
        setActiveConfig,
        resolveConfigPathFromSettings,
        ensureWorkspaceConfigFile,
    });

    registerSdsFileCommands({
        context,
        explorerProvider,
    });

    registerWorkspaceCommands({
        context,
    });

    // ── Diagnostics Commands (registered via registerWorkspaceCommands) ──

    diagnostics.info(DiagnosticSource.Extension, 'Extension activated successfully');
}

export async function deactivate() {
    diag().info(DiagnosticSource.Extension, 'Extension deactivating...');
    if (activeSdsIoControlService) {
        await activeSdsIoControlService.shutdown('VS Code is closing; terminating SDSIO server gracefully');
        activeSdsIoControlService = undefined;
    }
    SdsDiagnostics.getInstance().dispose();
}

function ensureWorkspaceConfigFile(workspaceRoot: string, configRelativePath: string): void {
    const vscodeDir = path.join(workspaceRoot, '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');

    if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
        } catch {
            settings = {};
        }
    }

    settings['cmsis-sds.sdsio.configFile'] = configRelativePath.replace(/\\/g, '/');
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 4)}\n`, 'utf-8');
}

function configureTerminalPath(context: vscode.ExtensionContext, diagnostics: SdsDiagnostics): void {
    const serverBinary = SdsioServerLauncher.resolveServerBinary(context.extensionPath, diagnostics);
    const collection = context.environmentVariableCollection;
    if (!collection) {
        diagnostics.error(DiagnosticSource.Extension, 'Terminal environment variable collection is not available. PATH will not be modified for SDSIO server terminal.');
        return;
    }
    const pathVariableName = process.platform === 'win32' ? 'Path' : 'PATH';

    collection.description = 'CMSIS SDS terminal environment';
    collection.delete('PATH');
    collection.delete('Path');

    if (!serverBinary) {
        diagnostics.info(DiagnosticSource.Extension, 'No SDSIO server binary found, skipping terminal PATH contribution.');
        return;
    }

    collection.prepend(pathVariableName, `${path.dirname(serverBinary)}${path.delimiter}`);
    diagnostics.info(
        DiagnosticSource.Extension,
        `Prepended ${path.dirname(serverBinary)} to ${pathVariableName} for new integrated terminals.`
    );
}
