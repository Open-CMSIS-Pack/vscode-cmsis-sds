#!/usr/bin/env npx tsx

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

import { Downloadable, Downloader } from '@open-cmsis-pack/vsce-helper';
import { toolboxReleaseAsset, toolboxWorkflowAsset } from './sds-toolbox.js';
import { PackageJson } from 'type-fest';
import process from 'node:process';

type CmsisPackageJson = PackageJson & {
    cmsis: {
        sdsio?: string;
        sdsioNightly?: string;
    };
};

function splitGitReference(reference: string, owner: string, repo: string) {
    if (reference.includes('@')) {
        const parts = reference.split('@');
        reference = parts[1];
        const repoAndOwner = parts[0].split('/');
        repo = repoAndOwner[1];
        owner = repoAndOwner[0];
    }
    return { repo, owner, reference };
}

const sdsio: Downloadable = new Downloadable(
    'SDS-Toolbox', '',
    async (target) => {
        const json = await downloader.getPackageJson<CmsisPackageJson>();
        const reqVersion = json?.cmsis?.sdsio;
        if (reqVersion === undefined) {
            console.warn('No SDSIO version specified in package.json');
            return undefined;
        }
        // Here, reference is expected to be a release asset version
        const { repo, owner, reference } = splitGitReference(reqVersion, 'ARM-software', 'SDS-Framework');
        return toolboxReleaseAsset(target, owner, repo, reference, process.env.GITHUB_TOKEN);
    },
);


const sdsioNightly: Downloadable = new Downloadable(
    'SDS-Toolbox', '',
    async (target) => {
        const json = await downloader.getPackageJson<CmsisPackageJson>();
        const workflow = json?.cmsis?.sdsioNightly;
        if (workflow === undefined) {
            console.warn('No SDSIO \'Nightly\' workflow specified in package.json (<repo>@<workflowname>)');
            return undefined;
        }
        // Here, reference is expected to be the name of the workflow yml file without file ending
        const { repo, owner, reference } = splitGitReference(workflow, 'ARM-software', 'SDS-Framework');
        return toolboxWorkflowAsset(target, owner, repo, reference, process.env.GITHUB_TOKEN);
    },
);


// If no arguments are provided to the downloader script, all assets are downloaded
// in the order they are listed. In that case, 'sdsio' will overwrite 'sdsioNightly'.
const downloader = new Downloader({
    sdsioNightly,
    sdsio
});

await downloader
    .withCacheDir(await downloader.defaultCacheDir())
    .run();
