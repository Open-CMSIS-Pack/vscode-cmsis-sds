/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * SdsioConfigManager
 *
 * Central manager for the active .sdsio.yml configuration file.
 * Responsibilities:
 *  - Parse the active file (workdir, metadir, flag-info).
 *  - Watch the file for external content changes and re-parse automatically.
 *  - Write individual flag-name changes back to the YAML file.
 *  - Notify subscribers via `onDidChangeConfig` on any state change.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const MAX_FLAG_INFO_FLAGS = 8;

export interface SdsioConfigData {
    /** Resolved absolute path to workdir, or undefined if not set in the file. */
    readonly workdir: string | undefined;
    /** Resolved absolute path to metadir, or undefined if not set in the file. */
    readonly metadir: string | undefined;
    /** Custom labels for flags 0-7.  Missing indices fall back to the numeric default. */
    readonly flagNames: ReadonlyMap<number, string>;
}

export class SdsioConfigManager {
    private readonly _onDidChangeConfigFile = new vscode.EventEmitter<void>();
    private readonly _onDidChangeConfig = new vscode.EventEmitter<void>();
    /** Fired whenever the active config path or its parsed content changes. */
    readonly onDidChangeConfigFile: vscode.Event<void> = this._onDidChangeConfigFile.event;
    readonly onDidChangeConfig: vscode.Event<void> = this._onDidChangeConfig.event;

    private activeConfigPath: string | undefined;
    private parsedData: SdsioConfigData = emptyConfig();
    private contentWatcher: vscode.FileSystemWatcher | undefined;
    /** Suppress the FS-change event that we ourselves trigger on write-back. */
    private suppressNextContentChange = false;

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Switch to a new active configuration file.
     * Passing `undefined` (or a path that does not exist) deactivates the config.
     */
    setConfigFile(configPath: string | undefined): void {
        this.contentWatcher?.dispose();
        this.contentWatcher = undefined;

        const resolvedPath = configPath && fs.existsSync(configPath) ? configPath : undefined;
        this.activeConfigPath = resolvedPath;

        if (resolvedPath) {
            this.parsedData = parseConfigFile(resolvedPath);

            // Watch only this exact file for content changes (create/delete handled elsewhere).
            const watchPattern = new vscode.RelativePattern(
                vscode.Uri.file(path.dirname(resolvedPath)),
                path.basename(resolvedPath)
            );
            this.contentWatcher = vscode.workspace.createFileSystemWatcher(watchPattern, true, false, true);
            this.contentWatcher.onDidChange(() => {
                if (this.suppressNextContentChange) {
                    this.suppressNextContentChange = false;
                    return;
                }
                if (this.activeConfigPath) {
                    this.parsedData = parseConfigFile(this.activeConfigPath);
                    this._onDidChangeConfig.fire();
                }
            });
        } else {
            this.parsedData = emptyConfig();
        }

        this._onDidChangeConfig.fire();
        this._onDidChangeConfigFile.fire();
    }

    /** Returns the absolute path of the currently active config, or undefined. */
    getConfigFile(): string | undefined {
        return this.activeConfigPath;
    }

    /** Returns the most recently parsed configuration data. */
    getConfig(): SdsioConfigData {
        return this.parsedData;
    }

    /**
     * Persist a single flag label to the active .sdsio.yml file.
     *
     * Passing `undefined`, an empty string, or the numeric default (`String(index)`)
     * removes the entry.  When no custom labels remain, the entire `flag-info:`
     * section is removed from the file.
     *
     * Does nothing when no configuration file is active.
     * Fires `onDidChangeConfig` after the in-memory cache is updated.
     */
    setFlagName(index: number, name: string | undefined): void {
        if (!this.activeConfigPath) {
            return;
        }

        const names = new Map(this.parsedData.flagNames);
        const trimmedName = name?.trim() ?? '';
        const isDefault = trimmedName === '' || trimmedName === String(index);

        if (isDefault) {
            names.delete(index);
        } else {
            names.set(index, trimmedName);
        }

        // Update in-memory state first so consumers see it immediately.
        this.parsedData = { ...this.parsedData, flagNames: names };

        try {
            const raw = fs.readFileSync(this.activeConfigPath, 'utf-8');
            const updated = updateFlagInfoSection(raw, names);
            this.suppressNextContentChange = true;
            fs.writeFileSync(this.activeConfigPath, updated, 'utf-8');
        } catch {
            this.suppressNextContentChange = false;
        }

        this._onDidChangeConfig.fire();
    }

    dispose(): void {
        this.contentWatcher?.dispose();
        this._onDidChangeConfig.dispose();
        this._onDidChangeConfigFile.dispose();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyConfig(): SdsioConfigData {
    return { workdir: undefined, metadir: undefined, flagNames: new Map() };
}

function parseConfigFile(configPath: string): SdsioConfigData {
    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const lines = raw.split(/\r?\n/);
        const configDir = path.dirname(configPath);

        let workdirValue: string | undefined;
        let metadirValue: string | undefined;
        const flagNames = new Map<number, string>();

        let inFlagInfo = false;
        let flagInfoIndent = -1;

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith('#')) {
                continue;
            }

            if (!inFlagInfo) {
                const wm = line.match(/^(\s*)workdir\s*:\s*(.+?)\s*(?:#.*)?$/);
                if (wm) { workdirValue = normalizeYamlScalar(wm[2]); }

                const mm = line.match(/^(\s*)metadir\s*:\s*(.+?)\s*(?:#.*)?$/);
                if (mm) { metadirValue = normalizeYamlScalar(mm[2]); }

                const fm = line.match(/^(\s*)flag-info\s*:/);
                if (fm) {
                    inFlagInfo = true;
                    flagInfoIndent = fm[1].length;
                }
            } else {
                const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
                if (indent <= flagInfoIndent) {
                    inFlagInfo = false;
                    // Still process this line for top-level keys.
                    const wm = line.match(/^(\s*)workdir\s*:\s*(.+?)\s*(?:#.*)?$/);
                    if (wm) { workdirValue = normalizeYamlScalar(wm[2]); }
                    const mm = line.match(/^(\s*)metadir\s*:\s*(.+?)\s*(?:#.*)?$/);
                    if (mm) { metadirValue = normalizeYamlScalar(mm[2]); }
                    continue;
                }

                // Parse list items of the form:  - 0: Label text
                const item = line.match(/^\s*-\s*(\d+)\s*:\s*(.+?)\s*(?:#.*)?$/);
                if (item) {
                    const idx = parseInt(item[1], 10);
                    const label = item[2].trim();
                    if (idx >= 0 && idx < MAX_FLAG_INFO_FLAGS && label) {
                        flagNames.set(idx, label);
                    }
                }
            }
        }

        return {
            workdir: workdirValue ? path.resolve(configDir, workdirValue) : undefined,
            metadir: metadirValue ? path.resolve(configDir, metadirValue) : undefined,
            flagNames,
        };
    } catch {
        return emptyConfig();
    }
}

function normalizeYamlScalar(value: string): string {
    const trimmed = value.trim().replace(/\s+#.*$/, '').trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('\'') && trimmed.endsWith('\''))) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}

/**
 * Rewrite the `flag-info:` block inside a YAML string.
 *
 * - names empty, no block   → return raw unchanged
 * - names empty, block exists → remove entire block (header + items)
 * - names non-empty, block exists → replace item lines, keep header
 * - names non-empty, no block → append new block after the last content line
 */
function updateFlagInfoSection(raw: string, names: ReadonlyMap<number, string>): string {
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.split(/\r?\n/);

    // Drop the trailing empty element that split() adds after a final newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    let headerIdx = -1;
    let headerIndent = 0;
    let itemStart = -1;
    let blockEnd = -1; // first line index after the block

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (headerIdx < 0) {
            const m = line.match(/^(\s*)flag-info\s*:/);
            if (m) {
                headerIdx = i;
                headerIndent = m[1].length;
            }
            continue;
        }

        // Blank lines inside the block don't end it.
        if (line.trim() === '') { continue; }

        const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
        if (indent <= headerIndent) {
            blockEnd = i;
            break;
        }
        if (itemStart < 0) { itemStart = i; }
    }

    if (headerIdx >= 0 && blockEnd < 0) {
        blockEnd = lines.length; // block runs to end-of-file
    }

    // Build replacement item lines.
    const itemIndent = ' '.repeat(headerIndent + 2);
    const newItems: string[] = [];
    for (let i = 0; i < MAX_FLAG_INFO_FLAGS; i++) {
        const label = names.get(i);
        if (label !== undefined) {
            newItems.push(`${itemIndent}- ${i}: ${label}`);
        }
    }

    let result: string[];

    if (headerIdx < 0) {
        if (names.size === 0) { return raw; }
        // Append new block at end-of-file (indent to match sibling keys at level 2).
        result = [...lines, '  flag-info:', ...newItems];
    } else if (names.size === 0) {
        // Remove the entire block.
        result = [...lines.slice(0, headerIdx), ...lines.slice(blockEnd)];
    } else {
        // Replace only the item lines; preserve the header line.
        const replaceStart = itemStart >= 0 ? itemStart : headerIdx + 1;
        result = [
            ...lines.slice(0, replaceStart),
            ...newItems,
            ...lines.slice(blockEnd),
        ];
    }

    return result.join(eol) + eol;
}
