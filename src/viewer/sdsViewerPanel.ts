/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Viewer Panel
 *
 * Provides a webview-based waveform viewer for SDS data files.
 * Renders interactive time-series charts with zoom and pan,
 * channel toggling, and statistics overlay.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    parseSdsFile,
    decodeAllRecords,
    parseMetadataFile,
    getSdsFileStats,
    SdsMetadata,
    SDS_METADATA_EXTENSION,
    SdsDecodedSample,
} from '../sds';
import { webviewBus } from '../webview/webview-bus';
import { isMessage } from '../webview/guard';
import { WebviewMessage } from '../webview/protocol';

export class SdsViewerPanel {
    public static readonly viewType = 'arm-sds.viewer';
    private static panels = new Map<string, SdsViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private sdsFilePath: string;
    private metadataPath: string | undefined;

    public static createOrShow(
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        metadataPath?: string
    ): SdsViewerPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists for this file, reveal it
        const existing = SdsViewerPanel.panels.get(sdsFilePath);
        if (existing) {
            existing.panel.reveal(column);
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(
            SdsViewerPanel.viewType,
            `SDS Viewer: ${path.basename(sdsFilePath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        const viewer = new SdsViewerPanel(panel, extensionUri, sdsFilePath, metadataPath);
        SdsViewerPanel.panels.set(sdsFilePath, viewer);
        return viewer;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        metadataPath?: string
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.sdsFilePath = sdsFilePath;
        this.metadataPath = metadataPath;

        this.setupWebview(panel.webview);

        this.panel.iconPath = new vscode.ThemeIcon('graph-line');
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'exportCsv':
                    await vscode.commands.executeCommand('arm-sds.exportCsv', this.sdsFilePath);
                    break;
                case 'refresh':
                    this.update();
                    break;
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Viewer error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private update(): void {
        // Find metadata file if not specified
        if (!this.metadataPath) {
            this.metadataPath = this.findMetadataFile(this.sdsFilePath);
        }

        try {
            const parsed = parseSdsFile(this.sdsFilePath);

            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath);
            }
            const tickFreq = metadata?.sds['tick-frequency'] ?? 1000;
            const stats = getSdsFileStats(parsed, tickFreq);

            const samples: SdsDecodedSample[] = [];
            let channelNames: string[] = [];

            if (metadata) {
                const decoded = decodeAllRecords(parsed, metadata);
                channelNames = metadata.sds.content.map(c => c.value);

                // Downsample for performance if too many points
                const maxPoints = 10000;
                const step = Math.max(1, Math.floor(decoded.length / maxPoints));
                for (let i = 0; i < decoded.length; i += step) {
                    samples.push(decoded[i]);
                }
            } else {
                // Without metadata, show raw record sizes over time
                channelNames = ['data_size'];
                for (const record of parsed.records) {
                    samples.push({
                        timestamp: record.timestamp,
                        timeSeconds: record.timestamp / tickFreq,
                        values: { data_size: record.dataSize },
                    } as SdsDecodedSample);
                }
            }

            this.panel.webview.html = this.getHtml({
                samples,
                channelNames,
                stats,
                metadata,
                fileName: path.basename(this.sdsFilePath),
            });
        } catch (err) {
            this.panel.webview.html = this.getErrorHtml(err instanceof Error ? err.message : String(err));
        }
    }

    private findMetadataFile(sdsPath: string): string | undefined {
        const dir = path.dirname(sdsPath);
        const base = path.basename(sdsPath);
        // <name>.<index>.sds -> <name>.sds.yml
        const match = base.match(/^(.+)\.\d+\.sds$/);
        if (match) {
            const metaPath = path.join(dir, `${match[1]}${SDS_METADATA_EXTENSION}`);
            if (fs.existsSync(metaPath)) {
                return metaPath;
            }
        }
        return undefined;
    }
    private getHtml(initialState: Record<string, unknown>): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'viewerWebview.js')
        );
        const nonce = this.generateNonce();
        const stateJson = JSON.stringify(initialState).replace(/</g, '\\u003c');
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self';`;

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SDS Viewer</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__INITIAL_STATE__ = ${stateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        return this.getHtml({ error: message });
    }

    private generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 16; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    private dispose(): void {
        SdsViewerPanel.panels.delete(this.sdsFilePath);
        webviewBus.unregister(this.panel.webview);
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }

    private setupWebview(webview: vscode.Webview) {
        webviewBus.register(webview);

        webview.onDidReceiveMessage((raw) => {
            if (!isMessage(raw)) return;

            webviewBus.handleIncoming(webview, raw);
        });

        webviewBus.sendInit(webview);
    }
}
