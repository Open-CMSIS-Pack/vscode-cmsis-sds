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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMockState = vi.hoisted(() => {
    const outputChannels: Array<{
        appendLine: ReturnType<typeof vi.fn>;
        clear: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        hide: ReturnType<typeof vi.fn>;
        show: ReturnType<typeof vi.fn>;
    }> = [];

    const createOutputChannelMock = vi.fn(() => {
        const channel = {
            appendLine: vi.fn(),
            clear: vi.fn(),
            dispose: vi.fn(),
            hide: vi.fn(),
            show: vi.fn(),
        };
        outputChannels.push(channel);
        return channel;
    });

    return {
        createOutputChannelMock,
        extensions: [] as Array<{ packageJSON?: { name?: string; version?: string } }>,
        outputChannels,
    };
});

vi.mock('vscode', () => ({
    extensions: {
        get all() {
            return vscodeMockState.extensions;
        },
    },
    version: '1.118.0-test',
    window: {
        createOutputChannel: vscodeMockState.createOutputChannelMock,
    },
}));

import {
    diag,
    DiagnosticLevel,
    DiagnosticSource,
    SdsDiagnostics,
} from '../../src/diagnostics/sdsDiagnostics';

function lastOutputChannel() {
    const channel = vscodeMockState.outputChannels[vscodeMockState.outputChannels.length - 1];
    if (!channel) {
        throw new Error('No output channel was created');
    }
    return channel;
}

function appendedLines(): string[] {
    return lastOutputChannel().appendLine.mock.calls.map(([line]) => String(line));
}

describe('SdsDiagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vscodeMockState.extensions = [];
        vscodeMockState.outputChannels.length = 0;
    });

    afterEach(() => {
        SdsDiagnostics.getInstance().dispose();
        vi.restoreAllMocks();
    });

    it('creates a singleton output channel and exposes it through diag()', () => {
        const first = SdsDiagnostics.getInstance();
        const second = SdsDiagnostics.getInstance();

        expect(first).toBe(second);
        expect(diag()).toBe(first);
        expect(vscodeMockState.createOutputChannelMock).toHaveBeenCalledTimes(1);
        expect(vscodeMockState.createOutputChannelMock).toHaveBeenCalledWith('CMSIS SDS Diagnostics');
        expect(first.outputChannel).toBe(lastOutputChannel());
    });

    it('writes formatted entries, stores history copies, and mirrors warnings and errors', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const diagnostics = SdsDiagnostics.getInstance();
        const error = new Error('disk failed');
        error.stack = [
            'Error: disk failed',
            '    at first',
            '    at second',
            '    at third',
            '    at fourth',
        ].join('\n');

        diagnostics.info(DiagnosticSource.Extension, 'Activated');
        diagnostics.warn(DiagnosticSource.Server, 'Slow response');
        diagnostics.error(DiagnosticSource.Exporter, 'Export failed', error);
        diagnostics.error(DiagnosticSource.Viewer, 'Render failed', 'bad frame');

        const lines = appendedLines();
        expect(lines[0]).toMatch(/\] INFO {2}\[Extension {3}\] Activated$/);
        expect(lines[1]).toMatch(/\] WARN {2}\[Server {6}\] Slow response$/);
        expect(lines[2]).toContain('ERROR [Exporter    ] Export failed');
        expect(lines[2]).toContain('disk failed');
        expect(lines[2]).toContain('Stack:     at first');
        expect(lines[2]).toContain('    at third');
        expect(lines[2]).not.toContain('    at fourth');
        expect(lines[3]).toContain('ERROR [Viewer      ] Render failed');
        expect(lines[3]).toContain('bad frame');
        expect(warnSpy).toHaveBeenCalledWith('[CMSIS SDS] Server: Slow response');
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[CMSIS SDS] Exporter: Export failed'));
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('disk failed'));

        const history = diagnostics.getHistory();
        expect(history).toHaveLength(4);
        expect(history.map((entry) => entry.level)).toEqual([
            DiagnosticLevel.Info,
            DiagnosticLevel.Warn,
            DiagnosticLevel.Error,
            DiagnosticLevel.Error,
        ]);

        history.pop();
        expect(diagnostics.getHistory()).toHaveLength(4);
        expect(diagnostics.getHistory(2).map((entry) => entry.source)).toEqual([
            DiagnosticSource.Exporter,
            DiagnosticSource.Viewer,
        ]);
    });

    it('filters entries below the configured minimum level', () => {
        const diagnostics = SdsDiagnostics.getInstance();

        diagnostics.setMinLevel(DiagnosticLevel.Warn);
        diagnostics.trace(DiagnosticSource.Recorder, 'Trace detail');
        diagnostics.debug(DiagnosticSource.Recorder, 'Debug detail');
        diagnostics.info(DiagnosticSource.Recorder, 'Info detail');
        diagnostics.warn(DiagnosticSource.Recorder, 'Warning detail');

        const lines = appendedLines();
        expect(lines.some((line) => line.includes('Diagnostics log level set to WARN'))).toBe(false);
        expect(lines.some((line) => line.includes('Trace detail'))).toBe(false);
        expect(lines.some((line) => line.includes('Debug detail'))).toBe(false);
        expect(lines.some((line) => line.includes('Info detail'))).toBe(false);
        expect(lines[lines.length - 1]).toContain('Warning detail');
        expect(diagnostics.getHistory().map((entry) => entry.message)).toEqual(['Warning detail']);
    });

    it('shows, hides, clears, and disposes the output channel', () => {
        const diagnostics = SdsDiagnostics.getInstance();
        diagnostics.info(DiagnosticSource.Extension, 'Before clear');

        diagnostics.show();
        diagnostics.hide();
        diagnostics.clear();
        diagnostics.dispose();

        const channel = lastOutputChannel();
        expect(channel.show).toHaveBeenCalledWith(true);
        expect(channel.hide).toHaveBeenCalledTimes(1);
        expect(channel.clear).toHaveBeenCalledTimes(1);
        expect(channel.dispose).toHaveBeenCalledTimes(1);
        expect(diagnostics.getHistory()).toEqual([]);
        expect(appendedLines()).toEqual([
            expect.stringContaining('Before clear'),
            '╔═══════════════════════════════════════════════════════════════╗',
            expect.stringContaining('CMSIS SDS Diagnostics'),
            '╚═══════════════════════════════════════════════════════════════╝',
        ]);

        const replacement = SdsDiagnostics.getInstance();
        expect(replacement).not.toBe(diagnostics);
    });

    it('writes the startup banner with installed extension metadata', () => {
        vscodeMockState.extensions = [
            { packageJSON: { name: 'other-extension', version: '9.9.9' } },
            { packageJSON: { name: 'arm-cmsis-sds', version: '0.11.0' } },
        ];
        const diagnostics = SdsDiagnostics.getInstance();

        diagnostics.writeBanner();

        const lines = appendedLines();
        expect(lines).toContain('║                   Arm SDS Diagnostics                   ║');
        expect(lines).toContain('║                Server & System  Messages                ║');
        expect(lines).toContain('  VS Code: 1.118.0-test');
        expect(lines).toContain('  Extension: arm-cmsis-sds v0.11.0');
        expect(lines).toContain(`  Platform: ${process.platform} (${process.arch})`);
        expect(lines.some((line) => line.startsWith('  Started: '))).toBe(true);
    });

    it('writes unknown extension version when the extension is not installed', () => {
        const diagnostics = SdsDiagnostics.getInstance();

        diagnostics.writeBanner();

        expect(appendedLines()).toContain('  Extension: arm-cmsis-sds vunknown');
    });

    it('keeps only the most recent history entries', () => {
        const diagnostics = SdsDiagnostics.getInstance();
        const appendLineMock = lastOutputChannel().appendLine;
        appendLineMock.mockImplementation(() => undefined);

        for (let index = 0; index < 5001; index += 1) {
            diagnostics.info(DiagnosticSource.Extension, `message-${index}`);
        }

        const history = diagnostics.getHistory();
        expect(history).toHaveLength(5000);
        expect(history[0].message).toBe('message-1');
        expect(history[history.length - 1].message).toBe('message-5000');
    });
});
