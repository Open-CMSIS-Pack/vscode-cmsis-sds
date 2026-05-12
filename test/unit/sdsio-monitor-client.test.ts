/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import { HEADER_SIZE, MON_FLAGS, SdsioMonitorClient } from '../../src/recorder/sdsio/sdsIoMonitorClient';

describe('SdsioMonitorClient flag send API', () => {
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
});
