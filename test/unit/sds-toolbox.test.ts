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

// generated with AI
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GitHubReleaseAsset, GitHubWorkflowAsset, LocalFileAsset } from '@open-cmsis-pack/vsce-helper';
import type { VsceTarget } from '@open-cmsis-pack/vsce-helper';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ToolboxBinariesAsset, ToolboxWorkflowAsset, toolboxNightlyPattern,
    toolboxPlatform, toolboxReleaseAsset, toolboxWorkflowAsset,
} from '../../scripts/sds-toolbox';

const targets = [
    ['win32-x64', 'windows-amd64', 'zip'],
    ['linux-x64', 'linux-amd64', 'tar.gz'],
    ['linux-arm64', 'linux-arm64', 'tar.gz'],
    ['darwin-arm64', 'darwin-arm64', 'tar.gz'],
] as const;

let temporary: string;
beforeEach(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sds-toolbox-test-'));
});
afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(temporary, { recursive: true, force: true });
});

async function fixture(target: VsceTarget, version = 'v3.2.0', missingServer = false) {
    const { directory, extension } = toolboxPlatform(target);
    const names = ['sds-check', 'sds-convert', 'sds-view', ...(missingServer ? [] : ['sdsio-server'])]
        .map(name => target === 'win32-x64' ? `${name}.exe` : name);
    const archive = path.join(temporary, `${directory}-${version}.${extension}`);
    const fixtureName = missingServer ? 'missing-server.tar.gz' : `${directory.replace('sds-toolbox-', '')}.${extension}`;
    await fs.copyFile(path.join(process.cwd(), 'test', 'unit', 'fixtures', 'sds-toolbox', fixtureName), archive);
    return { archive, names, directory };
}

describe('SDS-Toolbox assets', () => {
    it.each(targets)('maps %s to its native platform', (target, platform, extension) => {
        expect(toolboxPlatform(target)).toEqual({ directory: `sds-toolbox-${platform}`, extension });
        const pattern = toolboxNightlyPattern(target);
        expect(pattern.test(`sds-toolbox-${platform}-v3.1.0-14-g1ad0188.${extension}`)).toBe(true);
        expect(pattern.test(`sds-toolbox-${platform}-v3.2.0.${extension}`)).toBe(true);
        expect(pattern.test(`sds-toolbox-${platform}-v3.2.0.${extension}.sha256`)).toBe(false);
        expect(pattern.test(`sds-toolbox-other-v3.2.0.${extension}`)).toBe(false);
        expect(pattern.test(`sdsio-server-${platform}-3.2.0.zip`)).toBe(false);
    });

    it.each(['win32-arm64', 'darwin-x64'] as const)('rejects unsupported %s', target => {
        expect(() => toolboxReleaseAsset(target, 'owner', 'repo', '3.2.0')).toThrow(`not available for target ${target}`);
        expect(() => toolboxWorkflowAsset(target, 'owner', 'repo', 'workflow')).toThrow(`not available for target ${target}`);
    });

    it.each(targets)('installs all release binaries flat for %s', async (target, platform, extension) => {
        const { archive, names } = await fixture(target);
        vi.spyOn(GitHubReleaseAsset.prototype, 'copyTo').mockResolvedValue(archive);
        const asset = toolboxReleaseAsset(target, 'owner', 'repo', '3.2.0', 'test-token');
        expect(asset).toMatchObject({ subject: {
            owner: 'owner', repo: 'repo', assetName: `sds-toolbox-${platform}-v3.2.0.${extension}`,
            options: { token: 'test-token' },
        } });
        const destination = path.join(temporary, 'tools');
        const mkdtemp = vi.spyOn(fs, 'mkdtemp');
        try {
            expect(await asset.copyTo(destination)).toBe(destination);
            const extracted = await mkdtemp.mock.results[0].value;
            await expect(fs.stat(extracted)).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await fs.readdir(destination)).sort()).toEqual(names.sort());
            for (const name of names) {
                expect(await fs.readFile(path.join(destination, name), 'utf8')).toBe(`fixture ${name}`);
                if (process.platform !== 'win32' && target !== 'win32-x64') {
                    expect((await fs.stat(path.join(destination, name))).mode & 0o111).toBe(0o111);
                }
            }
        } finally {
            await asset.dispose();
        }
    });

    it('normalizes a v-prefixed release and matches only that version', () => {
        const asset = toolboxReleaseAsset('linux-x64', 'owner', 'repo', 'v3.2.0');
        expect(asset).toMatchObject({ subject: {
            assetName: 'sds-toolbox-linux-amd64-v3.2.0.tar.gz',
            tag: /^v?(3\.2\.0)$/,
        } });
    });

    it.each(targets)('downloads and extracts raw nightly archives for %s', async (target) => {
        const { archive, names } = await fixture(target, 'v3.1.0-14-g1ad0188');
        const filename = path.basename(archive);
        const download = vi.fn(async (id: number, destination: string) => {
            expect(id).toBe(42);
            expect(path.basename(destination)).toBe(filename);
            await fs.copyFile(archive, destination);
            return destination;
        });
        class FixtureWorkflowAsset extends ToolboxWorkflowAsset {
            protected override get lastWorkflowRunArtifact() {
                return Promise.resolve({ artifact: { id: 42, name: filename }, run: { id: 123 } }) as
                    GitHubWorkflowAsset['lastWorkflowRunArtifact'];
            }
            protected override downloadArtifact(id: number, destination: string) {
                return download(id, destination);
            }
        }
        const source = new FixtureWorkflowAsset('owner', 'repo', 'build_sds-toolbox.yml', toolboxNightlyPattern(target));
        const asset = new ToolboxBinariesAsset(source, toolboxPlatform(target).directory);
        const cache = vi.spyOn(source, 'withCacheDir');
        asset.withCacheDir(path.join(temporary, 'cache'));
        expect(cache).toHaveBeenCalledWith(path.join(temporary, 'cache'));
        expect(await asset.version).toBe('build_sds-toolbox.yml@123');
        try {
            const destination = await asset.copyTo(path.join(temporary, 'tools'));
            expect((await fs.readdir(destination)).sort()).toEqual(names.sort());
            expect(download).toHaveBeenCalledOnce();
        } finally {
            await asset.dispose();
        }
    });

    it('uses the toolbox workflow and artifact pattern', () => {
        const asset = toolboxWorkflowAsset('linux-arm64', 'owner', 'repo', 'build_sds-toolbox', 'test-token');
        expect(asset).toMatchObject({ subject: {
            owner: 'owner', repo: 'repo', workflow: 'build_sds-toolbox.yml',
            artifactName: toolboxNightlyPattern('linux-arm64'), options: { token: 'test-token' },
        } });
    });

    it('rejects incomplete archives and cleans extraction directories on failure', async () => {
        const { archive, directory } = await fixture('linux-x64', 'v3.2.0', true);
        const mkdtemp = vi.spyOn(fs, 'mkdtemp');
        const source = new LocalFileAsset(archive);
        const dispose = vi.spyOn(source, 'dispose');
        const asset = new ToolboxBinariesAsset(source, directory);
        try {
            await expect(asset.copyTo(path.join(temporary, 'tools'))).rejects.toThrow();
            const extracted = await mkdtemp.mock.results[0].value;
            await expect(fs.stat(extracted)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(fs.stat(path.join(temporary, 'tools'))).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await asset.dispose();
        }
        expect(dispose).toHaveBeenCalledOnce();
    });
});
