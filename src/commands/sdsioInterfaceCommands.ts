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

import * as vscode from 'vscode';

import { SdsIoControlService, SdsIoNotifyEvent } from '../providers/sdsIoControlService';
import { SdsExplorerProvider, SdsTreeItem } from '../providers/sdsExplorerProvider';

export interface RegisterSdsioInterfaceCommandsArgs {
    context: vscode.ExtensionContext;
    sdsIoControlService: SdsIoControlService;
    explorerProvider: SdsExplorerProvider;
    explorerTreeView: vscode.TreeView<SdsTreeItem>;
}

export function registerSdsioInterfaceCommands(args: RegisterSdsioInterfaceCommandsArgs): void {
    const { context, sdsIoControlService, explorerProvider, explorerTreeView } = args;

    const updateSdsIoCommandContext = () => {
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canConnect', sdsIoControlService.canConnect());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canDisconnect', sdsIoControlService.canDisconnect());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canPlay', sdsIoControlService.canPlay());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canRecord', sdsIoControlService.canRecord());
        void vscode.commands.executeCommand('setContext', 'arm-sds.sdsio.canStop', sdsIoControlService.canStop());
    };

    updateSdsIoCommandContext();

    context.subscriptions.push(
        sdsIoControlService.onDidChange((data) => {
            if (data.event === SdsIoNotifyEvent.Mode || data.event === SdsIoNotifyEvent.Connected) {
                updateSdsIoCommandContext();
            }

            if (data.event === SdsIoNotifyEvent.Flags || data.event === SdsIoNotifyEvent.Connected) {
                explorerProvider.refreshFlags();
            }

            if (data.event === SdsIoNotifyEvent.FileUpdate) {
                explorerProvider.refreshFiles();
            }
        })
    );

    context.subscriptions.push(
        explorerTreeView.onDidChangeCheckboxState((changes) => {
            const flagChanges = changes.items.filter(([item]) => item.itemType === 'sdsFlag');
            if (flagChanges.length === 0) {
                return;
            }
            sdsIoControlService.setEnabledByTreeItems(flagChanges);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.connect', async () => {
            await sdsIoControlService.connectServer();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.disconnect', async () => {
            await sdsIoControlService.disconnectServer();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.play', async () => {
            const connected = await sdsIoControlService.connectServer();
            if (!connected) {
                void vscode.window.showWarningMessage('Unable to connect to SDSIO monitor server.');
                return;
            }
            sdsIoControlService.play();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.record', async () => {
            const connected = await sdsIoControlService.connectServer();
            if (!connected) {
                void vscode.window.showWarningMessage('Unable to connect to SDSIO monitor server.');
                return;
            }
            sdsIoControlService.record();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.stop', () => {
            sdsIoControlService.stop();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('arm-sds.sdsinterface.rename', async (item: SdsTreeItem) => {
            await sdsIoControlService.renameFlag(item);
        })
    );
}
