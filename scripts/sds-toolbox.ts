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
import { ArchiveFileAsset, GitHubReleaseAsset, GitHubWorkflowAsset } from '@open-cmsis-pack/vsce-helper';
import type { Asset, VsceTarget } from '@open-cmsis-pack/vsce-helper';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const platforms: Partial<Record<VsceTarget, string>> = {
    'win32-x64': 'windows-amd64',
    'linux-x64': 'linux-amd64',
    'linux-arm64': 'linux-arm64',
    'darwin-arm64': 'darwin-arm64',
};

export function toolboxPlatform(target: VsceTarget) {
    const platform = platforms[target];
    if (!platform) {
        throw new Error(`SDS-Toolbox is not available for target ${target}`);
    }
    return {
        directory: `sds-toolbox-${platform}`,
        extension: platform.startsWith('windows-') ? 'zip' : 'tar.gz',
    };
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toolboxNightlyPattern(target: VsceTarget): RegExp {
    const { directory, extension } = toolboxPlatform(target);
    return new RegExp(`^${directory}-v.+\\.${escapeRegex(extension)}$`);
}

// upload-artifact's archive:false uploads the platform archive itself, not a ZIP wrapper.
export class ToolboxWorkflowAsset extends GitHubWorkflowAsset {
    override async copyTo(dest?: string): Promise<string> {
        const { artifact } = await this.lastWorkflowRunArtifact;
        const directory = dest === undefined ? await this.mkTempDir() : await this.mkDest(dest);
        return this.downloadArtifact(artifact.id, path.join(directory, path.basename(artifact.name)));
    }
}

export class ToolboxBinariesAsset extends ArchiveFileAsset {
    constructor(subject: Asset, private readonly directory: string) {
        super(subject);
    }

    override async copyTo(dest?: string): Promise<string> {
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sds-toolbox-'));
        try {
            await super.copyTo(temporary);
            const bin = path.join(temporary, this.directory, 'bin');
            const server = this.directory.includes('-windows-') ? 'sdsio-server.exe' : 'sdsio-server';
            if (!(await fs.stat(path.join(bin, server))).isFile()) {
                throw new Error(`Missing SDSIO server in ${this.directory}/bin`);
            }
            const destination = await this.mkDest(dest);
            await fs.cp(bin, destination, { recursive: true });
            return destination;
        } finally {
            await fs.rm(temporary, { recursive: true, force: true });
        }
    }
}

export function toolboxReleaseAsset(target: VsceTarget, owner: string, repo: string, reference: string, token?: string): Asset {
    const { directory, extension } = toolboxPlatform(target);
    const version = reference.replace(/^v/, '');
    const asset = new GitHubReleaseAsset(owner, repo, new RegExp(`^v?(${escapeRegex(version)})$`),
        `${directory}-v${version}.${extension}`, { token });
    return new ToolboxBinariesAsset(asset, directory);
}

export function toolboxWorkflowAsset(target: VsceTarget, owner: string, repo: string, workflow: string, token?: string): Asset {
    const { directory } = toolboxPlatform(target);
    const asset = new ToolboxWorkflowAsset(owner, repo, `${workflow}.yml`, toolboxNightlyPattern(target), { token });
    return new ToolboxBinariesAsset(asset, directory);
}
