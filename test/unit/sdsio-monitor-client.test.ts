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

import { beforeEach, describe, expect, it, vi } from 'vitest';

const netMockState = vi.hoisted(() => ({
    sockets: [] as Array<{
        destroyed: boolean;
        destroy: ReturnType<typeof vi.fn>;
        emit: (eventName: string, ...args: unknown[]) => boolean;
        on: (eventName: string, listener: (...args: never[]) => void) => unknown;
        removeAllListeners: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
    }>,
    createConnection: vi.fn(),
}));

vi.mock('net', async () => {
    const { EventEmitter } = await vi.importActual<typeof import('events')>('events');

    class FakeSocket extends EventEmitter {
        destroyed = false;

        write = vi.fn();

        destroy = vi.fn(() => {
            this.destroyed = true;
        });

        removeAllListeners = vi.fn((eventName?: string) => {
            EventEmitter.prototype.removeAllListeners.call(this, eventName);
            return this;
        });
    }

    netMockState.createConnection.mockImplementation(() => {
        const socket = new FakeSocket();
        netMockState.sockets.push(socket as never);
        return socket;
    });

    return {
        createConnection: netMockState.createConnection,
    };
});

import {
    HEADER_SIZE,
    MON_CLOSE,
    MON_FLAGS,
    MON_INFO,
    MON_OPEN,
    SdsioMonitorClient,
} from '../../src/recorder/sdsio/sdsIoMonitorClient';

function writeHeader(cmd: number, arg1 = 0, arg2 = 0, arg3 = 0): Buffer {
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(cmd, 0);
    header.writeUInt32LE(arg1 >>> 0, 4);
    header.writeUInt32LE(arg2 >>> 0, 8);
    header.writeUInt32LE(arg3 >>> 0, 12);
    return header;
}

function filePayload(fileName: string): Buffer {
    const encoded = Buffer.from(fileName, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(encoded.length, 0);
    return Buffer.concat([len, encoded]);
}

function fileFrame(cmd: number, fileName: string, mode = 0): Buffer {
    const payload = filePayload(fileName);
    return Buffer.concat([writeHeader(cmd, 0, mode, 0), payload]);
}

describe('SdsioMonitorClient flag send API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        netMockState.sockets.length = 0;
    });

    function connectedClientWithWrite(writeImpl?: (data: Buffer) => void): SdsioMonitorClient {
        const client = new SdsioMonitorClient();
        const write = vi.fn((data: Buffer) => {
            writeImpl?.(data);
        });
        (client as unknown as { socket: { destroyed: boolean; write: (data: Buffer) => void } }).socket = {
            destroyed: false,
            write,
        };
        return client;
    }

    it('sendFlags writes MON_FLAGS header with set and clear masks', () => {
        let written: Buffer | undefined;
        const client = connectedClientWithWrite((data) => {
            written = data;
        });

        const ok = client.sendFlags(0x12, 0x34);

        expect(ok).toBe(true);
        expect(written).toBeDefined();
        expect(written!.length).toBe(HEADER_SIZE);
        expect(written!.readUInt32LE(0)).toBe(MON_FLAGS);
        expect(written!.readUInt32LE(4)).toBe(0x12);
        expect(written!.readUInt32LE(8)).toBe(0x34);
        expect(written!.readUInt32LE(12)).toBe(0);
    });

    it('returns false when sending flags while disconnected', () => {
        const client = new SdsioMonitorClient();
        expect(client.sendFlags(1, 0)).toBe(false);
    });

    it('setFlag sets only one user bit', () => {
        let written: Buffer | undefined;
        const client = connectedClientWithWrite((data) => {
            written = data;
        });

        const ok = client.setFlag(7);

        expect(ok).toBe(true);
        expect(written).toBeDefined();
        expect(written!.readUInt32LE(0)).toBe(MON_FLAGS);
        expect(written!.readUInt32LE(4)).toBe(0x80);
        expect(written!.readUInt32LE(8)).toBe(0);
        expect(written!.readUInt32LE(12)).toBe(0);
    });

    it('clearFlag clears only one user bit', () => {
        let written: Buffer | undefined;
        const client = connectedClientWithWrite((data) => {
            written = data;
        });

        const ok = client.clearFlag(0);

        expect(ok).toBe(true);
        expect(written).toBeDefined();
        expect(written!.readUInt32LE(0)).toBe(MON_FLAGS);
        expect(written!.readUInt32LE(4)).toBe(0);
        expect(written!.readUInt32LE(8)).toBe(0x1);
        expect(written!.readUInt32LE(12)).toBe(0);
    });

    it('setFlag and clearFlag reject out-of-range and non-integer indices', () => {
        const client = connectedClientWithWrite();

        expect(() => client.setFlag(-1)).toThrow(/0\.\.7/);
        expect(() => client.setFlag(8)).toThrow(/0\.\.7/);
        expect(() => client.clearFlag(1.5)).toThrow(/0\.\.7/);
    });

    it('mode helpers and user bit arrays write expected masks', () => {
        const writes: Buffer[] = [];
        const client = connectedClientWithWrite((data) => {
            writes.push(data);
        });

        expect(client.startRecording()).toBe(true);
        expect(client.startPlayback()).toBe(true);
        expect(client.stopRecordingOrPlayback()).toBe(true);
        expect(client.sendUserFlagBits([true, false, 1, 0, true, false, 0, 1])).toBe(true);

        expect(writes[0].readUInt32LE(4)).toBe(0x80000000);
        expect(writes[0].readUInt32LE(8)).toBe(0x20000000);
        expect(writes[1].readUInt32LE(4)).toBe(0xa0000000);
        expect(writes[1].readUInt32LE(8)).toBe(0);
        expect(writes[2].readUInt32LE(4)).toBe(0);
        expect(writes[2].readUInt32LE(8)).toBe(0xa0000000);
        expect(writes[3].readUInt32LE(4)).toBe(0x95);
        expect(writes[3].readUInt32LE(8)).toBe(0x6a);
        expect(() => client.sendUserFlagBits([true])).toThrow('Expected exactly 8 bits, got 1');
    });

    it('emits an error and returns false when socket write throws', () => {
        const client = connectedClientWithWrite(() => {
            throw new Error('write failed');
        });
        const errors: string[] = [];
        client.on('error', (message) => {
            errors.push(message);
        });

        expect(client.sendFlags(1, 2)).toBe(false);

        expect(errors).toEqual(['Failed to send FLAGS: write failed']);
    });
});

describe('SdsioMonitorClient socket lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        netMockState.sockets.length = 0;
    });

    it('starts once, connects using configured host and port, and emits connection events', async () => {
        const client = new SdsioMonitorClient({ host: 'localhost', port: 9000 });
        const events: string[] = [];
        client.on('log', (message) => events.push(message));
        client.on('connected', () => events.push('connected'));

        await client.start();
        await client.start();
        netMockState.sockets[0].emit('connect');

        expect(netMockState.createConnection).toHaveBeenCalledTimes(1);
        expect(netMockState.createConnection).toHaveBeenCalledWith({ host: 'localhost', port: 9000 });
        expect(client.isConnected).toBe(true);
        expect(events).toEqual(['Monitor connected to localhost:9000', 'connected']);
    });

    it('schedules a reconnect after socket errors and close events while running', async () => {
        vi.useFakeTimers();
        try {
            const client = new SdsioMonitorClient({ reconnectDelayMs: 25 });
            const events: string[] = [];
            client.on('error', (message) => events.push(message));
            client.on('log', (message) => events.push(message));
            client.on('disconnected', () => events.push('disconnected'));

            await client.start();
            netMockState.sockets[0].emit('error', new Error('ECONNREFUSED'));
            netMockState.sockets[0].emit('close');

            expect(netMockState.createConnection).toHaveBeenCalledTimes(1);
            expect(events).toEqual([
                'Socket error: ECONNREFUSED',
                'Monitor disconnected',
                'disconnected',
            ]);

            await vi.advanceTimersByTimeAsync(24);
            expect(netMockState.createConnection).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(netMockState.createConnection).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('stop clears reconnect timers, destroys sockets, and prevents reconnects', async () => {
        vi.useFakeTimers();
        try {
            const client = new SdsioMonitorClient({ reconnectDelayMs: 25 });
            await client.start();
            const socket = netMockState.sockets[0];
            socket.emit('close');

            client.stop();
            await vi.advanceTimersByTimeAsync(25);

            expect(netMockState.createConnection).toHaveBeenCalledTimes(1);
            expect(socket.destroy).toHaveBeenCalledTimes(1);
            expect(socket.removeAllListeners).toHaveBeenCalledTimes(1);
            expect(client.isConnected).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cleanup ignores socket destroy failures', async () => {
        const client = new SdsioMonitorClient();
        await client.start();
        const socket = netMockState.sockets[0];
        socket.destroy.mockImplementationOnce(() => {
            throw new Error('destroy failed');
        });

        expect(() => client.stop()).not.toThrow();
        expect(client.isConnected).toBe(false);
    });

    it('does not connect when the internal connect guard sees a stopped client', () => {
        const client = new SdsioMonitorClient();

        (client as unknown as { _connect: () => void })._connect();

        expect(netMockState.createConnection).not.toHaveBeenCalled();
    });

    it('does not schedule reconnects while stopped', () => {
        vi.useFakeTimers();
        try {
            const client = new SdsioMonitorClient({ reconnectDelayMs: 25 });

            (client as unknown as { _scheduleReconnect: () => void })._scheduleReconnect();
            vi.advanceTimersByTime(25);

            expect(netMockState.createConnection).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('SdsioMonitorClient protocol parsing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        netMockState.sockets.length = 0;
    });

    it('accumulates split frames and emits open, close, info, flags, and unknown messages', () => {
        const client = new SdsioMonitorClient();
        const opened: unknown[] = [];
        const closed: string[] = [];
        const infos: unknown[] = [];
        const logs: string[] = [];
        client.on('open', (message) => opened.push(message));
        client.on('close', (fileName) => closed.push(fileName));
        client.on('info', (info) => infos.push(info));
        client.on('log', (message) => logs.push(message));

        const openFrame = fileFrame(MON_OPEN, 'recording.sds', 1);
        const idleOpenFrame = fileFrame(MON_OPEN, 'idle.sds', 0);
        const closeFrame = fileFrame(MON_CLOSE, 'recording.sds');
        const infoFrame = writeHeader(MON_INFO, 0x1234, 0xffffffff, 0);
        const infoFrameWithPayload = Buffer.concat([
            writeHeader(MON_INFO, 0x5, 42, 3),
            Buffer.from('err'),
        ]);
        const flagsFrame = writeHeader(MON_FLAGS, 1, 2, 3);
        const unknownFrame = writeHeader(99);
        const firstChunk = openFrame.subarray(0, HEADER_SIZE + 5);
        const secondChunk = Buffer.concat([
            openFrame.subarray(HEADER_SIZE + 5),
            idleOpenFrame,
            closeFrame,
            infoFrame,
            infoFrameWithPayload,
            flagsFrame,
            unknownFrame,
        ]);

        (client as unknown as { _onData: (data: Buffer) => void })._onData(firstChunk);
        expect(opened).toEqual([]);

        (client as unknown as { _onData: (data: Buffer) => void })._onData(secondChunk);

        expect(opened).toEqual([
            { mode: 1, fileName: 'recording.sds' },
            { mode: 0, fileName: 'idle.sds' },
        ]);
        expect(closed).toEqual(['recording.sds']);
        expect(infos).toEqual([
            { sdsFlags: 0x1234, sdsIdleRate: undefined },
            { sdsFlags: 0x5, sdsIdleRate: 42 },
        ]);
        expect(logs).toEqual(['Unknown monitor message: 6', 'Unknown monitor message: 99']);
    });

    it('ignores malformed open and close payloads', () => {
        const client = new SdsioMonitorClient();
        const opened: unknown[] = [];
        const closed: string[] = [];
        client.on('open', (message) => opened.push(message));
        client.on('close', (fileName) => closed.push(fileName));

        (client as unknown as { _onData: (data: Buffer) => void })._onData(writeHeader(MON_OPEN));
        (client as unknown as { _handleOpen: (header: unknown, payload: Buffer) => void })._handleOpen(
            { arg2: 0 },
            Buffer.from([10, 0, 0, 0, 65])
        );
        (client as unknown as { _handleClose: (payload: Buffer) => void })._handleClose(Buffer.alloc(0));
        (client as unknown as { _handleClose: (payload: Buffer) => void })._handleClose(Buffer.from([10, 0, 0, 0, 65]));

        expect(opened).toEqual([]);
        expect(closed).toEqual([]);
    });

    it('emits frame processing errors from socket data handlers and protects against listener errors', async () => {
        const client = new SdsioMonitorClient();
        const errors: string[] = [];
        client.on('open', () => {
            throw new Error('listener failed');
        });
        client.on('error', (message) => errors.push(message));
        await client.start();
        const socket = netMockState.sockets[0];

        socket.emit('data', fileFrame(MON_OPEN, 'listener.sds'));
        socket.emit('data', undefined);

        expect(errors).toEqual([expect.stringContaining('Frame processing error:')]);
    });
});
