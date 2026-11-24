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

import * as fs from 'fs';
import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { DiagnosticSource, SdsDiagnostics } from '../diagnostics/sdsDiagnostics';

export type SdsioServerLaunchOptions = {
    basePath: string;
    configFile: string;
    monitorPort: number;
};

export class SdsioServerLauncher {
    private terminal?: vscode.Terminal | undefined;
    private monitorPort?: number | undefined;
    private configFile?: string | undefined;
    private stoppingPromise?: Promise<void> | undefined;
    private readonly closeListener: vscode.Disposable;

    constructor(private readonly diagnostics: SdsDiagnostics) {
        this.closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
            if (this.terminal === closedTerminal) {
                void this.stop('vscode closing');
            }
        });
    }

    hasTerminal(): boolean {
        return this.terminal !== undefined;
    }

    getOwnedServerPort(configFile: string): number | undefined {
        return this.terminal && !this.stoppingPromise && this.configFile === path.resolve(configFile)
            ? this.monitorPort : undefined;
    }

    async getRunningServerPort(preferredPort: number): Promise<number | undefined> {
        if (this.terminal) {
            return this.monitorPort ?? preferredPort;
        }

        const execute = promisify(execFile);
        let commands: string[];
        if (process.platform === 'win32') {
            const { stdout } = await execute('powershell.exe', [
                '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
                '$ErrorActionPreference = \'Stop\'; $servers = @(Get-CimInstance Win32_Process -Filter "Name = \'sdsio-server.exe\'" | Select-Object CommandLine); ConvertTo-Json -InputObject $servers -Compress',
            ], { timeout: 5000, windowsHide: true });
            const servers = JSON.parse(stdout) as Array<{ CommandLine: string | null }>;
            commands = servers.map((server) => server.CommandLine ?? 'sdsio-server');
        } else {
            const { stdout } = await execute('ps', ['-ax', '-o', 'args='], { timeout: 5000 });
            commands = stdout.split('\n').filter((command) => /(?:^|[/\s])sdsio-server(?:\s|$)/.test(command));
        }

        if (commands.length === 0) {
            return undefined;
        }

        const ports = commands.map((command) => {
            const match = command.match(/(?:--mon-port|-m)["']?(?:=|\s+)["']?(\d+)/);
            const port = match ? Number(match[1]) : 6060;
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error('Running SDSIO server has an invalid monitor port.');
            }
            return port;
        });
        return ports.includes(preferredPort) ? preferredPort : ports[0];
    }

    async stop(reason: string): Promise<void> {
        if (this.stoppingPromise) {
            await this.stoppingPromise;
            return;
        }

        if (!this.terminal) {
            return;
        }

        const terminal = this.terminal;
        this.stoppingPromise = (async () => {
            this.diagnostics.info(DiagnosticSource.Server, reason);
            terminal.sendText('x', false);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            terminal.dispose();
            if (this.terminal === terminal) {
                this.terminal = undefined;
                this.configFile = undefined;
                this.monitorPort = undefined;
            }
        })();

        try {
            await this.stoppingPromise;
        } finally {
            this.stoppingPromise = undefined;
        }
    }

    async start(options: SdsioServerLaunchOptions): Promise<boolean> {
        if (this.terminal) {
            return false;
        }
        const serverBinary = this.resolveServerBinary(options.basePath);
        if (!serverBinary) {
            return false;
        }

        const configDir = path.dirname(options.configFile);
        this.monitorPort = options.monitorPort;
        this.configFile = path.resolve(options.configFile);

        this.terminal = vscode.window.createTerminal({
            name: `SDSIO Server ${new Date().toLocaleTimeString()}`,
            cwd: configDir,
            shellPath: serverBinary,
            shellArgs: [
                '--control', options.configFile,
                '--mon-port', String(options.monitorPort),
            ],
            iconPath: new vscode.ThemeIcon('arm-sds-sds-icon'),
            hideFromUser: true,
        });

        this.diagnostics.info(
            DiagnosticSource.Server,
            `Spawning SDSIO server from binary: ${serverBinary} with config file: ${options.configFile}`,
        );

        this.terminal.show(true);
        this.diagnostics.info(DiagnosticSource.Server, 'SDSIO server process started, waiting for monitor connection...');
        return true;
    }

    dispose(): void {
        void this.stop('Disposing SDSIO server terminal');
        this.closeListener.dispose();
    }

    static resolveServerBinary(basePath: string, diagnostics?: SdsDiagnostics): string | undefined {
        const toolsDir = path.join(basePath, 'tools');
        const bin = path.join(toolsDir, 'sdsio-server');
        const binWin32 = `${bin}.exe`;
        const serverBinary = fs.existsSync(binWin32) ? binWin32 : bin;
        if (!fs.existsSync(serverBinary)) {
            diagnostics?.error(DiagnosticSource.Server, `SDSIO server binary not found at expected location: ${serverBinary}`);
            return undefined;
        }
        return serverBinary;
    }

    private resolveServerBinary(basePath: string): string | undefined {
        return SdsioServerLauncher.resolveServerBinary(basePath, this.diagnostics);
    }
}
