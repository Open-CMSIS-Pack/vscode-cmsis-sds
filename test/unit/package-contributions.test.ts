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

type SchemaContribution = {
    fileMatch: string[];
    url: string;
};

describe('package.json contributions for merged explorer/flags UI', () => {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
        extensionDependencies: string[];
        activationEvents: string[];
        contributes: {
            walkthroughs: Array<{
                id: string;
                title: string;
                description: string;
                steps: Array<{
                    id: string;
                    description: string;
                    media: { image: string; altText: string };
                    completionEvents: string[];
                }>;
            }>;
            commands: CommandContribution[];
            configuration: { properties: Record<string, unknown> };
            views: Record<string, Array<{ id: string }>>;
            yamlValidation: SchemaContribution[];
            'json.schemas'?: SchemaContribution[];
            menus: {
                'view/item/context': MenuContribution[];
            };
        };
    };

    it.each(['arm-sds.viewer', 'arm-sds.mediaViewer'])('activates when VS Code restores %s', viewType => {
        expect(packageJson.activationEvents).toContain(`onWebviewPanel:${viewType}`);
    });

    it('contributes an SDS walkthrough with working command references and packaged images', () => {
        const walkthrough = packageJson.contributes.walkthroughs.find(entry => entry.id === 'arm-sds.getStarted');
        expect(walkthrough).toBeDefined();
        expect(walkthrough?.title).toBe('Get Started with Arm SDS');
        expect(walkthrough?.description).toBeTruthy();
        const steps = walkthrough!.steps;
        expect(steps.map(step => step.id)).toEqual([
            'openData', 'metadata', 'media', 'configuration', 'recordAndPlay', 'export',
        ]);
        const commands = new Set(packageJson.contributes.commands.map(command => command.command));

        for (const step of steps) {
            const links = [...step.description.matchAll(/\]\(command:([^)]+)\)/g)];
            expect(links.length).toBeGreaterThan(0);
            for (const link of links) {
                expect(commands.has(link[1])).toBe(true);
            }
            expect(step.completionEvents.length).toBeGreaterThan(0);
            for (const event of step.completionEvents) {
                expect(event.startsWith('onCommand:')).toBe(true);
                expect(commands.has(event.slice('onCommand:'.length))).toBe(true);
            }
            expect(step.media.altText).toBeTruthy();
            expect(fs.existsSync(path.join(process.cwd(), step.media.image))).toBe(true);
        }

        expect(steps[0].description).toContain('(command:arm-sds.openViewer)');
    });

    it('contributes a user-only monitor port with valid TCP port bounds', () => {
        expect(packageJson.contributes.configuration.properties['cmsis-sds.sdsio.monitorPort']).toEqual(expect.objectContaining({
            type: 'integer',
            default: 6060,
            minimum: 1,
            maximum: 65535,
            scope: 'machine',
        }));
    });

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

    it('contributes SDS YAML schemas through the YAML extension contract', () => {
        expect(packageJson.extensionDependencies).toContain('redhat.vscode-yaml');
        expect(packageJson.contributes['json.schemas']).toBeUndefined();
        expect(packageJson.contributes.yamlValidation).toEqual([
            {
                fileMatch: [
                    '**/*.sds.yml',
                    '**/*.sds.yaml',
                ],
                url: './schema/sds.schema.json',
            },
            {
                fileMatch: [
                    '**/*.sdsio.yml',
                    '**/*.sdsio.yaml',
                ],
                url: './schema/sdsio.schema.json',
            },
        ]);
    });
});
