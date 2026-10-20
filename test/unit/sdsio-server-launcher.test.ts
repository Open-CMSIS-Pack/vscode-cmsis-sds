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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SdsioServerLauncher } from '../../src/controller/sdsioServerLauncher';
import { SdsDiagnostics } from '../../src/diagnostics/sdsDiagnostics';

type MockTerminal = {
    sendText: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
};

let mockTerminal: MockTerminal;
let defaultProfile = 'Command Prompt';

vi.mock('vscode', () => {
    class ThemeIcon {
        constructor(public readonly id: string) { }
    }

    const window = {
        createTerminal: vi.fn(() => mockTerminal),
        onDidCloseTerminal: vi.fn(() => ({
            dispose: vi.fn(),
        })),
    };

    const workspace = {
        getConfiguration: vi.fn(() => ({
            get: vi.fn(() => defaultProfile),
        })),
    };

    return {
        ThemeIcon,
        window,
        workspace,
    };
});

describe('SdsioServerLauncher', () => {
    let tmpDir: string;
    let diagnostics: SdsDiagnostics;

    beforeEach(() => {
        vi.clearAllMocks();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdsio-launcher-'));
        mockTerminal = {
            sendText: vi.fn(),
            show: vi.fn(),
            dispose: vi.fn(),
        };
        defaultProfile = 'Command Prompt';
        diagnostics = {
            info: vi.fn(),
            error: vi.fn(),
        } as unknown as SdsDiagnostics;
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.useRealTimers();
    });

    it.each([
        ['Command Prompt', 'sdsio-server.exe'],
        ['PowerShell', 'sdsio-server.exe'],
        ['bash', 'sdsio-server'],
    ])('starts server directly without auto-activation for %s profiles', async (profile, binaryName) => {
        const basePath = path.join(tmpDir, 'extension with spaces');
        const toolsDir = path.join(basePath, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        const serverBinary = path.join(toolsDir, binaryName);
        fs.writeFileSync(serverBinary, '');
        const configFile = path.join(tmpDir, 'workspace with spaces', 'sample config.sdsio.yml');
        defaultProfile = profile;

        const launcher = new SdsioServerLauncher(diagnostics);
        const started = await launcher.start({
            basePath,
            configFile,
            monitorPort: 6060,
        });

        expect(started).toBe(true);
        expect(launcher.hasTerminal()).toBe(true);
        expect(vscode.window.createTerminal).toHaveBeenCalledExactlyOnceWith({
            name: expect.stringMatching(/^SDSIO Server /),
            cwd: path.dirname(configFile),
            shellPath: serverBinary,
            shellArgs: ['--control', configFile, '--mon-port', '6060'],
            iconPath: expect.objectContaining({ id: 'arm-sds-sds-icon' }),
            hideFromUser: true,
        });
        expect(vscode.workspace.getConfiguration).not.toHaveBeenCalled();
        expect(mockTerminal.show).toHaveBeenCalledExactlyOnceWith(true);
        expect(mockTerminal.sendText).not.toHaveBeenCalled();
    });

    it('logs an error and returns false when server binary is missing', async () => {
        const launcher = new SdsioServerLauncher(diagnostics);

        const started = await launcher.start({
            basePath: tmpDir,
            configFile: 'sample.sdsio.yml',
            monitorPort: 6060,
        });

        expect(started).toBe(false);
        expect(launcher.hasTerminal()).toBe(false);
        expect((diagnostics.error as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it('stop sends shutdown command and disposes terminal', async () => {
        vi.useFakeTimers();

        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });
        const serverBinary = path.join(toolsDir, 'sdsio-server.exe');
        fs.writeFileSync(serverBinary, '');

        const launcher = new SdsioServerLauncher(diagnostics);
        await launcher.start({
            basePath: tmpDir,
            configFile: 'sample.sdsio.yml',
            monitorPort: 6060,
        });

        const stopPromise = launcher.stop('stop reason');
        vi.runAllTimers();
        await stopPromise;

        expect(mockTerminal.sendText).toHaveBeenCalledWith('x', false);
        expect(mockTerminal.dispose).toHaveBeenCalledTimes(1);
        expect(launcher.hasTerminal()).toBe(false);
    });
});
