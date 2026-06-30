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

/**
 * Unit tests for SDS binary parser and writer.
 *
 * Covers:
 *  - Writing records to binary, parsing them back (roundtrip)
 *  - Empty file handling
 *  - Truncated / malformed file handling
 *  - Multi-frame records
 *  - Metadata YAML serialization and parsing (roundtrip)
 *  - CSV export and import (roundtrip)
 *  - findNextFileIndex logic
 *  - All SDS data types (uint8..double)
 *  - Scale/offset encoding and decoding
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
    parseSdsFile,
    parseSdsBuffer,
    decodeRecord,
    decodeAllRecords,
    decodeMediaFrames,
    decodeImageFrameToRGBA,
    decodeAudioBlock,
    parseSdsRecordIterator,
    indexSdsRecords,
    getSdsFileStats,
    writeSdsFile,
    encodeRecords,
    writeMetadataFile,
    parseMetadataFile,
    parseMetadataString,
    serializeMetadataToYaml,
    exportToCsv,
    importFromCsv,
    findNextFileIndex,
    SdsRecord,
    SdsMetadata,
    SdsContentValue,
    SdsDataType,
    SdsDecodedSample,
    sdsDataTypeSize,
    sdsFrameSize,
    detectMediaType,
    compareMetadata,
} from '../../src/sds';

// ── Helpers ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(timestamp: number, floats: number[]): SdsRecord {
    const data = Buffer.alloc(floats.length * 4);
    floats.forEach((v, i) => data.writeFloatLE(v, i * 4));
    return { timestamp, dataSize: data.length, data };
}

function make3AxisMetadata(name = 'Accel', freq = 100): SdsMetadata {
    return {
        sds: {
            name,
            frequency: freq,
            content: [
                { value: 'x', type: 'float', unit: 'mG' },
                { value: 'y', type: 'float', unit: 'mG' },
                { value: 'z', type: 'float', unit: 'mG' },
            ],
        },
    };
}

// ── Tests ───────────────────────────────────────────────────

describe('sdsDataTypeSize', () => {
    it('returns correct sizes for all types', () => {
        expect(sdsDataTypeSize('uint8_t')).toBe(1);
        expect(sdsDataTypeSize('int8_t')).toBe(1);
        expect(sdsDataTypeSize('uint16_t')).toBe(2);
        expect(sdsDataTypeSize('int16_t')).toBe(2);
        expect(sdsDataTypeSize('uint32_t')).toBe(4);
        expect(sdsDataTypeSize('int32_t')).toBe(4);
        expect(sdsDataTypeSize('float')).toBe(4);
        expect(sdsDataTypeSize('double')).toBe(8);
    });

    it('falls back to 4 bytes for unknown types', () => {
        expect(sdsDataTypeSize('fixed32' as SdsDataType)).toBe(4);
    });
});

describe('sdsFrameSize', () => {
    it('sums up channel sizes', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
            { value: 'z', type: 'float' },
        ];
        expect(sdsFrameSize(content)).toBe(12);
    });

    it('handles mixed types', () => {
        const content: SdsContentValue[] = [
            { value: 'a', type: 'uint8_t' },
            { value: 'b', type: 'double' },
        ];
        expect(sdsFrameSize(content)).toBe(9);
    });

    it('handles bit-field notation (uint32_t:1)', () => {
        const content: SdsContentValue[] = [
            { value: 'flags', type: 'uint32_t:1' as SdsDataType },
        ];
        expect(sdsFrameSize(content)).toBe(4);
    });
});

describe('writeSdsFile / parseSdsFile roundtrip', () => {
    it('writes and reads back identical records', () => {
        const records = [
            makeRecord(0, [1.0, 2.0, 3.0]),
            makeRecord(10, [4.0, 5.0, 6.0]),
            makeRecord(20, [7.0, 8.0, 9.0]),
        ];

        const filePath = path.join(tmpDir, 'test.0.sds');
        writeSdsFile(filePath, records);

        const parsed = parseSdsFile(filePath);
        expect(parsed.totalRecords).toBe(3);
        expect(parsed.records.length).toBe(3);

        for (let i = 0; i < records.length; i++) {
            expect(parsed.records[i].timestamp).toBe(records[i].timestamp);
            expect(parsed.records[i].dataSize).toBe(records[i].dataSize);
            expect(parsed.records[i].data).toEqual(records[i].data);
        }
    });

    it('computes correct duration', () => {
        const records = [
            makeRecord(0, [1.0]),
            makeRecord(500, [2.0]),
            makeRecord(1000, [3.0]),
        ];
        const filePath = path.join(tmpDir, 'dur.0.sds');
        writeSdsFile(filePath, records);

        const parsed = parseSdsFile(filePath);
        expect(parsed.durationMs).toBe(1000);
    });

    it('creates output directory if missing', () => {
        const nested = path.join(tmpDir, 'deep', 'nested', 'dir');
        const filePath = path.join(nested, 'test.0.sds');
        writeSdsFile(filePath, [makeRecord(0, [1.0])]);
        expect(fs.existsSync(filePath)).toBe(true);
    });
});

describe('parseSdsBuffer', () => {
    it('handles empty buffer', () => {
        const parsed = parseSdsBuffer(Buffer.alloc(0));
        expect(parsed.totalRecords).toBe(0);
        expect(parsed.records).toEqual([]);
    });

    it('handles buffer shorter than header', () => {
        const parsed = parseSdsBuffer(Buffer.alloc(4));
        expect(parsed.totalRecords).toBe(0);
    });

    it('handles truncated record (header present, data cut off)', () => {
        // Header says 100 bytes of data, but only 10 bytes follow
        const buf = Buffer.alloc(8 + 10);
        buf.writeUInt32LE(0, 0);    // timestamp
        buf.writeUInt32LE(100, 4);  // dataSize = 100 (but only 10 bytes available)
        const parsed = parseSdsBuffer(buf);
        expect(parsed.totalRecords).toBe(0); // truncated record skipped
    });

    it('parses multiple records correctly', () => {
        const rec1Data = Buffer.from([0x01, 0x02, 0x03, 0x04]);
        const rec2Data = Buffer.from([0xAA, 0xBB]);

        const buf = Buffer.alloc(8 + 4 + 8 + 2);
        let off = 0;
        // Record 1
        buf.writeUInt32LE(100, off); off += 4;
        buf.writeUInt32LE(4, off); off += 4;
        rec1Data.copy(buf, off); off += 4;
        // Record 2
        buf.writeUInt32LE(200, off); off += 4;
        buf.writeUInt32LE(2, off); off += 4;
        rec2Data.copy(buf, off);

        const parsed = parseSdsBuffer(buf);
        expect(parsed.totalRecords).toBe(2);
        expect(parsed.records[0].timestamp).toBe(100);
        expect(parsed.records[0].data).toEqual(rec1Data);
        expect(parsed.records[1].timestamp).toBe(200);
        expect(parsed.records[1].data).toEqual(rec2Data);
    });
});

describe('decodeRecord', () => {
    it('decodes float channels with default scale/offset', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const record = makeRecord(1000, [3.14, 2.71]);
        const sample = decodeRecord(record, content);

        expect(sample.timestamp).toBe(1000);
        expect(sample.timeSeconds).toBe(1.0);
        expect(sample.values['x']).toBeCloseTo(3.14, 2);
        expect(sample.values['y']).toBeCloseTo(2.71, 2);
    });

    it('applies scale and offset', () => {
        const content: SdsContentValue[] = [
            { value: 'temp', type: 'int16_t', scale: 0.01, offset: -40 },
        ];
        const data = Buffer.alloc(2);
        data.writeInt16LE(6500, 0); // raw=6500, decoded = 6500*0.01 + (-40) = 25.0
        const record: SdsRecord = { timestamp: 0, dataSize: 2, data };
        const sample = decodeRecord(record, content);

        expect(sample.values['temp']).toBeCloseTo(25.0, 4);
    });

    it('handles custom tick frequency', () => {
        const record = makeRecord(32768, [1.0]);
        const content: SdsContentValue[] = [{ value: 'v', type: 'float' }];
        const sample = decodeRecord(record, content, 32768);

        expect(sample.timeSeconds).toBeCloseTo(1.0, 4);
    });

    it('uses uint32 decoding for unknown base types', () => {
        const data = Buffer.alloc(4);
        data.writeUInt32LE(0x12345678, 0);
        const record: SdsRecord = { timestamp: 50, dataSize: data.length, data };
        const content: SdsContentValue[] = [{ value: 'raw', type: 'fixed32' as SdsDataType }];

        const sample = decodeRecord(record, content);

        expect(sample.values['raw']).toBe(0x12345678);
    });
});

describe('decodeAllRecords', () => {
    it('decodes all records from a parsed file', () => {
        const records = [
            makeRecord(0, [1.0, 2.0, 3.0]),
            makeRecord(10, [4.0, 5.0, 6.0]),
        ];
        const filePath = path.join(tmpDir, 'all.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const metadata = make3AxisMetadata();

        const samples = decodeAllRecords(parsed, metadata);
        expect(samples.length).toBe(2);
        expect(samples[0].values['x']).toBeCloseTo(1.0);
        expect(samples[1].values['z']).toBeCloseTo(6.0);
    });

    it('expands multi-frame records into separate samples', () => {
        // One record containing 2 frames (6 floats = 2 * 3-channel)
        const data = Buffer.alloc(24);
        [10, 20, 30, 40, 50, 60].forEach((v, i) => data.writeFloatLE(v, i * 4));
        const records: SdsRecord[] = [{ timestamp: 0, dataSize: 24, data }];

        const filePath = path.join(tmpDir, 'multi.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const metadata = make3AxisMetadata();

        const samples = decodeAllRecords(parsed, metadata);
        expect(samples.length).toBe(2);
        expect(samples[0].values['x']).toBeCloseTo(10);
        expect(samples[1].values['x']).toBeCloseTo(40);
    });
});

describe('encodeRecords / decodeAllRecords roundtrip', () => {
    it('encodes samples to records and decodes back identically', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const metadata: SdsMetadata = {
            sds: { name: 'Test', frequency: 100, content },
        };

        const originalSamples: SdsDecodedSample[] = [
            { timestamp: 0, timeSeconds: 0, values: { x: 1.5, y: -2.5 }, index: 0 },
            { timestamp: 10, timeSeconds: 0.01, values: { x: 3.0, y: 4.0 }, index: 1 },
        ];

        const records = encodeRecords(originalSamples, content);
        const filePath = path.join(tmpDir, 'rt.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const decoded = decodeAllRecords(parsed, metadata);

        expect(decoded.length).toBe(2);
        expect(decoded[0].values['x']).toBeCloseTo(1.5, 4);
        expect(decoded[0].values['y']).toBeCloseTo(-2.5, 4);
        expect(decoded[1].values['x']).toBeCloseTo(3.0, 4);
        expect(decoded[1].values['y']).toBeCloseTo(4.0, 4);
    });

    it('roundtrips with scale and offset', () => {
        const content: SdsContentValue[] = [
            { value: 'temp', type: 'int16_t', scale: 0.01, offset: -40 },
        ];
        const metadata: SdsMetadata = {
            sds: { name: 'Temp', frequency: 10, content },
        };

        const original: SdsDecodedSample[] = [
            { timestamp: 0, timeSeconds: 0, values: { temp: 25.0 }, index: 0 },
        ];

        const records = encodeRecords(original, content);
        const filePath = path.join(tmpDir, 'scale.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const decoded = decodeAllRecords(parsed, metadata);

        // int16 roundtrip: 25.0 → raw=(25+40)/0.01=6500 → decode=6500*0.01-40=25.0
        expect(decoded[0].values['temp']).toBeCloseTo(25.0, 1);
    });
});

describe('data type roundtrip', () => {
    const testCases: Array<{ type: string; value: number; tolerance: number }> = [
        { type: 'uint8_t', value: 200, tolerance: 0 },
        { type: 'int8_t', value: -50, tolerance: 0 },
        { type: 'uint16_t', value: 50000, tolerance: 0 },
        { type: 'int16_t', value: -10000, tolerance: 0 },
        { type: 'uint32_t', value: 3000000000, tolerance: 0 },
        { type: 'int32_t', value: -100000, tolerance: 0 },
        { type: 'float', value: 3.14159, tolerance: 0.001 },
        { type: 'double', value: 3.141592653589793, tolerance: 1e-10 },
    ];

    for (const tc of testCases) {
        it(`roundtrips ${tc.type} (value=${tc.value})`, () => {
            const content: SdsContentValue[] = [{ value: 'v', type: tc.type as SdsDataType }];
            const metadata: SdsMetadata = {
                sds: { name: 'T', frequency: 1, content },
            };
            const samples: SdsDecodedSample[] = [
                { timestamp: 0, timeSeconds: 0, values: { v: tc.value }, index: 0 },
            ];

            const records = encodeRecords(samples, content);
            const filePath = path.join(tmpDir, `type-${tc.type}.0.sds`);
            writeSdsFile(filePath, records);
            const parsed = parseSdsFile(filePath);
            const decoded = decodeAllRecords(parsed, metadata);

            expect(decoded[0].values['v']).toBeCloseTo(tc.value, -Math.log10(tc.tolerance || 1));
        });
    }
});

describe('getSdsFileStats', () => {
    it('returns zeros for empty file', () => {
        const filePath = path.join(tmpDir, 'empty.0.sds');
        writeSdsFile(filePath, []);
        const parsed = parseSdsFile(filePath);
        const stats = getSdsFileStats(parsed);
        expect(stats.totalRecords).toBe(0);
        expect(stats.fileSize).toBe(0);
    });

    it('computes correct stats', () => {
        const records = [
            makeRecord(0, [1.0, 2.0]),      // 8 bytes data
            makeRecord(100, [3.0, 4.0, 5.0]), // 12 bytes data
            makeRecord(200, [6.0]),            // 4 bytes data
        ];
        const filePath = path.join(tmpDir, 'stats.0.sds');
        writeSdsFile(filePath, records);
        const parsed = parseSdsFile(filePath);
        const stats = getSdsFileStats(parsed);

        expect(stats.totalRecords).toBe(3);
        expect(stats.minBlockSize).toBe(4);
        expect(stats.maxBlockSize).toBe(12);
        expect(stats.recordingTimeSeconds).toBeCloseTo(0.2); // 200ms / 1000
    });

    it('uses zero interval and data rate for a single record', () => {
        const parsed = parseSdsBuffer(Buffer.concat([
            Buffer.from([0x7B, 0, 0, 0, 4, 0, 0, 0]),
            Buffer.from([1, 2, 3, 4]),
        ]));

        const stats = getSdsFileStats(parsed);

        expect(stats.recordingIntervalMs).toBe(0);
        expect(stats.dataRate).toBe(0);
        expect(stats.avgBlockSize).toBe(4);
    });
});

describe('media decoding helpers', () => {
    it('preserves raw record data when decoding media frames', () => {
        const parsed = parseSdsBuffer(Buffer.concat([
            Buffer.from([0, 4, 0, 0, 3, 0, 0, 0]),
            Buffer.from([10, 20, 30]),
            Buffer.from([0, 8, 0, 0, 2, 0, 0, 0]),
            Buffer.from([40, 50]),
        ]));
        const metadata: SdsMetadata = {
            sds: {
                name: 'Camera',
                frequency: 30,
                'tick-frequency': 2000,
                content: [{ value: 'frame', type: 'uint8_t', image: { pixel_format: 'RAW8', width: 1, height: 1 } }],
            },
        };

        const frames = decodeMediaFrames(parsed, metadata);

        expect(frames).toHaveLength(2);
        expect(frames[0]).toMatchObject({ timestamp: 1024, timeSeconds: 0.512, frameIndex: 0, mediaType: 'image' });
        expect(frames[1].data).toEqual(Buffer.from([40, 50]));
    });

    it('decodes RGB888, RAW8, RGB565, NV12, NV21, and fallback image frames to RGBA', () => {
        expect(Array.from(decodeImageFrameToRGBA(Buffer.from([1, 2, 3]), 1, 1, 'RGB888')))
            .toEqual([1, 2, 3, 255]);
        expect(Array.from(decodeImageFrameToRGBA(Buffer.from([9]), 1, 1, 'RAW8')))
            .toEqual([9, 9, 9, 255]);

        const rgb565 = Buffer.alloc(2);
        rgb565.writeUInt16LE(0xF800, 0);
        expect(Array.from(decodeImageFrameToRGBA(rgb565, 1, 1, 'RGB565')))
            .toEqual([255, 0, 0, 255]);

        const nv12 = decodeImageFrameToRGBA(Buffer.from([50, 60, 70, 80, 128, 128]), 2, 2, 'NV12');
        expect(Array.from(nv12.slice(0, 8))).toEqual([50, 50, 50, 255, 60, 60, 60, 255]);

        const nv21 = decodeImageFrameToRGBA(Buffer.from([50, 60, 70, 80, 128, 128]), 2, 2, 'NV21');
        expect(Array.from(nv21.slice(8, 16))).toEqual([70, 70, 70, 255, 80, 80, 80, 255]);

        expect(Array.from(decodeImageFrameToRGBA(Buffer.from([12]), 1, 1, 'BAYER')))
            .toEqual([12, 12, 12, 255]);
    });

    it('handles truncated image input by leaving missing color channels black', () => {
        expect(Array.from(decodeImageFrameToRGBA(Buffer.from([4, 5]), 1, 1, 'RGB888')))
            .toEqual([0, 0, 0, 255]);
        expect(Array.from(decodeImageFrameToRGBA(Buffer.from([]), 1, 1, 'NV12')))
            .toEqual([0, 0, 0, 255]);
    });

    it('decodes PCM audio blocks across supported bit depths', () => {
        const pcm8 = decodeAudioBlock(Buffer.from([0, 128, 255, 64]), 8000, 8, 2);
        expect(pcm8[0][0]).toBeCloseTo(-1);
        expect(pcm8[1][0]).toBeCloseTo(0);
        expect(pcm8[0][1]).toBeCloseTo(127 / 128);
        expect(pcm8[1][1]).toBeCloseTo(-0.5);

        const pcm16Buffer = Buffer.alloc(4);
        pcm16Buffer.writeInt16LE(-32768, 0);
        pcm16Buffer.writeInt16LE(16384, 2);
        const pcm16 = decodeAudioBlock(pcm16Buffer, 16000, 16, 1);
        expect(pcm16[0][0]).toBeCloseTo(-1);
        expect(pcm16[0][1]).toBeCloseTo(0.5);

        const pcm24Positive = decodeAudioBlock(Buffer.from([0x00, 0x00, 0x40]), 16000, 24, 1);
        const pcm24Negative = decodeAudioBlock(Buffer.from([0x00, 0x00, 0xC0]), 16000, 24, 1);
        expect(pcm24Positive[0][0]).toBeCloseTo(0.5);
        expect(pcm24Negative[0][0]).toBeCloseTo(-0.5);

        const pcm32Buffer = Buffer.alloc(4);
        pcm32Buffer.writeFloatLE(0.25, 0);
        expect(decodeAudioBlock(pcm32Buffer, 44100, 32, 1)[0][0]).toBeCloseTo(0.25);
        expect(decodeAudioBlock(Buffer.from([1, 2]), 44100, 12, 1)[0][0]).toBe(0);
    });
});

describe('streaming parser helpers', () => {
    it('iterates records without loading the whole file and builds an index', () => {
        const records = [
            { timestamp: 10, dataSize: 2, data: Buffer.from([1, 2]) },
            { timestamp: 20, dataSize: 3, data: Buffer.from([3, 4, 5]) },
        ];
        const filePath = path.join(tmpDir, 'stream.0.sds');
        writeSdsFile(filePath, records);

        const iterated = Array.from(parseSdsRecordIterator(filePath));
        const index = indexSdsRecords(filePath);

        expect(iterated.map(record => record.recordIndex)).toEqual([0, 1]);
        expect(iterated[1].data).toEqual(Buffer.from([3, 4, 5]));
        expect(index).toEqual([
            { recordIndex: 0, timestamp: 10, dataSize: 2, dataOffset: 8 },
            { recordIndex: 1, timestamp: 20, dataSize: 3, dataOffset: 18 },
        ]);
    });

    it('stops iterating and indexing at a truncated record', () => {
        const filePath = path.join(tmpDir, 'truncated-stream.0.sds');
        writeSdsFile(filePath, [{ timestamp: 1, dataSize: 1, data: Buffer.from([9]) }]);
        const truncatedHeader = Buffer.alloc(8);
        truncatedHeader.writeUInt32LE(2, 0);
        truncatedHeader.writeUInt32LE(10, 4);
        fs.appendFileSync(filePath, truncatedHeader);

        expect(Array.from(parseSdsRecordIterator(filePath))).toHaveLength(1);
        expect(indexSdsRecords(filePath)).toHaveLength(1);
    });
});

describe('metadata helpers', () => {
    it('detects media type priority and defaults to sensor', () => {
        expect(detectMediaType({ sds: { name: 'Empty', frequency: 1, content: [] } })).toBe('sensor');
        expect(detectMediaType({ sds: { name: 'Sensor', frequency: 1, content: [{ value: 'x', type: 'float' }] } })).toBe('sensor');
        expect(detectMediaType({
            sds: {
                name: 'Video',
                frequency: 30,
                content: [{ value: 'video', type: 'uint8_t', video: { pixel_format: 'NV12', width: 2, height: 2, fps: 30 } }],
            },
        })).toBe('video');
        expect(detectMediaType({
            sds: {
                name: 'Mic',
                frequency: 1,
                content: [
                    { value: 'audio', type: 'int16_t', audio: { sample_rate: 16000, bit_depth: 16, audio_channels: 1 } },
                ],
            },
        })).toBe('audio');
        expect(detectMediaType({
            sds: {
                name: 'Camera',
                frequency: 30,
                content: [{ value: 'frame', type: 'uint8_t', image: { pixel_format: 'RAW8', width: 1, height: 1 } }],
            },
        })).toBe('image');
    });

    it('reports metadata conflicts for scalar fields and content differences', () => {
        const existing: SdsMetadata = {
            sds: {
                name: 'A',
                frequency: 10,
                'tick-frequency': 1000,
                content: [{ value: 'x', type: 'float' }],
            },
        };

        expect(compareMetadata(existing, existing)).toEqual([]);
        expect(compareMetadata(existing, {
            sds: {
                name: 'B',
                frequency: 20,
                'tick-frequency': 2000,
                content: [{ value: 'y', type: 'int16_t' }],
            },
        })).toEqual([
            { field: 'name', existingValue: 'A', newValue: 'B' },
            { field: 'frequency', existingValue: 10, newValue: 20 },
            { field: 'tick-frequency', existingValue: 1000, newValue: 2000 },
            { field: 'content[0].value', existingValue: 'x', newValue: 'y' },
            { field: 'content[0].type', existingValue: 'float', newValue: 'int16_t' },
        ]);
        expect(compareMetadata(existing, {
            sds: {
                name: 'A',
                frequency: 10,
                content: [
                    { value: 'x', type: 'float' },
                    { value: 'y', type: 'float' },
                ],
            },
        })).toEqual([
            { field: 'content.length', existingValue: 1, newValue: 2 },
        ]);
    });
});

describe('metadata YAML roundtrip', () => {
    it('writes and reads back sensor metadata', () => {
        const original = make3AxisMetadata('Gyro', 200);
        original.sds.description = 'Test gyroscope';
        original.sds['tick-frequency'] = 32768;

        const filePath = path.join(tmpDir, 'Gyro.sds.yml');
        writeMetadataFile(filePath, original);
        const parsed = parseMetadataFile(filePath);

        expect(parsed.sds.name).toBe('Gyro');
        expect(parsed.sds.description).toBe('Test gyroscope');
        expect(parsed.sds.frequency).toBe(200);
        expect(parsed.sds['tick-frequency']).toBe(32768);
        expect(parsed.sds.content.length).toBe(3);
        expect(parsed.sds.content[0].value).toBe('x');
        expect(parsed.sds.content[0].type).toBe('float');
        expect(parsed.sds.content[0].unit).toBe('mG');
    });

    it('roundtrips image metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Camera',
                frequency: 30,
                content: [{
                    value: 'frame',
                    type: 'uint8_t',
                    image: { pixel_format: 'RGB888', width: 320, height: 240 },
                }],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].image).toBeDefined();
        expect(parsed.sds.content[0].image!.pixel_format).toBe('RGB888');
        expect(parsed.sds.content[0].image!.width).toBe(320);
        expect(parsed.sds.content[0].image!.height).toBe(240);
    });

    it('roundtrips audio metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Mic',
                frequency: 1,
                content: [{
                    value: 'audio',
                    type: 'int16_t',
                    audio: { sample_rate: 16000, bit_depth: 16, audio_channels: 1 },
                }],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].audio).toBeDefined();
        expect(parsed.sds.content[0].audio!.sample_rate).toBe(16000);
        expect(parsed.sds.content[0].audio!.bit_depth).toBe(16);
        expect(parsed.sds.content[0].audio!.audio_channels).toBe(1);
    });

    it('roundtrips video metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Video',
                frequency: 30,
                content: [{
                    value: 'frame',
                    type: 'uint8_t',
                    video: { pixel_format: 'NV12', width: 640, height: 480, fps: 30 },
                }],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].video).toBeDefined();
        expect(parsed.sds.content[0].video!.pixel_format).toBe('NV12');
        expect(parsed.sds.content[0].video!.width).toBe(640);
        expect(parsed.sds.content[0].video!.fps).toBe(30);
    });

    it('writes metadata into missing directories and preserves optional media fields', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Media',
                frequency: 60,
                content: [
                    {
                        value: 'image',
                        type: 'uint8_t',
                        image: { pixel_format: 'RGB888', width: 2, height: 1, stride_bytes: 8 },
                    },
                    {
                        value: 'audio',
                        type: 'int16_t',
                        audio: { sample_rate: 48000, bit_depth: 24, audio_channels: 2, codec: 'pcm', frame_size: 128 },
                    },
                    {
                        value: 'video',
                        type: 'uint8_t',
                        video: {
                            pixel_format: 'NV12',
                            width: 4,
                            height: 2,
                            fps: 29.97,
                            codec: 'raw',
                            stride_bytes: 4,
                            keyframe_interval: 15,
                        },
                    },
                ],
            },
        };
        const filePath = path.join(tmpDir, 'nested', 'metadata', 'Media.sds.yml');

        writeMetadataFile(filePath, meta);
        const text = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseMetadataFile(filePath);

        expect(text).toContain('stride_bytes: 8');
        expect(text).toContain('codec: pcm');
        expect(text).toContain('frame_size: 128');
        expect(text).toContain('keyframe_interval: 15');
        expect(parsed.sds.content[0].image!.stride_bytes).toBe(8);
        expect(parsed.sds.content[1].audio).toMatchObject({ codec: 'pcm', frame_size: 128 });
        expect(parsed.sds.content[2].video).toMatchObject({ codec: 'raw', stride_bytes: 4, keyframe_interval: 15 });
    });

    it('parses quoted scalar and content values', () => {
        const parsed = parseMetadataString(`
sds:
  name: "Quoted Stream"
  description: 'quoted description'
  frequency: 12.5
  tick-frequency: 250
  content:
  - value: "channel one"
    type: 'int16_t'
    unit: "m/s"
`);

        expect(parsed.sds.name).toBe('Quoted Stream');
        expect(parsed.sds.description).toBe('quoted description');
        expect(parsed.sds.frequency).toBe(12.5);
        expect(parsed.sds['tick-frequency']).toBe(250);
        expect(parsed.sds.content[0]).toMatchObject({ value: 'channel one', type: 'int16_t', unit: 'm/s' });
    });

    it('handles scale and offset in metadata', () => {
        const meta: SdsMetadata = {
            sds: {
                name: 'Scaled',
                frequency: 10,
                content: [
                    { value: 'temp', type: 'int16_t', scale: 0.01, offset: -40, unit: 'C' },
                ],
            },
        };

        const yaml = serializeMetadataToYaml(meta);
        const parsed = parseMetadataString(yaml);

        expect(parsed.sds.content[0].scale).toBe(0.01);
        expect(parsed.sds.content[0].offset).toBe(-40);
    });
});

describe('CSV export / import roundtrip', () => {
    it('exports and imports back identical data', () => {
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const metadata: SdsMetadata = {
            sds: { name: 'Test', frequency: 100, content },
        };

        const samples: SdsDecodedSample[] = [
            { timestamp: 0, timeSeconds: 0, values: { x: 1.5, y: 2.5 }, index: 0 },
            { timestamp: 10, timeSeconds: 0.01, values: { x: 3.0, y: 4.0 }, index: 1 },
        ];

        const csvPath = path.join(tmpDir, 'export.csv');
        exportToCsv(samples, content, csvPath);

        expect(fs.existsSync(csvPath)).toBe(true);
        const csvText = fs.readFileSync(csvPath, 'utf-8');
        expect(csvText).toContain('timestamp_s,x,y');

        const imported = importFromCsv(csvPath, 'Test', 100, 'float');
        expect(imported.records.length).toBe(2);
        expect(imported.metadata.sds.content.length).toBe(2);
        expect(imported.metadata.sds.content[0].value).toBe('x');
    });

    it('writes empty CSV for no samples', () => {
        const csvPath = path.join(tmpDir, 'empty.csv');
        exportToCsv([], [], csvPath);
        const text = fs.readFileSync(csvPath, 'utf-8');
        expect(text).toBe('');
    });

    it('exports absolute timestamps and zeroes missing values', () => {
        const csvPath = path.join(tmpDir, 'absolute.csv');
        const content: SdsContentValue[] = [
            { value: 'x', type: 'float' },
            { value: 'y', type: 'float' },
        ];
        const samples: SdsDecodedSample[] = [
            { timestamp: 5250, timeSeconds: 5.25, values: { x: 1 }, index: 0 },
        ];

        exportToCsv(samples, content, csvPath, false);

        expect(fs.readFileSync(csvPath, 'utf-8')).toBe('timestamp_s,x,y\n5.250000,1.000000,0\n');
    });

    it('imports CSV while skipping short rows and defaulting non-numeric cells to zero', () => {
        const csvPath = path.join(tmpDir, 'messy.csv');
        fs.writeFileSync(csvPath, [
            'timestamp_s,x,y',
            '0.005,1,NaN',
            '0.010',
            '0.015,3,4',
        ].join('\n'), 'utf-8');

        const imported = importFromCsv(csvPath, 'Messy', 50, 'float', 2000);

        expect(imported.records).toHaveLength(2);
        expect(imported.records[0].timestamp).toBe(10);
        expect(imported.records[0].data.readFloatLE(0)).toBeCloseTo(1);
        expect(imported.records[0].data.readFloatLE(4)).toBeCloseTo(0);
        expect(imported.records[1].timestamp).toBe(30);
        expect(imported.records[1].data.readFloatLE(4)).toBeCloseTo(4);
        expect(imported.metadata.sds).toMatchObject({ name: 'Messy', frequency: 50 });
    });

    it('rejects CSV files without data rows', () => {
        const csvPath = path.join(tmpDir, 'header-only.csv');
        fs.writeFileSync(csvPath, 'timestamp_s,x\n', 'utf-8');

        expect(() => importFromCsv(csvPath, 'Bad', 1)).toThrow('CSV file must contain at least a header row and one data row');
    });
});

describe('findNextFileIndex', () => {
    it('returns 0 for empty directory', () => {
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(0);
    });

    it('returns 0 for non-existent directory', () => {
        expect(findNextFileIndex(path.join(tmpDir, 'nope'), 'Accel')).toBe(0);
    });

    it('returns next index after existing files', () => {
        fs.writeFileSync(path.join(tmpDir, 'Accel.0.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Accel.1.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Accel.2.sds'), '');
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(3);
    });

    it('handles gaps (returns max+1)', () => {
        fs.writeFileSync(path.join(tmpDir, 'Accel.0.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Accel.5.sds'), '');
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(6);
    });

    it('ignores files with different stream names', () => {
        fs.writeFileSync(path.join(tmpDir, 'Gyro.0.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Gyro.3.sds'), '');
        expect(findNextFileIndex(tmpDir, 'Accel')).toBe(0);
    });

    it('handles special regex characters in stream name', () => {
        fs.writeFileSync(path.join(tmpDir, 'My.Sensor.0.sds'), '');
        expect(findNextFileIndex(tmpDir, 'My.Sensor')).toBe(1);
    });

    it('recognizes optional payload suffixes and matches names case-insensitively', () => {
        fs.writeFileSync(path.join(tmpDir, 'Stream.7.raw.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'Stream.10.bin.p.sds'), '');
        fs.writeFileSync(path.join(tmpDir, 'stream.12.SDS'), '');

        expect(findNextFileIndex(tmpDir, 'Stream')).toBe(13);
    });
});
