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

'use strict';

const fs = require('fs');
const path = require('path');

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
