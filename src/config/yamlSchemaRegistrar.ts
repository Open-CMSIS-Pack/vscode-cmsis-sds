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

import * as path from 'path';
import * as vscode from 'vscode';

export async function registerYamlSchemas(context: vscode.ExtensionContext): Promise<void> {
    try {
        const yamlConfig = vscode.workspace.getConfiguration('yaml');
        const rawSchemas = yamlConfig.get<unknown>('schemas');
        const schemaMap = rawSchemas && typeof rawSchemas === 'object' && !Array.isArray(rawSchemas)
            ? { ...(rawSchemas as Record<string, string | string[]>) }
            : {};

        const sdsSchemaUrl = vscode.Uri.file(path.join(context.extensionPath, 'schema', 'sds.schema.json')).toString();
        const sdsioSchemaUrl = vscode.Uri.file(path.join(context.extensionPath, 'schema', 'sdsio.schema.json')).toString();
        const sdsMatches = ['**/*.sds.yml', '**/*.sds.yaml'];
        const sdsioMatches = ['**/*.sdsio.yml', '**/*.sdsio.yaml'];

        const removeMatches = (value: string | string[] | undefined, patterns: string[]): string[] => {
            const items = Array.isArray(value)
                ? value
                : typeof value === 'string'
                    ? [value]
                    : [];
            return items.filter((entry) => !patterns.includes(entry));
        };

        let removedConflicts = false;

        // Remove target file globs from any competing schema mapping first.
        for (const key of Object.keys(schemaMap)) {
            if (key === sdsSchemaUrl || key === sdsioSchemaUrl) {
                continue;
            }

            const before = schemaMap[key];
            const cleaned = removeMatches(schemaMap[key], [...sdsMatches, ...sdsioMatches]);
            if (cleaned.length === 0) {
                delete schemaMap[key];
                if (before !== undefined) {
                    removedConflicts = true;
                }
            } else {
                schemaMap[key] = cleaned;
                const beforeList = Array.isArray(before)
                    ? before
                    : typeof before === 'string'
                        ? [before]
                        : [];
                if (cleaned.length !== beforeList.length) {
                    removedConflicts = true;
                }
            }
        }

        const ensureMapping = (schemaUrl: string, fileMatches: string[]): boolean => {
            const current = schemaMap[schemaUrl];
            const currentMatches = Array.isArray(current)
                ? current
                : typeof current === 'string'
                    ? [current]
                    : [];
            const merged = [...currentMatches];
            for (const match of fileMatches) {
                if (!merged.includes(match)) {
                    merged.push(match);
                }
            }
            if (merged.length === currentMatches.length) {
                return false;
            }
            schemaMap[schemaUrl] = merged;
            return true;
        };

        const changedSds = ensureMapping(sdsSchemaUrl, sdsMatches);
        const changedSdsio = ensureMapping(sdsioSchemaUrl, sdsioMatches);

        if (removedConflicts || changedSds || changedSdsio) {
            await yamlConfig.update('schemas', schemaMap, vscode.ConfigurationTarget.Workspace);
        }
    } catch (err) {
        console.warn(`[CMSIS SDS] YAML schema registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}
