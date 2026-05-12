/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
// Copy native modules (serialport, usb) into out/node_modules for VSIX packaging
const fs = require('fs-extra');
const path = require('path');

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
