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
import { webviewBus } from '../webview/webview-bus';
import { isMessage } from '../webview/guard';
import { SDS_FILE_MATCHER } from '../webview/utilities';
import type { SdsioConfigManager } from '../controller/sdsioConfigManager';
import { parseSdsBuffer } from '../sds/parser';
import type { SdsParsedFile } from '../sds/types';

export function registerSdsRefresh(filePath: string, onChange: (reset: boolean) => void): vscode.Disposable {
    const listener = (current: fs.Stats, previous: fs.Stats) => {
        if (!current.nlink || (current.size === previous.size && current.mtimeMs === previous.mtimeMs)) { return; }
        const reset = !previous.nlink || current.ino !== previous.ino || current.birthtimeMs !== previous.birthtimeMs
            || current.size <= previous.size;
        onChange(reset);
    };
    fs.watchFile(filePath, { interval: 500, persistent: false }, listener);
    return new vscode.Disposable(() => fs.unwatchFile(filePath, listener));
}

export function readSdsAppend(filePath: string, previous: SdsParsedFile): SdsParsedFile {
    const offset = previous.totalDataSize + previous.records.length * 8;
    const descriptor = fs.openSync(filePath, 'r');
    try {
        const length = Math.max(0, fs.fstatSync(descriptor).size - offset);
        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
        const appended = parseSdsBuffer(buffer.subarray(0, bytesRead), filePath, { strict: false });
        if (!appended.records.length) { return previous; }
        const records = previous.records.concat(appended.records);
        return {
            filePath, records, totalRecords: records.length,
            totalDataSize: previous.totalDataSize + appended.totalDataSize,
            durationMs: records[records.length - 1].timestamp - records[0].timestamp,
        };
    } finally {
        fs.closeSync(descriptor);
    }
}

/**
 * Resolve the metadata (.sds.yml) file path for a given .sds file.
 * 1. If a SdsioConfigManager is provided and a .sdsio.yml is found via configuration,
 *    search in the configured metadir for the metadata file.
 * 2. Fall back to looking for the metadata file in the same directory as the .sds file.
 *
 * @param sdsPath - Path to the .sds data file
 * @param metadataExtension - File extension for metadata (e.g., '.sds.yml')
 * @param configManager - Optional SdsioConfigManager instance for config-based lookup
 */
export function resolveMetadataPathForSdsFile(
    sdsPath: string,
    metadataExtension: string,
    configManager?: SdsioConfigManager
): string | undefined {
    const base = path.basename(sdsPath);
    const match = base.match(SDS_FILE_MATCHER);
    if (!match) {
        return undefined;
    }

    const streamName = match[1];
    const metadataFilename = `${streamName}${metadataExtension}`;

    // Tier 1: Check configured metadir if configManager is available
    if (configManager) {
        const config = configManager.getConfig();
        const metadir = config.metadir;
        if (metadir) {
            const candidates: string[] = [];
            // If the SDS file lives under the configured workdir, mirror its relative folder structure into metadir.
            if (config.workdir) {
                const relDir = path.relative(config.workdir, path.dirname(sdsPath));
                if (!relDir.startsWith('..') && !path.isAbsolute(relDir)) {
                    candidates.push(path.join(metadir, relDir, metadataFilename));
                }
            }
            // Backward-compatible: metadata directly in metadir
            candidates.push(path.join(metadir, metadataFilename));
            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) {
                    return candidate;
                }
            }
        }
    }

    // Tier 2: Check same directory as the .sds file (backward compatibility)
    const dir = path.dirname(sdsPath);
    const metadataPath = path.join(dir, metadataFilename);
    if (fs.existsSync(metadataPath)) {
        return metadataPath;
    }

    return undefined;
}

export function registerMetadataRefresh(
    panel: vscode.WebviewPanel,
    metadataPath: string | undefined,
    onChange: () => void
): vscode.Disposable {
    const readContents = () => {
        if (!metadataPath || !fs.existsSync(metadataPath)) {
            return undefined;
        }
        return fs.readFileSync(metadataPath, 'utf-8');
    };
    let previousContents = readContents();
    const recheck = () => {
        const contents = readContents();
        if (contents === previousContents) {
            return;
        }
        onChange();
        previousContents = contents;
    };
    const saveSubscription = vscode.workspace.onDidSaveTextDocument(document => {
        if (metadataPath && document.uri.scheme === 'file' && path.relative(metadataPath, document.uri.fsPath) === '') {
            recheck();
        }
    });
    const visibilitySubscription = panel.onDidChangeViewState(event => {
        if (event.webviewPanel.visible) {
            recheck();
        }
    });
    return new vscode.Disposable(() => {
        saveSubscription.dispose();
        visibilitySubscription.dispose();
    });
}

export function generateNonce(length = 16): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

export type ViewerHtmlOptions = {
    webview: vscode.Webview;
    extensionUri: vscode.Uri;
    styleFile: string;
    scriptFile: string;
    title: string;
    initialState: Record<string, unknown>;
};

export function buildViewerWebviewHtml(options: ViewerHtmlOptions): string {
    const { webview, extensionUri, styleFile, scriptFile, title, initialState } = options;

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', styleFile));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', scriptFile));
    const nonce = generateNonce();
    const stateJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource}; connect-src 'self';`;

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__INITIAL_STATE__ = ${stateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function registerViewerWebview(webview: vscode.Webview): vscode.Disposable {
    webviewBus.register(webview);

    const incomingDisposable = webview.onDidReceiveMessage((raw) => {
        if (!isMessage(raw)) {
            return;
        }
        webviewBus.handleIncoming(webview, raw);
    });

    webviewBus.sendInit(webview);

    return new vscode.Disposable(() => {
        incomingDisposable.dispose();
        webviewBus.unregister(webview);
    });
}
