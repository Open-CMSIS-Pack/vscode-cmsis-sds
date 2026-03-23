/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Media Viewer Panel
 *
 * Provides webview-based viewers for image, audio, and video SDS streams.
 * - Image: renders decoded frames with pixel format conversion, zoom, pan
 * - Audio: renders waveform + spectrogram with playback controls
 * - Video: sequential frame browser with play/pause
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
    parseSdsFile,
    parseMetadataFile,
    decodeImageFrameToRGBA,
    decodeAudioBlock,
    SdsMetadata,
    SdsMediaType,
    SDS_METADATA_EXTENSION,
    detectMediaType
} from '../sds';

export class SdsMediaViewerPanel {
    public static readonly viewType = 'arm-sds.mediaViewer';
    private static panels = new Map<string, SdsMediaViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private sdsFilePath: string;
    private metadataPath: string | undefined;
    private mediaType: SdsMediaType;

    public static createOrShow(
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        metadataPath?: string
    ): SdsMediaViewerPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const existing = SdsMediaViewerPanel.panels.get(sdsFilePath);
        if (existing) {
            existing.panel.reveal(column);
            return existing;
        }

        const panel = vscode.window.createWebviewPanel(
            SdsMediaViewerPanel.viewType,
            `Media: ${path.basename(sdsFilePath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        const viewer = new SdsMediaViewerPanel(panel, extensionUri, sdsFilePath, metadataPath);
        SdsMediaViewerPanel.panels.set(sdsFilePath, viewer);
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
        this.metadataPath = metadataPath || this.findMetadataFile(sdsFilePath);
        this.mediaType = 'sensor';

        this.panel.iconPath = new vscode.ThemeIcon('device-camera');
        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Media Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: any): Promise<void> {
        try {
            switch (message.command) {
                case 'refresh':
                    this.update();
                    break;
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Media viewer error: ${err.message}`);
        }
    }

    private update(): void {
        try {
            const parsed = parseSdsFile(this.sdsFilePath);

            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath);
            }

            if (!metadata) {
                this.panel.webview.html = this.getErrorHtml('No metadata (.sds.yml) found. Media viewer requires metadata to decode frames.');
                return;
            }

            this.mediaType = detectMediaType(metadata);
            this.panel.title = `${this.mediaType === 'image' ? '🖼' : this.mediaType === 'audio' ? '🔊' : '🎬'} ${path.basename(this.sdsFilePath)}`;

            const initialState = this.buildInitialState(parsed, metadata);
            this.panel.webview.html = this.getHtml(initialState);
        } catch (err: any) {
            this.panel.webview.html = this.getErrorHtml(err.message);
        }
    }
    private buildInitialState(parsed: any, metadata: SdsMetadata) {
        const base = { fileName: path.basename(this.sdsFilePath) };
        switch (this.mediaType) {
            case 'image': {
                const content = metadata.sds.content;
                const imgMeta = content.find(c => c.image)?.image;
                if (!imgMeta) { return { ...base, error: 'No image metadata found in content.' }; }
                const frames: { timestamp: number; rgbaBase64: string }[] = [];
                const maxFrames = 100;
                const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
                for (let i = 0; i < Math.min(parsed.records.length, maxFrames); i++) {
                    const record = parsed.records[i];
                    try {
                        const rgba = decodeImageFrameToRGBA(record.data, imgMeta.width, imgMeta.height, imgMeta.pixel_format);
                        frames.push({ timestamp: record.timestamp / tickFreq, rgbaBase64: Buffer.from(rgba).toString('base64') });
                    } catch { /* skip */ }
                }
                return {
                    ...base,
                    mediaType: 'image',
                    image: {
                        frames,
                        width: imgMeta.width,
                        height: imgMeta.height,
                        totalFrames: parsed.records.length,
                    },
                };
            }
            case 'audio': {
                const content = metadata.sds.content;
                const audioMeta = content.find(c => c.audio)?.audio;
                if (!audioMeta) { return { ...base, error: 'No audio metadata found in content.' }; }
                const allSamples: number[] = [];
                for (const record of parsed.records) {
                    try {
                        const block = decodeAudioBlock(record.data, audioMeta.sample_rate, audioMeta.bit_depth, audioMeta.audio_channels);
                        allSamples.push(...Array.from(block[0]));
                    } catch { /* skip */ }
                }
                const maxPoints = 20000;
                const step = Math.max(1, Math.floor(allSamples.length / maxPoints));
                const displaySamples: number[] = [];
                for (let i = 0; i < allSamples.length; i += step) { displaySamples.push(allSamples[i]); }
                return {
                    ...base,
                    mediaType: 'audio',
                    audio: {
                        samples: displaySamples,
                        sampleRate: audioMeta.sample_rate,
                        bitDepth: audioMeta.bit_depth,
                        channels: audioMeta.audio_channels,
                        totalSamples: allSamples.length,
                        totalRecords: parsed.records.length,
                    },
                };
            }
            case 'video': {
                const content = metadata.sds.content;
                const vidMeta = content.find(c => c.video)?.video;
                if (!vidMeta) { return { ...base, error: 'No video metadata found in content.' }; }
                const frames: { timestamp: number; rgbaBase64: string }[] = [];
                const maxFrames = 50;
                const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
                for (let i = 0; i < Math.min(parsed.records.length, maxFrames); i++) {
                    const record = parsed.records[i];
                    try {
                        const rgba = decodeImageFrameToRGBA(record.data, vidMeta.width, vidMeta.height, vidMeta.pixel_format);
                        frames.push({ timestamp: record.timestamp / tickFreq, rgbaBase64: Buffer.from(rgba).toString('base64') });
                    } catch { /* skip */ }
                }
                return {
                    ...base,
                    mediaType: 'video',
                    video: {
                        frames,
                        width: vidMeta.width,
                        height: vidMeta.height,
                        fps: vidMeta.fps,
                        totalFrames: parsed.records.length,
                    },
                };
            }
            default:
                return { ...base, error: 'This file contains sensor data. Use the standard SDS Viewer instead.' };
        }
    }

    private getHtml(initialState: any): string {
        const webview = this.panel.webview;
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'mediaViewerWebview.js')
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
    <title>SDS Media Viewer</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__INITIAL_STATE__ = ${stateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private getErrorHtml(message: string): string {
        return this.getHtml({ error: message, fileName: path.basename(this.sdsFilePath) });
    }

    private generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 16; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    private findMetadataFile(sdsPath: string): string | undefined {
        const dir = path.dirname(sdsPath);
        const base = path.basename(sdsPath);
        const match = base.match(/^(.+)\.\d+\.sds$/);
        if (match) {
            const metaPath = path.join(dir, `${match[1]}${SDS_METADATA_EXTENSION}`);
            if (fs.existsSync(metaPath)) {
                return metaPath;
            }
        }
        return undefined;
    }

    private dispose(): void {
        SdsMediaViewerPanel.panels.delete(this.sdsFilePath);
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
