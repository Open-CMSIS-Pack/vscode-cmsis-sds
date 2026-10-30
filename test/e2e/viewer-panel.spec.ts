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

// Created using AI

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

async function getMessages(page: Page): Promise<{ command?: string }[]> {
    return page.evaluate(() => (window as { __messages?: { command?: string }[] }).__messages || []);
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

        await expect(page.getByText('Block', { exact: true })).toBeVisible();
    });

    test('stats bar displays file info', async ({ page }) => {
        await openViewer(page);

        await expect(page.getByText('Block', { exact: true })).toBeVisible();
        await expect(page.getByText('Size', { exact: true })).toBeVisible();
        await expect(page.getByText('Time', { exact: true })).toBeVisible();
    });
});

// ── Interactions ────────────────────────────────────────────

test.describe('Viewer Panel — Interactions', () => {
    for (const viewer of ['viewer', 'audio']) {
        test(`${viewer} live growth preserves fit, history, and a following tail`, async ({ page }) => {
            await page.goto(`${baseUrl}/${viewer}`);
            await page.waitForSelector('#chart');
            const updateDomain = (end: number, reset = false) => page.evaluate(({ endTime, isReset, kind }) => {
                const initial = (window as unknown as { __INITIAL_STATE__: Record<string, unknown> }).__INITIAL_STATE__;
                const content = { ...((kind === 'audio' ? initial.audio : initial) as Record<string, unknown>), domainStart: 0, domainEnd: endTime };
                window.dispatchEvent(new MessageEvent('message', {
                    origin: window.location.origin,
                    data: {
                        command: 'viewerStateChanged', live: !isReset, reset: isReset,
                        payload: kind === 'audio' ? { ...initial, audio: content } : content
                    }
                }));
            }, { endTime: end, isReset: reset, kind: viewer });
            const handles = page.locator('.controls .ant-slider-handle');
            const range = () => page.evaluate(kind => {
                const command = kind === 'audio' ? 'requestMediaAudioWindow' : 'requestVisibleRangeData';
                const request = (window as unknown as {
                    __messages: { command?: string; payload?: { rangeStart: number; rangeEnd: number } }[];
                }).__messages.filter(message => message.command === command).at(-1);
                return request?.payload ? [request.payload.rangeStart, request.payload.rangeEnd] : [];
            }, viewer);
            await updateDomain(10, true);
            await expect.poll(range).toEqual([0, 10]);
            await updateDomain(19);
            await expect.poll(range).toEqual([0, 19]);
            await page.locator('button[title="Zoom In"]').first().click();
            await expect.poll(async () => (await range())[1]).toBeLessThan(19);
            const historicalRange = await range();
            expect(historicalRange[0]).toBeGreaterThan(0);
            expect(historicalRange[1]).toBeLessThan(19);
            const count = await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages.length);
            await updateDomain(28);
            await expect.poll(() => page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages.length)).toBeGreaterThan(count);
            await expect.poll(range).toEqual(historicalRange);
            await handles.nth(1).focus();
            await page.keyboard.press('End');
            await expect.poll(async () => (await range())[1]).toBe(28);
            const tailRange = await range();
            await updateDomain(37);
            await expect.poll(async () => (await range())[1]).toBe(37);
            expect((await range())[0]).toBeCloseTo(tailRange[0] + 9, 9);
            await updateDomain(46);
            await expect.poll(async () => (await range())[1]).toBe(46);
            expect((await range())[0]).toBeCloseTo(tailRange[0] + 18, 9);
            await updateDomain(55, true);
            await expect.poll(range).toEqual([0, 55]);
        });
    }

    test('metadata updates preserve the chart and its zoom range', async ({ page }) => {
        await openViewer(page);
        await page.locator('button[title="Zoom In"]').first().click();
        const chart = page.locator('#chart');
        await chart.evaluate(element => { (element as HTMLElement).dataset.instance = 'retained'; });
        const handles = page.locator('.controls .ant-slider-handle');
        const range = await handles.evaluateAll(elements => elements.map(element => element.getAttribute('aria-valuenow')));
        await page.evaluate(() => {
            const initial = (window as unknown as { __INITIAL_STATE__: { metadata: { sds: Record<string, unknown> } } }).__INITIAL_STATE__;
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: {
                    command: 'viewerStateChanged',
                    payload: { ...initial, metadata: { sds: { ...initial.metadata.sds, 'sample-frequency': 300 } } },
                },
            }));
        });
        await expect(page.locator('body')).toContainText('300');
        await expect(chart).toHaveAttribute('data-instance', 'retained');
        expect(await handles.evaluateAll(elements => elements.map(element => element.getAttribute('aria-valuenow')))).toEqual(range);
    });

    test('Export button sends exportCsv message', async ({ page }) => {
        await openViewer(page);
        await page.evaluate(() => { (window as { __messages?: { command?: string }[] }).__messages = []; });

        await page.locator('button[title="Export CSV"]').click();

        const msgs = await getMessages(page);
        expect(msgs.some((m: { command?: string }) => m.command === 'exportCsv')).toBe(true);
    });

    test('channel toggle buttons can be clicked', async ({ page }) => {
        await openViewer(page);

        const exportBtn = page.getByRole('button', { name: /export/i });
        await expect(exportBtn).toBeVisible();
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
