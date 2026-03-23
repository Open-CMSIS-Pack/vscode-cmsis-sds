/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDS Recorder Panel
 *
 * Webview-based recording interface for capturing SDS data streams.
 * Supports real hardware via serial, socket, or USB (SDSIO protocol),
 * plus a built-in demo signal (multi-channel sinewave) for testing.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SdsRecord, SdsMetadata, SdsRecordingSession, SdsRecorderConfig, SdsioServerConfig, SdsioServerState, SDS_METADATA_EXTENSION } from '../sds/types';
import { writeSdsFile, writeMetadataFile, findNextFileIndex } from '../sds/writer';
import { SdsioServer } from './sdsio';
import { SerialTransport } from './sdsio/serialTransport';
import { WebviewMessage } from '../webview/bridge';

export class SdsRecorderPanel {
    public static readonly viewType = 'arm-sds.recorder';
    private static instance: SdsRecorderPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private disposables: vscode.Disposable[] = [];

    private session: SdsRecordingSession | undefined;
    private recordingTimer: NodeJS.Timeout | undefined;
    private accumulatedRecords: SdsRecord[] = [];
    /** Prevents concurrent start/stop operations */
    private busy = false;
    /** True once the panel has been disposed */
    private disposed = false;

    /** Native SDSIO server for real-hardware recording */
    private sdsioServer: SdsioServer | undefined;
    private outputChannel: vscode.OutputChannel;

    public static createOrShow(extensionUri: vscode.Uri): SdsRecorderPanel {
        if (SdsRecorderPanel.instance) {
            SdsRecorderPanel.instance.panel.reveal();
            return SdsRecorderPanel.instance;
        }

        const panel = vscode.window.createWebviewPanel(
            SdsRecorderPanel.viewType,
            'SDS Recorder',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            }
        );

        SdsRecorderPanel.instance = new SdsRecorderPanel(panel, extensionUri);
        return SdsRecorderPanel.instance;
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this.panel = panel;
        this.extensionUri = extensionUri;

        this.outputChannel = vscode.window.createOutputChannel('SDS Recorder');

        this.panel.iconPath = new vscode.ThemeIcon('record');
        this.panel.webview.html = this.getHtml();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            message => { this.handleMessage(message).catch(err => this.outputChannel.appendLine(`[SDS Recorder] Message error: ${err}`)); },
            null,
            this.disposables
        );
    }

    /** Safe wrapper — silently drops messages if the panel has been disposed. */
    private postMessage(message: WebviewMessage): void {
        if (this.disposed) { return; }
        try {
            this.panel.webview.postMessage(message);
        } catch {
            // Panel may have been disposed between the check and the call
        }
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'startRecording':
                    await this.startRecording(message.config as SdsRecorderConfig);
                    break;
                case 'stopRecording':
                    await this.stopRecording();
                    break;
                case 'getSerialPorts':
                    await this._enumerateSerialPorts();
                    break;
                case 'getServerState':
                    this.postMessage({
                        command: 'serverStateChanged',
                        state: this.sdsioServer?.state ?? 'stopped',
                    });
                    break;
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Recorder error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Public accessor for the recording session (used in testing / wiring) */
    public getSession(): SdsRecordingSession | undefined {
        return this.session;
    }

    private async startRecording(config: SdsRecorderConfig): Promise<void> {
        if (this.busy) {
            vscode.window.showWarningMessage('Recorder is busy — please wait.');
            return;
        }
        this.busy = true;
        try {
            await this._doStartRecording(config);
        } finally {
            this.busy = false;
        }
    }

    private async _doStartRecording(config: SdsRecorderConfig): Promise<void> {
        // Guard against starting while already recording — clean up previous session
        if (this.session) {
            if (this.recordingTimer) {
                clearInterval(this.recordingTimer);
                this.recordingTimer = undefined;
            }
            this.session.isRecording = false;
            if (this.sdsioServer) {
                this.sdsioServer.removeAllListeners();
                this.sdsioServer.stop();
                this.sdsioServer = undefined;
            }
            this.session = undefined;
            this.accumulatedRecords = [];
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('Open a workspace folder first.');
            return;
        }

        const outputDir = path.join(
            workspaceFolders[0].uri.fsPath,
            config.outputDirectory || 'sds_recordings'
        );

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const streamName = config.streamName || 'Recording';
        const fileIndex = findNextFileIndex(outputDir, streamName);
        const outputFile = path.join(outputDir, `${streamName}.${fileIndex}.sds`);

        this.session = {
            id: Date.now().toString(),
            config: {
                mode: config.mode || 'demo',
                serialPort: config.serialPort,
                baudRate: config.baudRate || 115200,
                outputDirectory: outputDir,
                streamName,
            },
            startTime: new Date(),
            recordCount: 0,
            totalBytes: 0,
            isRecording: true,
            outputFile,
        };

        this.accumulatedRecords = [];

        if (config.mode === 'demo') {
            this.startDemoRecording(config);
        } else {
            // Real hardware — launch SDSIO server
            try {
                await this.startHardwareRecording(config);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to start recording: ${err instanceof Error ? err.message : String(err)}`);
                this.session = undefined;
                return;
            }
        }

        this.postMessage({
            command: 'recordingStarted',
            session: {
                ...this.session,
                startTime: this.session.startTime.toISOString(),
            },
            isHardwareMode: config.mode !== 'demo',
        });

        if (config.mode === 'demo') {
            vscode.window.showInformationMessage(`SDS Recording started: ${outputFile}`);
        } else {
            vscode.window.showInformationMessage(`SDS Server started (${config.mode}) — waiting for device...`);
        }
    }

    // ── Hardware recording via native SDSIO server ────────────────

    private async startHardwareRecording(config: SdsRecorderConfig): Promise<void> {
        const workDir = this.session!.config.outputDirectory;
        this.outputChannel.appendLine(`[SDS Recorder] Mode: ${config.mode}`);
        this.outputChannel.appendLine(`[SDS Recorder] Working directory: ${workDir}`);
        this.outputChannel.show(true);

        const serverConfig: SdsioServerConfig = {
            mode: config.mode,
            workDir,
        };

        if (config.mode === 'serial') {
            if (!config.serialPort) { throw new Error('Serial port is required.'); }
            serverConfig.serial = {
                port: config.serialPort,
                baudRate: config.baudRate,
                parity: config.parity,
                stopBits: config.stopBits,
            };
        } else if (config.mode === 'socket') {
            serverConfig.socket = {
                ipAddress: config.ipAddress,
                port: config.tcpPort,
            };
        }

        this.sdsioServer = new SdsioServer(workDir);
        this._wireSdsioServerEvents(this.sdsioServer);

        await this.sdsioServer.start(serverConfig);

        // Periodic status reporter for the webview
        this.recordingTimer = setInterval(() => {
            try {
                if (!this.session?.isRecording) { return; }
                this._sendServerStatus();
            } catch { /* timer error */ }
        }, 1000);
    }

    /** Wire native SDSIO server events to webview messages. */
    private _wireSdsioServerEvents(server: SdsioServer): void {
        server.on('log', (msg: string) => {
            try { this.outputChannel.appendLine(msg); } catch { /* disposed */ }
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'log', message: msg },
            });
        });

        server.on('error', (msg: string) => {
            try { this.outputChannel.appendLine(`ERROR: ${msg}`); } catch { /* disposed */ }
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'error', message: msg },
            });
        });

        server.on('record', (name: string, filePath: string) => {
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'stream-open', message: `Record: ${name} (${filePath})`, streamName: name, filePath },
            });
            this._sendServerStatus();
        });

        server.on('close', (name: string, filePath: string) => {
            this.postMessage({
                command: 'serverEvent',
                event: { type: 'stream-close', message: `Closed: ${name} (${filePath})`, streamName: name, filePath },
            });
            this._sendServerStatus();
        });

        server.on('stateChange', (state: SdsioServerState) => {
            this.postMessage({
                command: 'serverStateChanged',
                state,
            });

            // If server stopped unexpectedly during recording, clean up session
            if (state === 'stopped' && this.session?.isRecording) {
                this.session.isRecording = false;
                this.postMessage({
                    command: 'recordingStopped',
                    recordCount: this.sdsioServer?.fileCount ?? 0,
                    totalBytes: this.sdsioServer?.totalBytes ?? 0,
                    outputFile: this.session.outputFile,
                });
                this.session = undefined;
            }
        });

        server.on('filesChanged', () => {
            this._sendServerStatus();
        });
    }

    private _sendServerStatus(): void {
        if (!this.session || !this.sdsioServer) { return; }
        const elapsed = Date.now() - this.session.startTime.getTime();
        this.session.totalBytes = this.sdsioServer.totalBytes;
        this.session.recordCount = this.sdsioServer.fileCount;

        this.postMessage({
            command: 'recordingStatus',
            recordCount: this.sdsioServer.fileCount,
            totalBytes: this.sdsioServer.totalBytes,
            elapsed,
            streams: Array.from(this.sdsioServer.openStreams.entries()).map(
                ([name, filePath]) => ({ name, filePath })
            ),
            serverState: this.sdsioServer.state,
        });
    }

    // ── Serial port enumeration ─────────────────────────────────

    private async _enumerateSerialPorts(): Promise<void> {
        let ports: string[] = [];

        try {
            ports = await SerialTransport.listPorts();
        } catch (err) {
            this.outputChannel.appendLine(`[SDS Recorder] Port enumeration error: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (ports.length === 0) {
            ports.push('(no ports detected — enter manually)');
        }

        this.postMessage({
            type: 'serialPorts',
            ports,
        });
        this.postMessage({
            command: 'serialPorts',
            ports,
        });
    }

    // ── Demo signal (multi-channel sinewave) ─────────────────────

    /**
     * Generates a multi-channel sinewave demo signal.
     * Each channel uses a slightly different frequency so the traces are visually distinct.
     */
    private startDemoRecording(config: SdsRecorderConfig): void {
        const frequency = config.frequency || 100;
        const channels = config.channels || ['x', 'y', 'z'];
        const intervalMs = Math.max(10, Math.round(1000 / frequency));

        let timestamp = 0;
        let t = 0;

        this.recordingTimer = setInterval(() => {
            try {
                if (!this.session?.isRecording) { return; }

                const frameSize = channels.length * 4; // float32 per channel
                const data = Buffer.alloc(frameSize);

                channels.forEach((ch: string, i: number) => {
                    const freq = 1 + i * 0.5;          // 1 Hz, 1.5 Hz, 2 Hz, …
                    const amplitude = 100 + i * 50;
                    const noise = (Math.random() - 0.5) * 10;
                    const value = amplitude * Math.sin(2 * Math.PI * freq * t) + noise;
                    data.writeFloatLE(value, i * 4);
                });

                const record: SdsRecord = {
                    timestamp,
                    dataSize: frameSize,
                    data,
                };

                this.accumulatedRecords.push(record);
                this.session!.recordCount++;
                this.session!.totalBytes += 8 + frameSize;

                timestamp += intervalMs;
                t += intervalMs / 1000;

                if (this.session!.recordCount % 10 === 0) {
                    this.postMessage({
                        command: 'recordingStatus',
                        recordCount: this.session!.recordCount,
                        totalBytes: this.session!.totalBytes,
                        elapsed: Date.now() - this.session!.startTime.getTime(),
                    });
                }
            } catch { /* timer error */ }
        }, intervalMs);
    }

    /** Write metadata for the demo sinewave recording (only if no file exists yet). */
    private writeDemoMetadata(): void {
        if (!this.session) { return; }
        const metaPath = path.join(
            this.session.config.outputDirectory,
            `${this.session.config.streamName}${SDS_METADATA_EXTENSION}`
        );
        if (fs.existsSync(metaPath)) { return; }
        const metadata: SdsMetadata = {
            sds: {
                name: this.session.config.streamName,
                description: 'Demo sensor data (sinewave)',
                frequency: 100,
                content: [
                    { value: 'x', type: 'float', unit: 'mG' },
                    { value: 'y', type: 'float', unit: 'mG' },
                    { value: 'z', type: 'float', unit: 'mG' },
                ],
            },
        };
        writeMetadataFile(metaPath, metadata);
    }

    private async stopRecording(): Promise<void> {
        if (!this.session) { return; }
        if (this.busy) {
            vscode.window.showWarningMessage('Recorder is busy — please wait.');
            return;
        }
        this.busy = true;
        try {
            await this._doStopRecording();
        } finally {
            this.busy = false;
        }
    }

    private async _doStopRecording(): Promise<void> {
        if (!this.session) { return; }

        const stoppingSession = this.session;
        const stoppingRecords = this.accumulatedRecords;
        const stoppingServer = this.sdsioServer;

        stoppingSession.isRecording = false;

        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = undefined;
        }

        const isDemo = stoppingSession.config.mode === 'demo';

        if (!isDemo && stoppingServer) {
            stoppingServer.stop();
        }

        if (stoppingRecords.length > 0) {
            try {
                writeSdsFile(stoppingSession.outputFile, stoppingRecords);
                if (isDemo) {
                    this.writeDemoMetadata();
                }
                vscode.window.showInformationMessage(
                    `SDS Recording saved: ${path.basename(stoppingSession.outputFile)} ` +
                    `(${stoppingSession.recordCount} records, ${formatBytes(stoppingSession.totalBytes)})`
                );
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to save recording: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else if (!isDemo) {
            const fileCount = stoppingServer?.fileCount ?? 0;
            const totalBytes = stoppingServer?.totalBytes ?? 0;
            if (fileCount > 0) {
                vscode.window.showInformationMessage(
                    `SDS Recording complete: ${fileCount} stream(s), ${formatBytes(totalBytes)}`
                );
            } else {
                vscode.window.showInformationMessage('SDS Recording stopped (no data captured).');
            }
        }

        vscode.commands.executeCommand('arm-sds.refreshExplorer');

        const hwFileCount = stoppingServer?.fileCount ?? 0;
        const hwTotalBytes = stoppingServer?.totalBytes ?? 0;

        this.postMessage({
            command: 'recordingStopped',
            recordCount: isDemo ? stoppingSession.recordCount : hwFileCount,
            totalBytes: isDemo ? stoppingSession.totalBytes : hwTotalBytes,
            outputFile: stoppingSession.outputFile,
        });

        if (this.session === stoppingSession) {
            this.accumulatedRecords = [];
            this.session = undefined;
        }
        if (this.sdsioServer === stoppingServer) {
            this.sdsioServer = undefined;
        }
    }

    private getHtml(): string {
        const webview = this.panel.webview;
        const config = vscode.workspace.getConfiguration('arm-sds.recorder');
        const initialState = {
            defaultPort: config.get<string>('serialPort', ''),
            defaultBaud: config.get<number>('baudRate', 115200),
            defaultDir: config.get<string>('outputDirectory', './sds_recordings'),
        };

        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'out', 'recorderWebview.js')
        );
        const nonce = this._generateNonce();
        const initialStateJson = JSON.stringify(initialState).replace(/</g, '\\u003c');

        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self';`;

        return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SDS Recorder</title>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}">window.__INITIAL_STATE__ = ${initialStateJson};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private _generateNonce(): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < 16; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    private dispose(): void {
        this.disposed = true;

        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = undefined;
        }
        if (this.sdsioServer) {
            this.sdsioServer.removeAllListeners();
            this.sdsioServer.stop();
            this.sdsioServer = undefined;
        }
        this.outputChannel.dispose();
        SdsRecorderPanel.instance = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) { return `${bytes} B`; }
    if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


