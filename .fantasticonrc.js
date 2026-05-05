/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
module.exports = {
    inputDir: './media/icons',
    outputDir: './media',
    name: 'cmsissds',
    fontTypes: ['ttf'],
    assetTypes: ['json'],
    fontHeight: 300,
    normalize: true,
    pathOptions: {
        ttf: './media/cmsissds.ttf',
        json: './media/cmsissds.json',
    },
    // Pin codepoints so they never drift when new icons are added
    codepoints: {
        'sds-icon': 0xe000,
    },
};
