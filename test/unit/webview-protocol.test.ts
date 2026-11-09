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

import { describe, expect, it } from 'vitest';
import { getIndexedSdsSuffix, isSameSdsFile } from '../../src/webview/protocol';

describe('getIndexedSdsSuffix', () => {
    it('keeps matching stream cursors synchronized', () => {
        expect(getIndexedSdsSuffix('test_out.1.sds')).toBe(getIndexedSdsSuffix('test_in.1.sds'));
    });

    it('treats processed recording variants as the same stream', () => {
        expect(getIndexedSdsSuffix('camera.preview.2.sds')).toBe('.preview');
        expect(getIndexedSdsSuffix('camera.preview.2.p.sds')).toBe('.preview');
    });

    it('returns null for values that are not indexed SDS filenames', () => {
        expect(getIndexedSdsSuffix('image.sds')).toBeNull();
        expect(getIndexedSdsSuffix(undefined)).toBeNull();
    });
});

describe('isSameSdsFile', () => {
    it('isolates playback state broadcasts to the exact SDS filename', () => {
        expect(isSameSdsFile('image.0.sds', 'audio.0.sds')).toBe(false);
        expect(isSameSdsFile('IMAGE.0.SDS', 'image.0.sds')).toBe(true);
    });
});
