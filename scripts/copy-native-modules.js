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

// Copy native modules (serialport, usb) into out/node_modules for VSIX packaging
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const modules = [
    'serialport',
    'usb',
    '@serialport/binding-mock',
    '@serialport/bindings-cpp',
    '@serialport/bindings-interface',
    '@serialport/parser-byte-length',
    '@serialport/parser-cctalk',
    '@serialport/parser-delimiter',
    '@serialport/parser-inter-byte-timeout',
    '@serialport/parser-packet-length',
    '@serialport/parser-readline',
    '@serialport/parser-ready',
    '@serialport/parser-regex',
    '@serialport/parser-slip-encoder',
    '@serialport/parser-spacepacket',
    '@serialport/stream',
    'ms',
    'debug',
    'node-gyp-build',
];
const outNodeModules = path.join(__dirname, '..', 'out', 'node_modules');

fs.ensureDirSync(outNodeModules);

function isLockedNativeBinary(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    return normalized.endsWith('.node') && normalized.includes('/prebuilds/');
}

for (const mod of modules) {
    const src = path.join(__dirname, '..', 'node_modules', mod);
    const dest = path.join(outNodeModules, mod);
    if (fs.existsSync(src)) {
        try {
            fs.copySync(src, dest, {
                overwrite: true,
                errorOnExist: false,
                dereference: true,
                filter: (source) => {
                    if (isLockedNativeBinary(source)) {
                        try {
                            const relative = path.relative(src, source);
                            const candidateDest = path.join(dest, relative);
                            if (fs.existsSync(candidateDest)) {
                                // Keep existing locked binary in destination.
                                return false;
                            }
                        } catch {
                            // If any path check fails, keep default behavior.
                        }
                    }
                    return true;
                },
            });
            console.log(`Copied ${mod} to out/node_modules`);
        } catch (err) {
            const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
            if (code === 'EPERM' || code === 'EBUSY') {
                console.warn(`Skipped ${mod}: file lock detected (${String(code)}). Close running extension hosts/processes and retry if needed.`);
                continue;
            }
            throw err;
        }
    } else {
        console.warn(`Module ${mod} not found in node_modules`);
    }
}
