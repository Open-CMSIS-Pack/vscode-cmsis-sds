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
import * as path from 'path';
import { describe, expect, it } from 'vitest';

type CommandContribution = {
    command: string;
    enablement?: string;
};

type MenuContribution = {
    command: string;
    when?: string;
};

describe('package.json contributions for merged explorer/flags UI', () => {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        contributes: {
            commands: CommandContribution[];
            views: Record<string, Array<{ id: string }>>;
            menus: {
                'view/item/context': MenuContribution[];
            };
        };
    };

    it('contributes only the sdsExplorer view in the Arm SDS container', () => {
        const views = packageJson.contributes.views['arm-sds-explorer'];
        expect(views.map((v) => v.id)).toEqual(['sdsExplorer']);
    });

    it('contributes disconnect command with canDisconnect enablement', () => {
        const disconnect = packageJson.contributes.commands.find((c) => c.command === 'arm-sds.sdsinterface.disconnect');
        expect(disconnect).toBeDefined();
        expect(disconnect?.enablement).toBe('arm-sds.sdsio.canDisconnect');
    });

    it('shows SDSIO commands in the view title menu and relies on command enablement', () => {
        const menu = (packageJson.contributes.menus as Record<string, MenuContribution[]>)['view/title'];
        const commandContributions = new Map(packageJson.contributes.commands.map((command) => [command.command, command]));
        const expectedCommands = [
            'arm-sds.sdsinterface.play',
            'arm-sds.sdsinterface.record',
            'arm-sds.sdsinterface.stop',
            'arm-sds.sdsinterface.connect',
            'arm-sds.sdsinterface.disconnect',
        ];

        for (const command of expectedCommands) {
            const menuItem = menu.find((m) => m.command === command);
            expect(menuItem).toBeDefined();
            expect(menuItem?.when).toContain('view == sdsExplorer');
            expect(commandContributions.get(command)?.enablement).toBeDefined();
        }

        expect(commandContributions.get('arm-sds.sdsinterface.play')?.enablement).toBe('arm-sds.sdsio.canPlay');
        expect(commandContributions.get('arm-sds.sdsinterface.record')?.enablement).toBe('arm-sds.sdsio.canRecord');
        expect(commandContributions.get('arm-sds.sdsinterface.stop')?.enablement).toBe('arm-sds.sdsio.canStop');
        expect(commandContributions.get('arm-sds.sdsinterface.connect')?.enablement).toBe('arm-sds.sdsio.canConnect');
        expect(commandContributions.get('arm-sds.sdsinterface.disconnect')?.enablement).toBe('arm-sds.sdsio.canDisconnect');
    });
});
