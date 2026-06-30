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

type MessageHandler = (message: unknown) => unknown;

type MockWebview = {
    html: string;
    cspSource: string;
    asWebviewUri: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
    messageHandlers: MessageHandler[];
};

type MockPanel = {
    title: string;
    webview: MockWebview;
    iconPath?: unknown;
    reveal: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onDidDispose: ReturnType<typeof vi.fn>;
    triggerDispose: () => void;
};

type SdsRecordLike = {
    timestamp: number;
    dataSize: number;
    data: Buffer;
};

const vscodeMockState = vi.hoisted(() => ({
    activeTextEditor: undefined as { viewColumn?: number } | undefined,
    createdPanels: [] as MockPanel[],
    createWebviewPanelMock: vi.fn(),
    executeCommandMock: vi.fn(async () => undefined),
    showErrorMessageMock: vi.fn(),
}));

const sdsMockState = vi.hoisted(() => ({
    decodeAllRecords: vi.fn(),
    decodeAudioBlock: vi.fn(),
    decodeImageFrameToRGBA: vi.fn(),
    detectMediaType: vi.fn(),
    getSdsFileStats: vi.fn(),
    indexSdsRecords: vi.fn(),
    parseMetadataFile: vi.fn(),
    parseSdsFile: vi.fn(),
}));

const viewerUtilsMockState = vi.hoisted(() => ({
    buildViewerWebviewHtml: vi.fn((options: { title: string; initialState: Record<string, unknown> }) => JSON.stringify({
        title: options.title,
        initialState: options.initialState,
    })),
    registerViewerWebview: vi.fn(() => ({ dispose: vi.fn() })),
    resolveMetadataPathForSdsFile: vi.fn(),
}));

const viewerSettingsMockState = vi.hoisted(() => ({
    decimationPreset: 'accuracy',
    getDecimationPreset: vi.fn(),
}));

vi.mock('vscode', () => {
    class ThemeIcon {
        constructor(public readonly id: string) { }
    }

    class Uri {
        constructor(public readonly fsPath: string) { }

        static file(fsPath: string): Uri {
            return new Uri(fsPath);
        }

        static joinPath(base: Uri, ...segments: string[]): Uri {
            return new Uri([base.fsPath, ...segments].join('/'));
        }
    }

    function createWebview(): MockWebview {
        const webview: MockWebview = {
            html: '',
            cspSource: 'vscode-resource:',
            asWebviewUri: vi.fn((uri: { fsPath: string }) => `webview://${uri.fsPath}`),
            postMessage: vi.fn(async () => true),
            onDidReceiveMessage: vi.fn((handler: MessageHandler) => {
                webview.messageHandlers.push(handler);
                return { dispose: vi.fn() };
            }),
            messageHandlers: [],
        };
        return webview;
    }

    vscodeMockState.createWebviewPanelMock.mockImplementation((_viewType: string, title: string) => {
        const disposeListeners: Array<() => void> = [];
        let didTriggerDispose = false;
        const panel: MockPanel = {
            title,
            webview: createWebview(),
            reveal: vi.fn(),
            dispose: vi.fn(),
            onDidDispose: vi.fn((handler: () => void) => {
                disposeListeners.push(handler);
                return { dispose: vi.fn() };
            }),
            triggerDispose: () => {
                if (didTriggerDispose) {
                    return;
                }
                didTriggerDispose = true;
                for (const listener of [...disposeListeners]) {
                    listener();
                }
            },
        };
        vscodeMockState.createdPanels.push(panel);
        return panel;
    });

    return {
        ThemeIcon,
        Uri,
        ViewColumn: { One: 1 },
        commands: {
            executeCommand: vscodeMockState.executeCommandMock,
        },
        window: {
            get activeTextEditor() {
                return vscodeMockState.activeTextEditor;
            },
            createWebviewPanel: vscodeMockState.createWebviewPanelMock,
            showErrorMessage: vscodeMockState.showErrorMessageMock,
        },
    };
});

vi.mock('../../src/sds', () => ({
    decodeAllRecords: sdsMockState.decodeAllRecords,
    decodeAudioBlock: sdsMockState.decodeAudioBlock,
    decodeImageFrameToRGBA: sdsMockState.decodeImageFrameToRGBA,
    detectMediaType: sdsMockState.detectMediaType,
    getSdsFileStats: sdsMockState.getSdsFileStats,
    indexSdsRecords: sdsMockState.indexSdsRecords,
    parseMetadataFile: sdsMockState.parseMetadataFile,
    parseSdsFile: sdsMockState.parseSdsFile,
    SDS_METADATA_EXTENSION: '.sds.yml',
}));

vi.mock('../../src/viewer/viewerPanelUtils', () => ({
    buildViewerWebviewHtml: viewerUtilsMockState.buildViewerWebviewHtml,
    registerViewerWebview: viewerUtilsMockState.registerViewerWebview,
    resolveMetadataPathForSdsFile: viewerUtilsMockState.resolveMetadataPathForSdsFile,
}));

vi.mock('../../src/viewer/viewerSettings', () => ({
    ViewerSettings: {
        getDecimationPreset: viewerSettingsMockState.getDecimationPreset,
    },
}));

import * as vscode from 'vscode';
import { SdsMediaViewerPanel } from '../../src/viewer/sdsMediaViewerPanel';
import { SdsViewerPanel } from '../../src/viewer/sdsViewerPanel';

function createParsedFile(records: SdsRecordLike[]) {
    return {
        filePath: '',
        records,
        totalDataSize: records.reduce((sum, record) => sum + record.dataSize, 0),
        totalRecords: records.length,
        durationMs: records.length > 1 ? records[records.length - 1].timestamp - records[0].timestamp : 0,
    };
}

function metadataFile(tmpDir: string, name = 'stream.sds.yml'): string {
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, 'sds:\n');
    return filePath;
}

function latestPanel(): MockPanel {
    const panel = vscodeMockState.createdPanels[vscodeMockState.createdPanels.length - 1];
    if (!panel) {
        throw new Error('No webview panel was created');
    }
    return panel;
}

function initialState(panel: MockPanel): Record<string, unknown> {
    return JSON.parse(panel.webview.html).initialState as Record<string, unknown>;
}

async function dispatchMessage(panel: MockPanel, message: unknown): Promise<void> {
    const handler = panel.webview.messageHandlers[panel.webview.messageHandlers.length - 1];
    if (!handler) {
        throw new Error('No webview message handler registered');
    }
    handler(message);
    await Promise.resolve();
    await Promise.resolve();
}

describe('SdsViewerPanel', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-viewer-panel-'));
        vscodeMockState.activeTextEditor = undefined;
        vscodeMockState.createdPanels.length = 0;
        vscodeMockState.createWebviewPanelMock.mockClear();
        vscodeMockState.executeCommandMock.mockClear();
        vscodeMockState.executeCommandMock.mockResolvedValue(undefined);
        vscodeMockState.showErrorMessageMock.mockClear();
        viewerSettingsMockState.decimationPreset = 'accuracy';
        viewerSettingsMockState.getDecimationPreset.mockReset();
        viewerSettingsMockState.getDecimationPreset.mockImplementation(() => viewerSettingsMockState.decimationPreset);
        viewerUtilsMockState.buildViewerWebviewHtml.mockClear();
        viewerUtilsMockState.registerViewerWebview.mockClear();
        viewerUtilsMockState.resolveMetadataPathForSdsFile.mockReset();
        viewerUtilsMockState.resolveMetadataPathForSdsFile.mockReturnValue(undefined);
        sdsMockState.decodeAllRecords.mockReset();
        sdsMockState.getSdsFileStats.mockReset();
        sdsMockState.parseMetadataFile.mockReset();
        sdsMockState.parseSdsFile.mockReset();
        sdsMockState.getSdsFileStats.mockReturnValue({ totalRecords: 0 });
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile([]));
    });

    afterEach(() => {
        for (const panel of [...vscodeMockState.createdPanels]) {
            panel.triggerDispose();
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates a data viewer, decodes metadata-backed samples, and reuses existing panels', () => {
        const sdsPath = path.join(tmpDir, 'stream.0.sds');
        const metaPath = metadataFile(tmpDir);
        const metadata = {
            sds: {
                name: 'stream',
                frequency: 100,
                'tick-frequency': 2000,
                content: [{ value: 'x', type: 'float' }],
            },
        };
        const samples = [
            { timestamp: 0, timeSeconds: 0, values: { x: 1 }, index: 0 },
            { timestamp: 2000, timeSeconds: 1, values: { x: 2 }, index: 1 },
        ];
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile([
            { timestamp: 0, dataSize: 4, data: Buffer.from([1, 2, 3, 4]) },
            { timestamp: 2000, dataSize: 4, data: Buffer.from([5, 6, 7, 8]) },
        ]));
        sdsMockState.parseMetadataFile.mockReturnValue(metadata);
        sdsMockState.decodeAllRecords.mockReturnValue(samples);
        sdsMockState.getSdsFileStats.mockReturnValue({ totalRecords: 2, recordingTimeSeconds: 1 });
        vscodeMockState.activeTextEditor = { viewColumn: 2 };

        const first = SdsViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const second = SdsViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const panel = latestPanel();

        expect(first).toBe(second);
        expect(vscodeMockState.createWebviewPanelMock).toHaveBeenCalledTimes(1);
        expect(panel.reveal).toHaveBeenCalledWith(2);
        expect((panel.iconPath as { id: string }).id).toBe('graph-line');
        expect(sdsMockState.parseMetadataFile).toHaveBeenCalledWith(metaPath);
        expect(sdsMockState.decodeAllRecords).toHaveBeenCalledWith(expect.anything(), metadata);
        expect(viewerUtilsMockState.registerViewerWebview).toHaveBeenCalledWith(panel.webview);
        expect(initialState(panel)).toMatchObject({
            channelNames: ['x'],
            samples,
            stats: { totalRecords: 2, recordingTimeSeconds: 1 },
            metadata,
            domainStart: 0,
            domainEnd: 1,
            fileName: 'stream.0.sds',
            decimationPreset: 'accuracy',
        });
    });

    it('shows record data sizes when no metadata is available', () => {
        const sdsPath = path.join(tmpDir, 'raw.0.sds');
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile([
            { timestamp: 100, dataSize: 2, data: Buffer.from([1, 2]) },
            { timestamp: 200, dataSize: 5, data: Buffer.from([1, 2, 3, 4, 5]) },
        ]));

        SdsViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath);
        const state = initialState(latestPanel());

        expect(state.channelNames).toEqual(['data_size']);
        expect(state.samples).toMatchObject([
            { timestamp: 100, timeSeconds: 0.1, values: { data_size: 2 }, index: 0 },
            { timestamp: 200, timeSeconds: 0.2, values: { data_size: 5 }, index: 1 },
        ]);
        expect(state.domainStart).toBe(0.1);
        expect(state.domainEnd).toBe(0.2);
    });

    it('handles export, refresh, visible range requests, and message errors', async () => {
        const sdsPath = path.join(tmpDir, 'dense.0.sds');
        const metaPath = metadataFile(tmpDir, 'dense.sds.yml');
        const metadata = {
            sds: {
                name: 'dense',
                frequency: 1000,
                content: [{ value: 'x', type: 'float' }],
            },
        };
        const samples = Array.from({ length: 3000 }, (_value, index) => ({
            timestamp: index,
            timeSeconds: index / 1000,
            values: { x: index % 17 },
            index,
        }));
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile([]));
        sdsMockState.parseMetadataFile.mockReturnValue(metadata);
        sdsMockState.decodeAllRecords.mockReturnValue(samples);

        SdsViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const panel = latestPanel();
        const initialParseCount = sdsMockState.parseSdsFile.mock.calls.length;

        await dispatchMessage(panel, { command: 'exportCsv' });
        expect(vscodeMockState.executeCommandMock).toHaveBeenCalledWith('arm-sds.exportCsv', sdsPath);

        await dispatchMessage(panel, { command: 'refresh' });
        expect(sdsMockState.parseSdsFile.mock.calls.length).toBe(initialParseCount + 1);

        await dispatchMessage(panel, {
            command: 'requestVisibleRangeData',
            requestId: 7,
            payload: { rangeStart: 0, rangeEnd: 2.999, plotWidth: 100, quality: 'low' },
        });
        expect(panel.webview.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
            command: 'visibleRangeData',
            requestId: 7,
            payload: expect.objectContaining({
                rangeStart: 0,
                rangeEnd: 2.999,
                quality: 'low',
            }),
        }));
        const visibleRangeCalls = panel.webview.postMessage.mock.calls;
        const posted = visibleRangeCalls[visibleRangeCalls.length - 1][0] as { payload: { samples: unknown[] } };
        expect(posted.payload.samples.length).toBeLessThan(samples.length);

        panel.webview.postMessage.mockImplementationOnce(() => {
            throw new Error('post failed');
        });
        await dispatchMessage(panel, {
            command: 'requestVisibleRangeData',
            payload: { rangeStart: 0, rangeEnd: 1, plotWidth: 100, quality: 'high' },
        });
        expect(vscodeMockState.showErrorMessageMock).toHaveBeenCalledWith('Viewer error: post failed');
    });

    it('renders an error state when loading fails', () => {
        sdsMockState.parseSdsFile.mockImplementation(() => {
            throw new Error('cannot parse');
        });

        SdsViewerPanel.createOrShow(vscode.Uri.file('/extension'), path.join(tmpDir, 'broken.0.sds'));

        expect(initialState(latestPanel())).toEqual({ error: 'cannot parse' });
    });
});

describe('SdsMediaViewerPanel', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-media-panel-'));
        vscodeMockState.activeTextEditor = undefined;
        vscodeMockState.createdPanels.length = 0;
        vscodeMockState.createWebviewPanelMock.mockClear();
        vscodeMockState.showErrorMessageMock.mockClear();
        viewerSettingsMockState.decimationPreset = 'performance';
        viewerSettingsMockState.getDecimationPreset.mockReset();
        viewerSettingsMockState.getDecimationPreset.mockImplementation(() => viewerSettingsMockState.decimationPreset);
        viewerUtilsMockState.buildViewerWebviewHtml.mockClear();
        viewerUtilsMockState.registerViewerWebview.mockClear();
        viewerUtilsMockState.resolveMetadataPathForSdsFile.mockReset();
        viewerUtilsMockState.resolveMetadataPathForSdsFile.mockReturnValue(undefined);
        sdsMockState.decodeAudioBlock.mockReset();
        sdsMockState.decodeImageFrameToRGBA.mockReset();
        sdsMockState.detectMediaType.mockReset();
        sdsMockState.getSdsFileStats.mockReset();
        sdsMockState.indexSdsRecords.mockReset();
        sdsMockState.parseMetadataFile.mockReset();
        sdsMockState.parseSdsFile.mockReset();
        sdsMockState.getSdsFileStats.mockReturnValue({ totalRecords: 0 });
        sdsMockState.indexSdsRecords.mockReturnValue([]);
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile([]));
    });

    afterEach(() => {
        for (const panel of [...vscodeMockState.createdPanels]) {
            panel.triggerDispose();
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('shows an error when media metadata is missing and reuses existing media panels', () => {
        const sdsPath = path.join(tmpDir, 'no-meta.0.sds');
        vscodeMockState.activeTextEditor = { viewColumn: 3 };

        const first = SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath);
        const second = SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath);
        const panel = latestPanel();

        expect(first).toBe(second);
        expect(vscodeMockState.createWebviewPanelMock).toHaveBeenCalledTimes(1);
        expect(panel.reveal).toHaveBeenCalledWith(3);
        expect(initialState(panel)).toMatchObject({
            error: 'No metadata (.sds.yml) found. Media viewer requires metadata to decode frames.',
            fileName: 'no-meta.0.sds',
        });
    });

    it('builds image state and responds with decoded frame windows', async () => {
        const sdsPath = path.join(tmpDir, 'camera.0.sds');
        fs.writeFileSync(sdsPath, Buffer.alloc(64, 9));
        const metaPath = metadataFile(tmpDir, 'camera.sds.yml');
        const metadata = {
            sds: {
                name: 'camera',
                frequency: 30,
                'tick-frequency': 100,
                content: [{ value: 'frame', type: 'uint8_t', image: { pixel_format: 'RAW8', width: 1, height: 1 } }],
            },
        };
        sdsMockState.parseMetadataFile.mockReturnValue(metadata);
        sdsMockState.detectMediaType.mockReturnValue('image');
        sdsMockState.indexSdsRecords.mockReturnValue([
            { timestamp: 0, dataSize: 4, dataOffset: 0 },
            { timestamp: 10, dataSize: 0, dataOffset: 4 },
            { timestamp: 20, dataSize: 4, dataOffset: 8 },
            { timestamp: 30, dataSize: 100, dataOffset: 999 },
        ]);
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile([]));
        sdsMockState.decodeImageFrameToRGBA
            .mockReturnValueOnce(new Uint8Array([1, 2, 3, 4]))
            .mockImplementationOnce(() => {
                throw new Error('decode failed');
            });

        SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const panel = latestPanel();

        expect(panel.title).toBe('SDS Image: camera.0.sds');
        expect((panel.iconPath as { id: string }).id).toBe('device-camera');
        expect(initialState(panel)).toMatchObject({
            mediaType: 'image',
            image: {
                width: 1,
                height: 1,
                totalFrames: 4,
                interval: '30',
                pixelFormat: 'RAW8',
            },
            decimationPreset: 'performance',
        });

        await dispatchMessage(panel, {
            command: 'requestMediaFrameWindow',
            requestId: 1,
            payload: { mediaType: 'sensor', centerIndex: 1, windowSize: 3, quality: 'high' },
        });
        expect(panel.webview.postMessage).not.toHaveBeenCalled();

        await dispatchMessage(panel, {
            command: 'requestMediaFrameWindow',
            requestId: 2,
            payload: { mediaType: 'image', centerIndex: 1, windowSize: 4, quality: 'low' },
        });

        expect(panel.webview.postMessage).toHaveBeenCalledWith({
            command: 'mediaFrameWindowData',
            requestId: 2,
            payload: {
                mediaType: 'image',
                rangeStart: 0,
                rangeEnd: 4,
                quality: 'low',
                frames: [{ timestamp: 0, rgbaBase64: 'AQIDBA==' }],
            },
        });
    });

    it('builds video state and decodes requested video frame windows', async () => {
        const sdsPath = path.join(tmpDir, 'video.0.sds');
        fs.writeFileSync(sdsPath, Buffer.alloc(16, 7));
        const metaPath = metadataFile(tmpDir, 'video.sds.yml');
        const metadata = {
            sds: {
                name: 'video',
                frequency: 24,
                content: [{ value: 'frame', type: 'uint8_t', video: { pixel_format: 'RGB888', width: 2, height: 1, fps: 24, codec: 'raw' } }],
            },
        };
        sdsMockState.parseMetadataFile.mockReturnValue(metadata);
        sdsMockState.detectMediaType.mockReturnValue('video');
        sdsMockState.indexSdsRecords.mockReturnValue([{ timestamp: 1000, dataSize: 4, dataOffset: 0 }]);
        sdsMockState.decodeImageFrameToRGBA.mockReturnValue(new Uint8Array([5, 6, 7, 8]));

        SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const panel = latestPanel();

        expect(panel.title).toBe('SDS Video: video.0.sds');
        expect((panel.iconPath as { id: string }).id).toBe('device-camera-video');
        expect(initialState(panel)).toMatchObject({
            mediaType: 'video',
            video: {
                width: 2,
                height: 1,
                fps: 24,
                totalFrames: 1,
                codec: 'raw',
                pixelFormat: 'RGB888',
            },
        });

        await dispatchMessage(panel, {
            command: 'requestMediaFrameWindow',
            requestId: 3,
            payload: { mediaType: 'video', centerIndex: 0, windowSize: 5 },
        });

        expect(panel.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: 'mediaFrameWindowData',
            requestId: 3,
            payload: expect.objectContaining({
                mediaType: 'video',
                frames: [{ timestamp: 1, rgbaBase64: 'BQYHCA==' }],
            }),
        }));
    });

    it('builds audio state and serves reduced audio windows', async () => {
        const sdsPath = path.join(tmpDir, 'audio.0.sds');
        const metaPath = metadataFile(tmpDir, 'audio.sds.yml');
        const metadata = {
            sds: {
                name: 'audio',
                frequency: 100,
                'tick-frequency': 1000,
                content: [{ value: 'samples', type: 'int16_t', audio: { sample_rate: 1000, bit_depth: 16, audio_channels: 1 } }],
            },
        };
        const records = Array.from({ length: 200 }, (_value, index) => ({
            timestamp: index * 10,
            dataSize: 1,
            data: Buffer.from([index]),
        }));
        records[0].data = Buffer.from([255]);
        sdsMockState.parseMetadataFile.mockReturnValue(metadata);
        sdsMockState.detectMediaType.mockReturnValue('audio');
        sdsMockState.parseSdsFile.mockReturnValue(createParsedFile(records));
        sdsMockState.decodeAudioBlock.mockImplementation((data: Buffer) => {
            if (data[0] === 255) {
                throw new Error('bad audio');
            }
            return [Float32Array.from([data[0] / 100])];
        });

        SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const panel = latestPanel();
        const state = initialState(panel);

        expect(panel.title).toBe('SDS Audio: audio.0.sds');
        expect((panel.iconPath as { id: string }).id).toBe('unmute');
        expect(state).toMatchObject({
            mediaType: 'audio',
            audio: {
                sampleRate: 1000,
                bitDepth: 16,
                channels: 1,
                totalSamples: 199,
                totalRecords: 200,
            },
        });

        await dispatchMessage(panel, {
            command: 'requestMediaAudioWindow',
            requestId: 4,
            payload: { rangeStart: 0, rangeEnd: 2, plotWidth: 20, quality: 'low' },
        });

        const audioWindowCalls = panel.webview.postMessage.mock.calls;
        const posted = audioWindowCalls[audioWindowCalls.length - 1][0] as {
            command: string;
            requestId: number;
            payload: { samples: unknown[]; quality: string; rangeStart: number; rangeEnd: number };
        };
        expect(posted).toMatchObject({
            command: 'mediaAudioWindowData',
            requestId: 4,
            payload: {
                quality: 'low',
            },
        });
        expect(posted.payload.rangeStart).toBeCloseTo(0.01);
        expect(posted.payload.rangeEnd).toBeCloseTo(1.991);
        expect(posted.payload.samples.length).toBeLessThan(199);
    });

    it('shows sensor-data and loading errors for unsupported media flows', async () => {
        const sdsPath = path.join(tmpDir, 'sensor.0.sds');
        const metaPath = metadataFile(tmpDir, 'sensor.sds.yml');
        sdsMockState.parseMetadataFile.mockReturnValue({
            sds: {
                name: 'sensor',
                frequency: 1,
                content: [{ value: 'x', type: 'float' }],
            },
        });
        sdsMockState.detectMediaType.mockReturnValue('sensor');

        SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        expect(initialState(latestPanel())).toMatchObject({
            error: 'This file contains sensor data. Use the standard SDS Viewer instead.',
        });

        sdsMockState.parseMetadataFile.mockImplementation(() => {
            throw new Error('metadata broke');
        });
        SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), path.join(tmpDir, 'broken.0.sds'), undefined, metaPath);
        expect(initialState(latestPanel())).toMatchObject({ error: 'metadata broke' });
    });

    it('reports media message errors from request handlers', async () => {
        const sdsPath = path.join(tmpDir, 'post-error.0.sds');
        fs.writeFileSync(sdsPath, Buffer.alloc(8, 1));
        const metaPath = metadataFile(tmpDir, 'post-error.sds.yml');
        sdsMockState.parseMetadataFile.mockReturnValue({
            sds: {
                name: 'post-error',
                frequency: 1,
                content: [{ value: 'frame', type: 'uint8_t', image: { pixel_format: 'RAW8', width: 1, height: 1 } }],
            },
        });
        sdsMockState.detectMediaType.mockReturnValue('image');
        sdsMockState.indexSdsRecords.mockReturnValue([{ timestamp: 0, dataSize: 1, dataOffset: 0 }]);
        sdsMockState.decodeImageFrameToRGBA.mockReturnValue(new Uint8Array([1, 2, 3, 4]));

        SdsMediaViewerPanel.createOrShow(vscode.Uri.file('/extension'), sdsPath, undefined, metaPath);
        const panel = latestPanel();
        panel.webview.postMessage.mockImplementationOnce(() => {
            throw new Error('media post failed');
        });

        await dispatchMessage(panel, {
            command: 'requestMediaFrameWindow',
            payload: { mediaType: 'image', centerIndex: 0, windowSize: 1 },
        });

        expect(vscodeMockState.showErrorMessageMock).toHaveBeenCalledWith('Media viewer error: media post failed');
    });
});
