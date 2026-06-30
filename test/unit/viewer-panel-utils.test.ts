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

const vscodeMockState = vi.hoisted(() => ({
    decimationPreset: 'accuracy',
}));

const webviewBusMockState = vi.hoisted(() => ({
    handleIncoming: vi.fn(),
    register: vi.fn(),
    sendInit: vi.fn(),
    unregister: vi.fn(),
}));

vi.mock('vscode', () => {
    class Disposable {
        constructor(private readonly callback: () => void) { }

        dispose(): void {
            this.callback();
        }
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

    return {
        Disposable,
        Uri,
        workspace: {
            getConfiguration: vi.fn(() => ({
                get: vi.fn((_section: string, fallback: string) => vscodeMockState.decimationPreset || fallback),
            })),
        },
    };
});

vi.mock('../../src/webview/webview-bus', () => ({
    webviewBus: webviewBusMockState,
}));

vi.mock('../../src/webview/guard', () => ({
    isMessage: vi.fn(),
}));

import * as vscode from 'vscode';
import { isMessage } from '../../src/webview/guard';
import { ViewerSettings } from '../../src/viewer/viewerSettings';
import {
    buildViewerWebviewHtml,
    generateNonce,
    registerViewerWebview,
    resolveMetadataPathForSdsFile,
} from '../../src/viewer/viewerPanelUtils';

type MockWebview = {
    cspSource: string;
    asWebviewUri: ReturnType<typeof vi.fn>;
    onDidReceiveMessage: ReturnType<typeof vi.fn>;
};

describe('viewerPanelUtils', () => {
    let tmpDir: string;

    beforeEach(() => {
        vi.clearAllMocks();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-utils-'));
        vscodeMockState.decimationPreset = 'accuracy';
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('resolves metadata from mirrored metadir, direct metadir, same directory, and invalid names', () => {
        const workdir = path.join(tmpDir, 'work');
        const metadir = path.join(tmpDir, 'meta');
        const nestedSds = path.join(workdir, 'captures', 'stream.3.sds');
        const mirroredMetadata = path.join(metadir, 'captures', 'stream.sds.yml');
        fs.mkdirSync(path.dirname(mirroredMetadata), { recursive: true });
        fs.writeFileSync(mirroredMetadata, 'sds:\n');

        const configManager = {
            getConfig: () => ({ workdir, metadir }),
        };

        expect(resolveMetadataPathForSdsFile(nestedSds, '.sds.yml', configManager as never)).toBe(mirroredMetadata);

        fs.rmSync(path.join(metadir, 'captures'), { recursive: true, force: true });
        const directMetadata = path.join(metadir, 'stream.sds.yml');
        fs.writeFileSync(directMetadata, 'sds:\n');
        expect(resolveMetadataPathForSdsFile(nestedSds, '.sds.yml', configManager as never)).toBe(directMetadata);

        fs.rmSync(directMetadata);
        const sameDirMetadata = path.join(path.dirname(nestedSds), 'stream.sds.yml');
        fs.mkdirSync(path.dirname(sameDirMetadata), { recursive: true });
        fs.writeFileSync(sameDirMetadata, 'sds:\n');
        expect(resolveMetadataPathForSdsFile(nestedSds, '.sds.yml')).toBe(sameDirMetadata);

        expect(resolveMetadataPathForSdsFile(path.join(tmpDir, 'not-sds.txt'), '.sds.yml')).toBeUndefined();
        expect(resolveMetadataPathForSdsFile(nestedSds, '.sds.yml', { getConfig: () => ({}) } as never)).toBe(sameDirMetadata);
    });

    it('generates nonce values with the requested length and allowed characters', () => {
        const nonce = generateNonce(24);

        expect(nonce).toHaveLength(24);
        expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
    });

    it('builds webview HTML with resource URIs, nonce, CSP, and escaped initial state', () => {
        const webview: MockWebview = {
            cspSource: 'vscode-resource:',
            asWebviewUri: vi.fn((uri: { fsPath: string }) => `webview://${uri.fsPath}`),
            onDidReceiveMessage: vi.fn(),
        };

        const html = buildViewerWebviewHtml({
            webview: webview as never,
            extensionUri: vscode.Uri.file('/extension'),
            styleFile: 'viewer.css',
            scriptFile: 'viewer.js',
            title: 'Viewer',
            initialState: { danger: '</script>', value: 1 },
        });

        expect(webview.asWebviewUri).toHaveBeenCalledTimes(2);
        expect(html).toContain('<title>Viewer</title>');
        expect(html).toContain('webview:///extension/out/viewer.css');
        expect(html).toContain('webview:///extension/out/viewer.js');
        expect(html).toContain('script-src');
        expect(html).toContain('\\u003c/script>');
    });

    it('registers webviews with the bus and forwards only valid messages', () => {
        let messageHandler: ((message: unknown) => void) | undefined;
        const incomingDisposable = { dispose: vi.fn() };
        const webview: MockWebview = {
            cspSource: 'vscode-resource:',
            asWebviewUri: vi.fn(),
            onDidReceiveMessage: vi.fn((handler: (message: unknown) => void) => {
                messageHandler = handler;
                return incomingDisposable;
            }),
        };

        const disposable = registerViewerWebview(webview as never);

        expect(webviewBusMockState.register).toHaveBeenCalledWith(webview);
        expect(webviewBusMockState.sendInit).toHaveBeenCalledWith(webview);

        vi.mocked(isMessage).mockReturnValueOnce(false);
        messageHandler?.({ nope: true });
        expect(webviewBusMockState.handleIncoming).not.toHaveBeenCalled();

        const validMessage = { command: 'refresh' };
        vi.mocked(isMessage).mockReturnValueOnce(true);
        messageHandler?.(validMessage);
        expect(webviewBusMockState.handleIncoming).toHaveBeenCalledWith(webview, validMessage);

        disposable.dispose();
        expect(incomingDisposable.dispose).toHaveBeenCalled();
        expect(webviewBusMockState.unregister).toHaveBeenCalledWith(webview);
    });
});

describe('ViewerSettings', () => {
    beforeEach(() => {
        vscodeMockState.decimationPreset = 'accuracy';
    });

    it('returns performance only for the performance setting', () => {
        vscodeMockState.decimationPreset = 'performance';
        expect(ViewerSettings.getDecimationPreset()).toBe('performance');
    });

    it('falls back to accuracy for unknown settings', () => {
        vscodeMockState.decimationPreset = 'something-else';
        expect(ViewerSettings.getDecimationPreset()).toBe('accuracy');
    });
});
