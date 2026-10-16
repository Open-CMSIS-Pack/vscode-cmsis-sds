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

export const DEFAULT_SDSIO_MONITOR_PORT = 6060;

export async function selectSdsioMonitorPort(preferredPort: number): Promise<number> {
    if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
        throw new RangeError(`Invalid SDSIO monitor port: ${preferredPort}. Expected an integer from 1 to 65535.`);
    }

    try {
        return await probePort(preferredPort);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' && code !== 'EACCES') {
            throw error;
        }
        return probePort(0);
    }
}

function probePort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
            const address = server.address() as net.AddressInfo;
            // Release the probe before the separately launched SDSIO process binds the port.
            server.close((error) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(address.port);
                }
            });
        });
    });
}
