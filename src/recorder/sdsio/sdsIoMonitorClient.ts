/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SDSIO Monitor Client — TCP client to observe and control SDSIO server.
 *
 * Connects to the SDSIO server's monitor port (default 12345) to:
 * - Receive async OPEN/CLOSE/INFO messages
 * - Send FLAGS commands to update sdsFlags
 * - Track server state and flag changes
 *
 * Protocol uses 16-byte little-endian headers with variable payloads.
 */

import { EventEmitter } from 'events';
import * as net from 'net';

// ── Protocol constants ──────────────────────────────────────
export const MON_OPEN = 1;
export const MON_CLOSE = 2;
export const MON_FLAGS = 6;
export const MON_INFO = 7;
export const HEADER_SIZE = 16;

// sdsFlags control bits from SDS-Framework issue #209
const SDS_FLAG_IO_ACTIVE = 0x80000000; // bit 31
const SDS_FLAG_PLAYBACK = 0x20000000;  // bit 29

// ── Types ──────────────────────────────────────────────────

type Bit = 0 | 1 | boolean;

export type SdsioMonitorInfo = {
    sdsFlags: number;
    sdsIdleRate: number | undefined;
    error?: {
        status: number;
        line: number;
        fileName: string;
    };
};

export type SdsioMonitorOpenMessage = {
    mode: 0 | 1;
    fileName: string;
};

interface SdsioMonitorHeader {
    cmd: number;
    arg1: number;
    arg2: number;
    arg3: number;
}

// ── Frame Accumulator ──────────────────────────────────────

/**
 * Accumulates incoming TCP data and returns complete frames.
 * Handles variable-length payloads for OPEN, CLOSE, and INFO messages.
 */
class MonitorFrameAccumulator {
    private buf = Buffer.alloc(0);

    reset(): void {
        this.buf = Buffer.alloc(0);
    }

    push(data: Buffer): { header: SdsioMonitorHeader; payload: Buffer }[] {
        this.buf = Buffer.concat([this.buf, data]);
        const frames: { header: SdsioMonitorHeader; payload: Buffer }[] = [];

        while (this.buf.length >= HEADER_SIZE) {
            const header = this._parseHeader(0);
            const payloadSize = this._getPayloadSize(header);

            if (this.buf.length < HEADER_SIZE + payloadSize) {
                break; // Wait for more data
            }

            const payload = this.buf.subarray(HEADER_SIZE, HEADER_SIZE + payloadSize);
            frames.push({ header, payload });

            this.buf = this.buf.subarray(HEADER_SIZE + payloadSize);
        }

        return frames;
    }

    private _parseHeader(offset: number): SdsioMonitorHeader {
        return {
            cmd: this.buf.readUInt32LE(offset),
            arg1: this.buf.readUInt32LE(offset + 4),
            arg2: this.buf.readUInt32LE(offset + 8),
            arg3: this.buf.readUInt32LE(offset + 12),
        };
    }

    private _getPayloadSize(header: SdsioMonitorHeader): number {
        switch (header.cmd) {
            case MON_FLAGS:
                return 0; // No payload for FLAGS command
            case MON_INFO:
                return header.arg3; // errorLen is in arg3
            case MON_OPEN:
            case MON_CLOSE: {
                // Payload is: filenameLen (u32) + filename
                if (this.buf.length < HEADER_SIZE + 4) {
                    return 0; // Can't determine yet
                }
                const filenameLen = this.buf.readUInt32LE(HEADER_SIZE);
                return 4 + filenameLen;
            }
            default:
                return 0;
        }
    }
}

// ── Monitor Client ─────────────────────────────────────────

/**
 * TCP client for the SDSIO server monitor interface.
 *
 * Events:
 *   'connected'    ()
 *   'disconnected' ()
 *   'info'         (info: SdsioMonitorInfo)
 *   'open'         (msg: SdsioMonitorOpenMessage)
 *   'close'        (fileName: string)
 *   'log'          (message: string)
 *   'error'        (message: string)
 */
export class SdsioMonitorClient extends EventEmitter {
    private host: string;
    private port: number;
    private reconnectDelayMs: number;
    private socket: net.Socket | undefined;
    private accumulator = new MonitorFrameAccumulator();
    private running = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(opts?: { host?: string; port?: number; reconnectDelayMs?: number }) {
        super();
        this.host = opts?.host ?? '127.0.0.1';
        this.port = opts?.port ?? 12345;
        this.reconnectDelayMs = opts?.reconnectDelayMs ?? 2000;
    }

    get isConnected(): boolean {
        return !!this.socket && !this.socket.destroyed;
    }

    async start(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        this._connect();
    }

    stop(): void {
        this.running = false;
        this._cleanup();
    }

    /**
     * Send FLAGS command to update sdsFlags on the server.
     * Returns true if sent successfully, false if not connected.
     */
    sendFlags(setMask: number, clearMask: number): boolean {
        if (!this.isConnected) {
            return false;
        }

        const set = setMask >>> 0;
        const clear = clearMask >>> 0;

        const header = Buffer.alloc(HEADER_SIZE);
        header.writeUInt32LE(MON_FLAGS, 0);
        header.writeUInt32LE(set, 4);
        header.writeUInt32LE(clear, 8);
        header.writeUInt32LE(0, 12);

        try {
            this.socket!.write(header);
            return true;
        } catch (err) {
            this._safeEmit('error', `Failed to send FLAGS: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    }

    /**
     * Start recording mode: set bit31=1 and bit29=0.
     */
    startRecording(): boolean {
        return this.sendFlags(SDS_FLAG_IO_ACTIVE, SDS_FLAG_PLAYBACK);
    }

    /**
     * Start playback mode: set bit31=0 and bit29=1.
     */
    startPlayback(): boolean {
        return this.sendFlags(SDS_FLAG_PLAYBACK, SDS_FLAG_IO_ACTIVE);
    }

    /**
     * Stop I/O: clear both bit31 and bit29.
     */
    stopRecordingOrPlayback(): boolean {
        return this.sendFlags(0, (SDS_FLAG_IO_ACTIVE | SDS_FLAG_PLAYBACK) >>> 0);
    }

    sendUserFlagBits(bits: readonly Bit[]): boolean {
        const { setMask, clearMask } = this.buildMasksFrom8Bits(bits);
        return this.sendFlags(setMask, clearMask);
    }

    // ── Internal ────────────────────────────────────────────

    private _connect(): void {
        if (!this.running) {
            return;
        }

        this.socket = net.createConnection({ host: this.host, port: this.port });
        this.accumulator.reset();

        this.socket.on('connect', () => {
            this._safeEmit('log', `Monitor connected to ${this.host}:${this.port}`);
            this._safeEmit('connected');
        });

        this.socket.on('data', (data: Buffer) => {
            try {
                this._onData(data);
            } catch (err) {
                this._safeEmit('error', `Frame processing error: ${err instanceof Error ? err.message : String(err)}`);
            }
        });

        this.socket.on('error', (err: Error) => {
            this._safeEmit('error', `Socket error: ${err.message}`);
            this._scheduleReconnect();
        });

        this.socket.on('close', () => {
            this._safeEmit('log', 'Monitor disconnected');
            this._safeEmit('disconnected');
            this._scheduleReconnect();
        });
    }

    private _onData(data: Buffer): void {
        const frames = this.accumulator.push(data);

        for (const { header, payload } of frames) {
            switch (header.cmd) {
                case MON_OPEN:
                    this._handleOpen(header, payload);
                    break;
                case MON_CLOSE:
                    this._handleClose(payload);
                    break;
                case MON_INFO:
                    this._handleInfo(header);
                    break;
                default:
                    this._safeEmit('log', `Unknown monitor message: ${header.cmd}`);
            }
        }
    }

    private _handleOpen(header: SdsioMonitorHeader, payload: Buffer): void {
        if (payload.length < 4) {
            return;
        }

        const filenameLen = payload.readUInt32LE(0);
        if (payload.length < 4 + filenameLen) {
            return;
        }

        const fileName = payload.subarray(4, 4 + filenameLen).toString('utf-8');
        const mode = header.arg2 === 0 ? 0 : 1;
        this._safeEmit('open', { mode, fileName } as SdsioMonitorOpenMessage);
    }

    private _handleClose(payload: Buffer): void {
        if (payload.length < 4) {
            return;
        }

        const filenameLen = payload.readUInt32LE(0);
        if (payload.length < 4 + filenameLen) {
            return;
        }

        const fileName = payload.subarray(4, 4 + filenameLen).toString('utf-8');
        this._safeEmit('close', fileName);
    }

    private _handleInfo(header: SdsioMonitorHeader): void {
        const sdsFlags = header.arg1;
        const sdsIdleRate = header.arg2;
        const errorLen = header.arg3;

        const info: SdsioMonitorInfo = {
            sdsFlags,
            sdsIdleRate: sdsIdleRate === 0xffffffff ? undefined : sdsIdleRate,
        };

        // TODO: Parse error data if present
        // For now, just emit the basic info

        this._safeEmit('info', info);
    }

    private _scheduleReconnect(): void {
        if (!this.running) {
            return;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            this._connect();
        }, this.reconnectDelayMs);
    }

    private _cleanup(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }

        if (this.socket && !this.socket.destroyed) {
            try {
                this.socket.destroy();
                this.socket.removeAllListeners();
            } catch { /* ignore */ }
        }

        this.socket = undefined;
        this.accumulator.reset();
    }

    private _safeEmit(event: string, ...args: unknown[]): void {
        try {
            this.emit(event, ...args);
        } catch { /* listener error */ }
    }

    private buildMasksFrom8Bits(bits: readonly Bit[]): { setMask: number; clearMask: number } {
        if (bits.length !== 8) {
            throw new Error(`Expected exactly 8 bits, got ${bits.length}`);
        }

        let setMask = 0;
        let clearMask = 0;

        for (let i = 0; i < 8; i++) {
            const on = bits[i] === 1 || bits[i] === true;
            if (on) {
                setMask |= (1 << i);
            } else {
                clearMask |= (1 << i);
            }
        }

        return { setMask, clearMask };
    }
}
