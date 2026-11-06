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
    indexSdsRecords,
    parseMetadataFile,
    decodeImageFrameToRGBA,
    decodeAudioBlock,
    SdsMetadata,
    getSdsFileStats,
    SdsMediaType,
    SDS_METADATA_EXTENSION,
    detectMediaType,
    SdsParsedFile,
} from '../sds';
import { ViewerSettings } from './viewerSettings';
import { ImageFrame, SampleFrame, WebviewMessage } from '../webview/protocol';
import {
    buildViewerWebviewHtml,
    registerViewerWebview,
    registerMetadataRefresh,
    registerSdsRefresh,
    readSdsAppend,
    resolveMetadataPathForSdsFile,
} from './viewerPanelUtils';
import type { SdsioConfigManager } from '../controller/sdsioConfigManager';

type MediaFrameWindowRequest = {
    command: 'requestMediaFrameWindow';
    requestId: number;
    payload: {
        mediaType: 'image' | 'video';
        centerIndex: number;
        windowSize: number;
        quality: 'low' | 'high';
    };
};

type MediaAudioWindowRequest = {
    command: 'requestMediaAudioWindow';
    requestId: number;
    payload: {
        rangeStart: number;
        rangeEnd: number;
        plotWidth: number;
        quality: 'low' | 'high';
        purpose?: 'waveform' | 'playback';
    };
};

export class SdsMediaViewerPanel {
    public static readonly viewType = 'arm-sds.mediaViewer';
    private static readonly panels = new Map<string, SdsMediaViewerPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private readonly disposables: vscode.Disposable[] = [];
    private webview: vscode.Webview | undefined;

    private readonly sdsFilePath: string;
    private readonly metadataPath: string | undefined;
    private mediaType: SdsMediaType;
    private parsedFile: SdsParsedFile | undefined;
    private sdsFileStats: ReturnType<typeof getSdsFileStats> | undefined;
    private recordIndex: Array<{ timestamp: number; dataSize: number; dataOffset: number }> = [];
    private metadata: SdsMetadata | undefined;
    private hasViewerState = false;
    private audioFrames: SampleFrame[] = [];
    private audioSampleRate = 0;
    private audioBitDepth = 0;
    private audioChannels = 0;
    private audioDecodedRecords = 0;

    public static createOrShow(
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        configManager?: SdsioConfigManager,
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
            `SDS Media Viewer: ${path.basename(sdsFilePath)}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        const viewer = new SdsMediaViewerPanel(panel, extensionUri, sdsFilePath, configManager, metadataPath);

        SdsMediaViewerPanel.panels.set(sdsFilePath, viewer);
        return viewer;
    }

    public static revive(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        state: unknown,
        configManager?: SdsioConfigManager
    ): void {
        if (!state || typeof state !== 'object' || !('sdsFilePath' in state)
            || typeof state.sdsFilePath !== 'string' || !state.sdsFilePath) {
            panel.dispose();
            return;
        }

        const metadataPath = 'metadataPath' in state && typeof state.metadataPath === 'string'
            ? state.metadataPath
            : undefined;
        const viewer = new SdsMediaViewerPanel(panel, extensionUri, state.sdsFilePath, configManager, metadataPath);
        SdsMediaViewerPanel.panels.set(state.sdsFilePath, viewer);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        sdsFilePath: string,
        configManager?: SdsioConfigManager,
        metadataPath?: string
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.sdsFilePath = sdsFilePath;
        this.metadataPath = metadataPath || resolveMetadataPathForSdsFile(sdsFilePath, SDS_METADATA_EXTENSION, configManager);
        this.mediaType = 'sensor';

        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [extensionUri],
        };
        this.panel.iconPath = new vscode.ThemeIcon('device-camera');
        this.update();
        this.webview = this.panel.webview;
        this.disposables.push(registerViewerWebview(this.webview));
        this.disposables.push(registerMetadataRefresh(this.panel, this.metadataPath, () => this.update(true)));
        this.disposables.push(registerSdsRefresh(this.sdsFilePath, reset => this.update(true, reset)));

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => console.error('[SDS Media Viewer]', err)); },
            null,
            this.disposables
        );
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'refresh':
                    this.update();
                    break;
                case 'requestMediaFrameWindow': {
                    const req = message as unknown as MediaFrameWindowRequest;
                    const requestId = typeof req.requestId === 'number' ? req.requestId : 0;
                    const mediaType = req.payload?.mediaType;
                    if (mediaType !== 'image' && mediaType !== 'video') {
                        break;
                    }
                    const centerIndex = Math.max(0, Math.floor(req.payload?.centerIndex ?? 0));
                    const windowSize = Math.max(1, Math.floor(req.payload?.windowSize ?? 100));
                    const quality = req.payload?.quality === 'low' ? 'low' : 'high';

                    const frameWindow = this.getFrameWindow(mediaType, centerIndex, windowSize);
                    if (!frameWindow) {
                        break;
                    }

                    void this.panel.webview.postMessage({
                        command: 'mediaFrameWindowData',
                        requestId,
                        payload: {
                            mediaType,
                            rangeStart: frameWindow.rangeStart,
                            rangeEnd: frameWindow.rangeEnd,
                            quality,
                            frames: frameWindow.frames,
                        },
                    });
                    break;
                }
                case 'requestMediaAudioWindow': {
                    const req = message as unknown as MediaAudioWindowRequest;
                    const requestId = typeof req.requestId === 'number' ? req.requestId : 0;
                    const rangeStart = typeof req.payload?.rangeStart === 'number' ? req.payload.rangeStart : 0;
                    const rangeEnd = typeof req.payload?.rangeEnd === 'number' ? req.payload.rangeEnd : 0;
                    const plotWidth = typeof req.payload?.plotWidth === 'number' ? req.payload.plotWidth : 800;
                    const quality = req.payload?.quality === 'low' ? 'low' : 'high';

                    const audioWindow = this.getAudioWindow(rangeStart, rangeEnd, plotWidth, quality, req.payload?.purpose === 'playback');
                    if (!audioWindow) {
                        break;
                    }

                    void this.panel.webview.postMessage({
                        command: 'mediaAudioWindowData',
                        requestId,
                        payload: {
                            rangeStart: audioWindow.rangeStart,
                            rangeEnd: audioWindow.rangeEnd,
                            quality,
                            samples: audioWindow.samples,
                        },
                    });
                    break;
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Media viewer error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private update(inPlace = false, fileReset?: boolean): void {
        try {
            let metadata: SdsMetadata | undefined;
            if (this.metadataPath && fs.existsSync(this.metadataPath)) {
                metadata = parseMetadataFile(this.metadataPath, { sdsFilePath: this.sdsFilePath, inferMissingSampleFrequency: true });
            }
            if (!metadata) {
                throw new Error('No metadata (.sds.yml) found. Media viewer requires metadata to decode frames.');
            }

            const previousMetadata = this.metadata;
            const sameMetadata = JSON.stringify(previousMetadata) === JSON.stringify(metadata);
            if (inPlace && this.hasViewerState && sameMetadata && fileReset === undefined) {
                return;
            }
            const frequencyOnly = Boolean(previousMetadata && JSON.stringify({
                ...previousMetadata,
                sds: { ...previousMetadata.sds, 'sample-frequency': metadata.sds['sample-frequency'] },
            }) === JSON.stringify(metadata));
            this.metadata = metadata;
            if (fileReset === undefined && inPlace && this.hasViewerState && frequencyOnly && (this.mediaType === 'image' || this.mediaType === 'video')) {
                void this.panel.webview.postMessage({ command: 'viewerStateChanged', payload: this.buildInitialState(), reset: false });
                return;
            }

            this.mediaType = detectMediaType(metadata);
            const previous = this.parsedFile;
            const append = fileReset === false && sameMetadata && previous !== undefined;
            this.parsedFile = append ? readSdsAppend(this.sdsFilePath, previous) : parseSdsFile(this.sdsFilePath, { strict: false });
            if (append && this.parsedFile === previous) { return; }
            if (!append) {
                this.recordIndex = [];
                if (this.mediaType === 'image' || this.mediaType === 'video') {
                    this.recordIndex = indexSdsRecords(this.sdsFilePath, { strict: false });
                }
            } else if (this.mediaType === 'image' || this.mediaType === 'video') {
                let offset = previous.totalDataSize + previous.records.length * 8;
                for (const record of this.parsedFile.records.slice(previous.records.length)) {
                    this.recordIndex.push({ timestamp: record.timestamp, dataSize: record.dataSize, dataOffset: offset + 8 });
                    offset += 8 + record.dataSize;
                }
            }
            const tickFreq = metadata?.sds['tick-frequency'] ?? 1000;
            this.sdsFileStats = getSdsFileStats(this.parsedFile, tickFreq);

            if (!append) {
                this.audioFrames = [];
                this.audioDecodedRecords = 0;
            }
            this.audioSampleRate = 0;
            this.audioBitDepth = 0;
            this.audioChannels = 0;
            this.panel.title = `${this.mediaType === 'image' ? 'SDS Image' : this.mediaType === 'audio' ? 'SDS Audio' : 'SDS Video'}: ${path.basename(this.sdsFilePath)}`;

            const initialState = this.buildInitialState();
            if (inPlace && this.hasViewerState) {
                void this.panel.webview.postMessage({ command: 'viewerStateChanged', payload: initialState, live: append, reset: !append && (fileReset === true || !frequencyOnly) });
            } else {
                this.panel.webview.html = this.getHtml(initialState);
                this.hasViewerState = true;
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (inPlace && this.hasViewerState) {
                void vscode.window.showErrorMessage(`Media viewer metadata update failed: ${message}`);
            } else {
                this.panel.webview.html = this.getErrorHtml(message);
                this.hasViewerState = false;
            }
        }
    }
    private buildInitialState() {
        const metadata = this.metadata;
        const decimationPreset = ViewerSettings.getDecimationPreset();
        if (!metadata) {
            return { fileName: path.basename(this.sdsFilePath), error: 'Media data not available.' };
        }

        const base = { fileName: path.basename(this.sdsFilePath), decimationPreset };
        switch (this.mediaType) {
            case 'image': {
                this.panel.iconPath = new vscode.ThemeIcon('device-camera');
                const content = metadata.sds.content;
                const imgMeta = content.find(c => c.image)?.image;
                if (!imgMeta) { return { ...base, error: 'No image metadata found in content.' }; }
                return {
                    ...base,
                    mediaType: 'image',
                    image: {
                        frames: [],
                        rangeStart: 0,
                        width: imgMeta.width,
                        height: imgMeta.height,
                        totalFrames: this.recordIndex.length,
                        interval: `${metadata.sds['sample-frequency']}`,
                        fileStats: this.sdsFileStats,
                        pixelFormat: imgMeta.pixel_format,
                    },
                };
            }
            case 'audio': {
                this.panel.iconPath = new vscode.ThemeIcon('unmute');
                const parsed = this.parsedFile;
                if (!parsed) {
                    return { ...base, error: 'Audio data not available.' };
                }
                const content = metadata.sds.content;
                const audioMeta = content.find(c => c.audio)?.audio;
                if (!audioMeta) { return { ...base, error: 'No audio metadata found in content.' }; }
                const sampleRate = metadata.sds['sample-frequency'];
                const frames = this.audioFrames;
                const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
                for (const record of parsed.records.slice(this.audioDecodedRecords)) {
                    try {
                        const block = decodeAudioBlock(record.data, sampleRate, audioMeta['bit-depth'], audioMeta['channels']);
                        frames.push({ timestamp: record.timestamp / tickFreq, samples: Array.from(block[0]) });
                    } catch { /* skip */ }
                }

                this.audioFrames = frames;
                this.audioDecodedRecords = parsed.records.length;
                this.audioSampleRate = sampleRate;
                this.audioBitDepth = audioMeta['bit-depth'];
                this.audioChannels = audioMeta['channels'];

                const totalSamples = frames.reduce((sum, frame) => sum + frame.samples.length, 0);
                const domainStart = frames.length > 0 ? frames[0].timestamp : 0;
                const domainEnd = frames.length > 0
                    ? frames[frames.length - 1].timestamp + (frames[frames.length - 1].samples.length / sampleRate)
                    : 1;
                return {
                    ...base,
                    mediaType: 'audio',
                    audio: {
                        samples: [],
                        rangeStart: domainStart,
                        rangeEnd: domainEnd,
                        domainStart,
                        domainEnd,
                        decimationPreset,
                        sampleRate,
                        bitDepth: audioMeta['bit-depth'],
                        channels: audioMeta['channels'],
                        totalSamples,
                        totalRecords: parsed.records.length,
                        fileStats: this.sdsFileStats,
                    },
                };
            }
            case 'video': {
                this.panel.iconPath = new vscode.ThemeIcon('device-camera-video');
                const content = metadata.sds.content;
                const vidMeta = content.find(c => c.video)?.video;
                if (!vidMeta) { return { ...base, error: 'No video metadata found in content.' }; }
                return {
                    ...base,
                    mediaType: 'video',
                    video: {
                        frames: [],
                        rangeStart: 0,
                        width: vidMeta.width,
                        height: vidMeta.height,
                        fps: vidMeta.fps,
                        totalFrames: this.recordIndex.length,
                        interval: `${metadata.sds['sample-frequency']}`,
                        fileStats: this.sdsFileStats,
                        codec: vidMeta.codec,
                        pixelFormat: vidMeta.pixel_format,
                    },
                };
            }
            default:
                return { ...base, error: 'This file contains sensor data. Use the standard SDS Viewer instead.' };
        }
    }

    private getAudioWindow(rangeStart: number, rangeEnd: number, plotWidth: number, quality: 'low' | 'high', playback = false): { rangeStart: number; rangeEnd: number; samples: SampleFrame[] } | undefined {
        if (this.audioFrames.length === 0 || this.audioSampleRate <= 0) {
            return undefined;
        }

        const domainStart = this.audioFrames[0].timestamp;
        const lastFrame = this.audioFrames[this.audioFrames.length - 1];
        const domainEnd = lastFrame.timestamp + (lastFrame.samples.length / this.audioSampleRate);

        const start = Math.max(domainStart, Math.min(rangeStart, rangeEnd));
        const end = Math.min(domainEnd, Math.max(rangeStart, rangeEnd), playback ? start + 2 : Infinity);
        if (end <= start) {
            return { rangeStart: start, rangeEnd: end, samples: [] };
        }

        const selected: SampleFrame[] = [];
        for (const frame of this.audioFrames) {
            const frameEnd = frame.timestamp + (frame.samples.length / this.audioSampleRate);
            if (frameEnd < start) {
                continue;
            }
            if (frame.timestamp > end) {
                break;
            }
            const first = Math.max(0, Math.ceil((start - frame.timestamp) * this.audioSampleRate - 1e-7));
            const last = Math.min(frame.samples.length, Math.ceil((end - frame.timestamp) * this.audioSampleRate - 1e-7));
            if (last > first) {
                selected.push({
                    timestamp: frame.timestamp + first / this.audioSampleRate,
                    samples: first === 0 && last === frame.samples.length ? frame.samples : frame.samples.slice(first, last)
                });
            }
        }

        const pointCount = selected.reduce((sum, frame) => sum + frame.samples.length, 0);
        const budget = Math.max(80, Math.min(quality === 'low' ? 1200 : 4800, Math.floor(plotWidth * (quality === 'low' ? 0.8 : 2))));
        if (playback || pointCount <= budget) {
            return { rangeStart: start, rangeEnd: end, samples: selected };
        }

        const reduced: SampleFrame[] = [];
        const bucketSize = Math.max(1, Math.ceil(pointCount / Math.floor(budget / 2)));
        let count = 0;
        let minimum: SampleFrame | undefined;
        let maximum: SampleFrame | undefined;
        const flush = () => {
            if (minimum && maximum) {
                reduced.push(...(minimum.timestamp <= maximum.timestamp ? [minimum, maximum] : [maximum, minimum]));
            }
            minimum = maximum = undefined;
        };
        for (const frame of selected) {
            for (let index = 0; index < frame.samples.length; index++) {
                const value = frame.samples[index];
                if (!minimum || value < minimum.samples[0]) {
                    minimum = { timestamp: frame.timestamp + index / this.audioSampleRate, samples: [value] };
                }
                if (!maximum || value > maximum.samples[0]) {
                    maximum = { timestamp: frame.timestamp + index / this.audioSampleRate, samples: [value] };
                }
                if (++count % bucketSize === 0) { flush(); }
            }
        }
        flush();

        return { rangeStart: start, rangeEnd: end, samples: reduced };
    }

    private getFrameWindow(mediaType: 'image' | 'video', centerIndex: number, windowSize: number): { rangeStart: number; rangeEnd: number; frames: ImageFrame[] } | undefined {
        const metadata = this.metadata;
        if (!metadata) {
            return undefined;
        }

        const content = metadata.sds.content;
        const mediaMeta = mediaType === 'image'
            ? content.find(c => c.image)?.image
            : content.find(c => c.video)?.video;
        if (!mediaMeta) {
            return undefined;
        }

        const total = this.recordIndex.length;
        if (total === 0) {
            return { rangeStart: 0, rangeEnd: 0, frames: [] };
        }

        const clampedCenter = Math.max(0, Math.min(total - 1, centerIndex));
        const half = Math.floor(windowSize / 2);
        let start = Math.max(0, clampedCenter - half);
        const endExclusive = Math.min(total, start + windowSize);
        if (endExclusive - start < windowSize) {
            start = Math.max(0, endExclusive - windowSize);
        }

        const tickFreq = metadata.sds['tick-frequency'] ?? 1000;
        const frames: ImageFrame[] = [];
        let fd: number | undefined;
        try {
            fd = fs.openSync(this.sdsFilePath, 'r');
            for (let i = start; i < endExclusive; i++) {
                const entry = this.recordIndex[i];
                if (!entry || entry.dataSize <= 0) {
                    continue;
                }

                const data = Buffer.alloc(entry.dataSize);
                const read = fs.readSync(fd, data, 0, entry.dataSize, entry.dataOffset);
                if (read < entry.dataSize) {
                    continue;
                }

                try {
                    const rgba = decodeImageFrameToRGBA(data, mediaMeta.width, mediaMeta.height, mediaMeta.pixel_format);
                    frames.push({ timestamp: entry.timestamp / tickFreq, rgbaBase64: Buffer.from(rgba).toString('base64') });
                } catch {
                    // Skip decode failures.
                }
            }
        } finally {
            if (fd !== undefined) {
                fs.closeSync(fd);
            }
        }

        return {
            rangeStart: start,
            rangeEnd: endExclusive,
            frames,
        };
    }

    private getHtml(initialState: Record<string, unknown>): string {
        const title = typeof initialState.fileName === 'string'
            ? initialState.fileName
            : 'SDS Media Viewer';

        return buildViewerWebviewHtml({
            webview: this.panel.webview,
            extensionUri: this.extensionUri,
            styleFile: 'mediaViewerWebview.css',
            scriptFile: 'mediaViewerWebview.js',
            title,
            initialState: {
                ...initialState,
                sdsFilePath: this.sdsFilePath,
                metadataPath: this.metadataPath,
            },
        });
    }

    private getErrorHtml(message: string): string {
        return this.getHtml({ error: message, fileName: path.basename(this.sdsFilePath) });
    }

    private dispose(): void {
        SdsMediaViewerPanel.panels.delete(this.sdsFilePath);
        this.webview = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}
