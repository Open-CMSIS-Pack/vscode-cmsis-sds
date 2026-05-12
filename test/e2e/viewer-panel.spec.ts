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

/**
 * Playwright E2E tests for the SDS Viewer webview panel.
 *
 * Tests toolbar buttons, canvas rendering, channel toggles,
 * and message sending (export, etc).
 */

import { test, expect, Page } from '@playwright/test';
import { startServer } from './helpers/webview-server';
import * as http from 'http';

let server: http.Server;
let baseUrl: string;

test.beforeAll(async () => {
    const result = await startServer();
    server = result.server;
    baseUrl = result.baseUrl;
});

test.afterAll(async () => {
    server.close();
});

async function openViewer(page: Page): Promise<void> {
    await page.goto(`${baseUrl}/viewer`);
    await page.waitForSelector('#chart');
}

async function getMessages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__messages);
}

// ── Structure ───────────────────────────────────────────────

test.describe('Viewer Panel — Structure', () => {
    test('toolbar buttons exist', async ({ page }) => {
        await openViewer(page);

        await expect(page.locator('button[title="Zoom In"]').first()).toBeVisible();
        await expect(page.locator('button[title="Zoom Out"]').first()).toBeVisible();
        await expect(page.locator('button[title="Fit to Window"]').first()).toBeVisible();
        await expect(page.locator('button[title="Export CSV"]')).toBeVisible();
    });

    test('chart canvas is rendered', async ({ page }) => {
        await openViewer(page);

        const canvas = page.locator('#chart');
        await expect(canvas).toBeVisible();

        // Canvas should have non-zero dimensions
        const box = await canvas.boundingBox();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);
    });

    test('channel toggle buttons are created from data', async ({ page }) => {
        await openViewer(page);

        await expect(page.getByRole('button', { name: 'x', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'y', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'z', exact: true })).toBeVisible();
    });

    test('stats bar displays file info', async ({ page }) => {
        await openViewer(page);

        await expect(page.getByText('Records', { exact: true })).toBeVisible();
        await expect(page.getByText('Duration', { exact: true })).toBeVisible();
        await expect(page.getByText('Data Rate', { exact: true })).toBeVisible();
    });
});

// ── Interactions ────────────────────────────────────────────

test.describe('Viewer Panel — Interactions', () => {
    test('Export button sends exportCsv message', async ({ page }) => {
        await openViewer(page);
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.locator('button[title="Export CSV"]').click();

        const msgs = await getMessages(page);
        expect(msgs.some((m: any) => m.command === 'exportCsv')).toBe(true);
    });

    test('channel toggle buttons can be clicked', async ({ page }) => {
        await openViewer(page);

        const firstToggle = page.getByRole('button', { name: 'x', exact: true });
        await expect(firstToggle).toBeVisible();

        const beforeStyle = await firstToggle.getAttribute('style');
        await firstToggle.click();
        const afterFirstClickStyle = await firstToggle.getAttribute('style');
        expect(afterFirstClickStyle).not.toBe(beforeStyle);

        await firstToggle.click();
        const afterSecondClickStyle = await firstToggle.getAttribute('style');
        expect(afterSecondClickStyle).toBe(beforeStyle);
    });

    test('zoom buttons are clickable without errors', async ({ page }) => {
        await openViewer(page);

        // These should not throw — just verify no console errors
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        await page.locator('button[title="Zoom In"]').first().click();
        await page.locator('button[title="Zoom Out"]').first().click();
        await page.locator('button[title="Fit to Window"]').first().click();

        expect(errors).toEqual([]);
    });
});

// ── Experimental features hidden by default ─────────────────

test.describe('Viewer Panel — Experimental', () => {
    test('filter and FFT buttons are hidden when experimental=false', async ({ page }) => {
        await openViewer(page);

        const filterBtn = page.getByRole('button', { name: /filter/i });
        const fftBtn = page.getByRole('button', { name: /fft/i });
        const statsBtn = page.getByRole('button', { name: /stats/i });

        await expect(filterBtn).toHaveCount(0);
        await expect(fftBtn).toHaveCount(0);
        await expect(statsBtn).toHaveCount(0);
    });
});
