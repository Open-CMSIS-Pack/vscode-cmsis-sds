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

import * as net from 'net';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectSdsioMonitorPort } from '../../src/recorder/sdsio/sdsIoMonitorPort';

vi.mock('net', async () => ({ ...await vi.importActual<typeof import('net')>('net') }));

afterEach(() => vi.restoreAllMocks());

async function listen(server: net.Server, port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '0.0.0.0', port, exclusive: true }, resolve);
    });
    return (server.address() as net.AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
    if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

function fakeProbe(error?: Error, port = 49152) {
    const server = new EventEmitter();
    return Object.assign(server, {
        listen: vi.fn((_options: net.ListenOptions, callback: () => void) => {
            if (error) {
                server.emit('error', error);
            } else {
                callback();
            }
        }),
        address: vi.fn(() => ({ port })),
        close: vi.fn((callback: (error?: Error) => void) => callback()),
    });
}

describe('SDSIO monitor port selection', () => {
    it('keeps an available preferred port and releases the probe for the server', async () => {
        const server = net.createServer();
        try {
            const port = await listen(server);
            await close(server);
            expect(await selectSdsioMonitorPort(port)).toBe(port);
            expect(await listen(server, port)).toBe(port);
        } finally {
            await close(server);
        }
    });

    it('uses a free OS-assigned port when another server owns the preferred port', async () => {
        const occupied = net.createServer();
        const replacement = net.createServer();
        try {
            const preferred = await listen(occupied);
            const selected = await selectSdsioMonitorPort(preferred);
            expect(selected).not.toBe(preferred);
            expect(selected).toBeGreaterThan(0);
            expect(await listen(replacement, selected)).toBe(selected);
            expect(occupied.listening).toBe(true);
        } finally {
            await close(replacement);
            await close(occupied);
        }
    });

    it.each(['EADDRINUSE', 'EACCES'])('falls back for %s and closes the successful probe', async (code) => {
        const preferred = fakeProbe(Object.assign(new Error(code), { code }));
        const fallback = fakeProbe();
        vi.spyOn(net, 'createServer').mockReturnValueOnce(preferred as never).mockReturnValueOnce(fallback as never);

        expect(await selectSdsioMonitorPort(6060)).toBe(49152);
        expect(preferred.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 6060, exclusive: true }, expect.any(Function));
        expect(fallback.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 0, exclusive: true }, expect.any(Function));
        expect(fallback.close).toHaveBeenCalledTimes(1);
    });

    it('propagates unexpected bind errors without falling back', async () => {
        const error = Object.assign(new Error('unavailable'), { code: 'EMFILE' });
        vi.spyOn(net, 'createServer').mockReturnValue(fakeProbe(error) as never);
        await expect(selectSdsioMonitorPort(6060)).rejects.toBe(error);
        expect(net.createServer).toHaveBeenCalledTimes(1);
    });

    it('propagates fallback bind errors', async () => {
        const error = Object.assign(new Error('denied'), { code: 'EACCES' });
        vi.spyOn(net, 'createServer').mockReturnValue(fakeProbe(error) as never);
        await expect(selectSdsioMonitorPort(6060)).rejects.toBe(error);
        expect(net.createServer).toHaveBeenCalledTimes(2);
    });

    it('propagates probe close errors', async () => {
        const error = new Error('close failed');
        const server = fakeProbe();
        server.close.mockImplementation((callback) => callback(error));
        vi.spyOn(net, 'createServer').mockReturnValue(server as never);
        await expect(selectSdsioMonitorPort(6060)).rejects.toBe(error);
    });

    it.each([0, -1, 65536, 6060.5, NaN])('rejects invalid preferred port %s', async (port) => {
        const createServer = vi.spyOn(net, 'createServer');
        await expect(selectSdsioMonitorPort(port)).rejects.toThrow(RangeError);
        expect(createServer).not.toHaveBeenCalled();
    });
});
