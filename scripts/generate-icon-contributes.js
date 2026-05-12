#!/usr/bin/env node
/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');
const codepointsPath = path.join(root, 'media', 'cmsissds.json');
const packagePath = path.join(root, 'package.json');

const codepoints = JSON.parse(fs.readFileSync(codepointsPath, 'utf-8'));
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));

const icons = {};
for (const [name, cp] of Object.entries(codepoints)) {
    icons[`arm-sds-${name}`] = {
        description: `CMSIS SDS — ${name}`,
        default: {
            fontPath: './media/cmsissds.ttf',
            fontCharacter: `\\${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        },
    };
}

pkg.contributes.icons = icons;

fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 4) + '\n', 'utf-8');
console.log(`✓ Patched contributes.icons with ${Object.keys(icons).length} icon(s): ${Object.keys(icons).join(', ')}`);
