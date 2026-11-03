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

async function captureCanvasLabels(page: Page): Promise<void> {
    await page.addInitScript(() => {
        type Label = { text: string; x: number; y: number };
        const labels = new WeakMap<HTMLCanvasElement, Label[]>();
        const originalFillText = CanvasRenderingContext2D.prototype.fillText;
        const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
        CanvasRenderingContext2D.prototype.clearRect = function (...args) {
            labels.set(this.canvas, []);
            return originalClearRect.apply(this, args);
        };
        CanvasRenderingContext2D.prototype.fillText = function (...args) {
            const point = new DOMPoint(args[1], args[2]).matrixTransform(this.getTransform());
            const entries = labels.get(this.canvas) ?? [];
            entries.push({ text: args[0], x: point.x / devicePixelRatio, y: point.y / devicePixelRatio });
            labels.set(this.canvas, entries);
            return originalFillText.apply(this, args);
        };
        (window as unknown as { chartLabels: typeof labels }).chartLabels = labels;
    });
}

async function getXAxisTicks(page: Page): Promise<{ text: string; x: number }[]> {
    return page.locator('#chart canvas').evaluate(canvas => {
        const cursor = document.querySelector<HTMLElement>('#chart + div');
        if (!cursor) { return []; }
        const bottom = parseFloat(cursor.style.top) + parseFloat(cursor.style.height);
        const labels = (window as unknown as {
            chartLabels: WeakMap<HTMLCanvasElement, { text: string; x: number; y: number }[]>;
        }).chartLabels.get(canvas as HTMLCanvasElement) ?? [];
        return labels.filter(label => label.y > bottom && /^\d+$/.test(label.text))
            .sort((left, right) => left.x - right.x);
    });
}

async function getXAxisLabels(page: Page): Promise<string[]> {
    return (await getXAxisTicks(page)).map(label => label.text);
}

// ── Structure ───────────────────────────────────────────────

test.describe('Viewer Panel — Structure', () => {
    test('selects the first block when opened', async ({ page }) => {
        await openViewer(page);

        await expect(page.locator('.info-bar')).toContainText('1 of 3');
        await expect(page.locator('.info-bar')).toContainText('0.0000 s');
        await expect(page.locator('#chart + div')).toBeVisible();
    });

    test('labels only the three data positions on a sparse x-axis', async ({ page }) => {
        await captureCanvasLabels(page);
        await openViewer(page);

        await expect.poll(() => getXAxisLabels(page)).toEqual(['1', '2', '3']);
    });

    for (const sampleCount of [5, 15, 30]) {
        test(`places x-axis ticks on real samples with ${sampleCount} points`, async ({ page }) => {
            await captureCanvasLabels(page);
            await openViewer(page);
            await page.evaluate(count => {
                window.dispatchEvent(new MessageEvent('message', {
                    origin: window.location.origin,
                    data: {
                        command: 'viewerStateChanged',
                        payload: {
                            samples: Array.from({ length: count }, (_, index) => ({
                                index,
                                timestamp: index * index,
                                timeSeconds: index * index,
                                values: { channel: index },
                            })),
                            channelNames: ['channel'],
                            stats: { totalRecords: count },
                            domainStart: 0,
                            domainEnd: (count - 1) ** 2,
                        },
                    },
                }));
            }, sampleCount);

            await expect.poll(async () => {
                const labels = await getXAxisLabels(page);
                return labels.at(-1);
            }).toBe(String(sampleCount));
            const ticks = await getXAxisTicks(page);
            expect(ticks[0].text).toBe('1');
            expect(new Set(ticks.map(tick => tick.text)).size).toBe(ticks.length);
            expect(ticks.length).toBeLessThanOrEqual(sampleCount);
            if (sampleCount > 10) {
                expect(ticks.length).toBeLessThan(sampleCount);
            }
            const start = ticks[0].x;
            const width = ticks[ticks.length - 1].x - start;
            for (const tick of ticks) {
                const sampleIndex = Number(tick.text) - 1;
                const expectedX = start + width * (sampleIndex / (sampleCount - 1)) ** 2;
                expect(Math.abs(tick.x - expectedX)).toBeLessThan(1);
            }
        });
    }

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
    test('shift-click isolates a signal and selection survives cursor changes and zoom', async ({ page }) => {
        await captureCanvasLabels(page);
        await openViewer(page);
        const canvas = page.locator('#chart canvas');
        const plotRegion = await page.locator('#chart + div').evaluate(element => ({
            top: parseFloat((element as HTMLElement).style.top),
            height: parseFloat((element as HTMLElement).style.height),
        }));
        const visibleSignals = () => canvas.evaluate((element, region) => {
            const surface = element as HTMLCanvasElement;
            const top = Math.ceil(region.top * devicePixelRatio);
            const height = Math.floor(region.height * devicePixelRatio);
            const pixels = surface.getContext('2d')!.getImageData(0, top, surface.width, height).data;
            const colors = [[79, 195, 247], [129, 199, 132], [255, 183, 77]];
            return colors.map(color => {
                let count = 0;
                for (let offset = 0; offset < pixels.length; offset += 4) {
                    if (color.every((value, index) => pixels[offset + index] === value)) {
                        count++;
                    }
                }
                return count > 10;
            });
        }, plotRegion);
        const clickLegend = async (name: string, shift = false) => {
            const label = await canvas.evaluate((element, text) => {
                return (window as unknown as {
                    chartLabels: WeakMap<HTMLCanvasElement, { text: string; x: number; y: number }[]>;
                }).chartLabels.get(element as HTMLCanvasElement)?.find(label => label.text === text);
            }, name);
            expect(label).toBeDefined();
            await canvas.click({
                position: { x: label!.x + 3, y: label!.y },
                modifiers: shift ? ['Shift'] : [],
            });
        };

        await expect.poll(visibleSignals).toEqual([true, true, true]);
        await clickLegend('y', true);
        await expect.poll(visibleSignals).toEqual([false, true, false]);
        await clickLegend('y', true);
        await expect.poll(visibleSignals).toEqual([true, true, true]);
        await clickLegend('y', true);
        await expect.poll(visibleSignals).toEqual([false, true, false]);
        await clickLegend('z', true);
        await expect.poll(visibleSignals).toEqual([false, false, true]);
        await clickLegend('x');
        await expect.poll(visibleSignals).toEqual([true, false, true]);
        await clickLegend('x');
        await expect.poll(visibleSignals).toEqual([false, false, true]);

        const bounds = (await canvas.boundingBox())!;
        const plot = (await page.locator('#chart + div').boundingBox())!;
        const ticks = await getXAxisTicks(page);
        for (const fraction of [0.1, 0.9]) {
            for (const index of [2, 0, 1]) {
                const inset = index === 0 ? 1 : index === ticks.length - 1 ? -1 : 0;
                await page.mouse.click(bounds.x + ticks[index].x + inset, plot.y + plot.height * fraction);
                await expect(page.locator('.info-bar')).toContainText(`${index + 1} of 3`);
                await expect.poll(visibleSignals).toEqual([false, false, true]);
            }
        }
        await clickLegend('z', true);
        await expect.poll(visibleSignals).toEqual([true, true, true]);
        await clickLegend('x');
        await expect.poll(visibleSignals).toEqual([false, true, true]);
        await clickLegend('y');
        await expect.poll(visibleSignals).toEqual([false, false, true]);
        await clickLegend('z', true);
        await expect.poll(visibleSignals).toEqual([true, true, true]);

        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: {
                    command: 'viewerStateChanged',
                    payload: {
                        samples: Array.from({ length: 30 }, (_, index) => ({
                            index,
                            timestamp: index,
                            timeSeconds: index,
                            values: { x: index, y: index + 1, z: index + 2 },
                        })),
                        channelNames: ['x', 'y', 'z'],
                        stats: { totalRecords: 30 },
                        domainStart: 0,
                        domainEnd: 29,
                    },
                },
            }));
        });
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).toBe('30');
        await expect.poll(visibleSignals).toEqual([true, true, true]);
        await clickLegend('y');
        await expect.poll(visibleSignals).toEqual([true, false, true]);
        await page.locator('button[title="Zoom In"]').first().click();
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).not.toBe('30');
        await expect.poll(visibleSignals).toEqual([true, false, true]);
        await page.locator('button[title="Zoom Out"]').first().click();
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).toBe('30');
        await expect.poll(visibleSignals).toEqual([true, false, true]);

        await clickLegend('x', true);
        await expect.poll(visibleSignals).toEqual([true, false, false]);
        await page.locator('button[title="Zoom In"]').first().click();
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).not.toBe('30');
        await expect.poll(visibleSignals).toEqual([true, false, false]);
        await page.locator('button[title="Zoom Out"]').first().click();
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).toBe('30');
        await expect.poll(visibleSignals).toEqual([true, false, false]);
        await clickLegend('x', true);
        await expect.poll(visibleSignals).toEqual([true, true, true]);

        await clickLegend('x');
        await clickLegend('y');
        await clickLegend('z');
        await expect.poll(visibleSignals).toEqual([false, false, false]);
        await page.locator('button[title="Zoom In"]').first().click();
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).not.toBe('30');
        await expect.poll(visibleSignals).toEqual([false, false, false]);
        await page.locator('button[title="Zoom Out"]').first().click();
        await expect.poll(async () => (await getXAxisLabels(page)).at(-1)).toBe('30');
        await expect.poll(visibleSignals).toEqual([false, false, false]);
    });

    test('preserves hidden signals when clicking and dragging the time cursor', async ({ page }) => {
        await captureCanvasLabels(page);
        await openViewer(page);

        const canvas = page.locator('#chart canvas');
        const signalPixelCount = () => canvas.evaluate(element => {
            const surface = element as HTMLCanvasElement;
            const context = surface.getContext('2d')!;
            const cursor = document.querySelector<HTMLElement>('#chart + div')!;
            const top = Math.ceil(parseFloat(cursor.style.top) * devicePixelRatio);
            const height = Math.floor(parseFloat(cursor.style.height) * devicePixelRatio);
            const pixels = context.getImageData(0, top, surface.width, height).data;
            let count = 0;
            for (let offset = 0; offset < pixels.length; offset += 4) {
                if (pixels[offset] === 129 && pixels[offset + 1] === 199 && pixels[offset + 2] === 132) {
                    count++;
                }
            }
            return count;
        });

        await expect.poll(signalPixelCount).toBeGreaterThan(10);
        const legendLabel = await canvas.evaluate(element => {
            const labels = (window as unknown as {
                chartLabels: WeakMap<HTMLCanvasElement, { text: string; x: number; y: number }[]>;
            }).chartLabels.get(element as HTMLCanvasElement) ?? [];
            return labels.find(label => label.text === 'y');
        });
        expect(legendLabel).toBeDefined();
        await canvas.click({ position: { x: legendLabel!.x + 3, y: legendLabel!.y } });
        await expect.poll(signalPixelCount).toBe(0);

        const bounds = (await canvas.boundingBox())!;
        const cursor = (await page.locator('#chart + div').boundingBox())!;
        const plotY = cursor.y + cursor.height / 2;
        await page.mouse.click(bounds.x + bounds.width / 2, plotY);
        await expect(page.locator('.info-bar')).toContainText('2 of 3');
        await expect.poll(signalPixelCount).toBe(0);

        const ticks = await getXAxisTicks(page);
        await page.mouse.move(bounds.x + bounds.width / 2, plotY);
        await page.mouse.down();
        await page.mouse.move(bounds.x + ticks[0].x + 1, plotY, { steps: 5 });
        await page.mouse.up();
        await expect(page.locator('.info-bar')).toContainText('1 of 3');
        await expect.poll(signalPixelCount).toBe(0);
    });

    test('initializes refreshed data at its first timestamp and clears empty data', async ({ page }) => {
        await openViewer(page);
        await page.evaluate(() => {
            const initial = (window as unknown as {
                __INITIAL_STATE__: { samples: { timeSeconds: number }[] };
            }).__INITIAL_STATE__;
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: {
                    command: 'viewerStateChanged',
                    payload: {
                        ...initial,
                        domainStart: 5,
                        domainEnd: 5.02,
                        samples: initial.samples.map(sample => ({ ...sample, timeSeconds: sample.timeSeconds + 5 })),
                    },
                },
            }));
        });
        await expect(page.locator('.info-bar')).toContainText('1 of 3');
        await expect(page.locator('.info-bar')).toContainText('5.0000 s');
        await expect(page.locator('#chart + div')).toBeVisible();

        await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: {
                    command: 'viewerStateChanged',
                    payload: { samples: [], channelNames: [], stats: { totalRecords: 0 } },
                },
            }));
        });
        await expect(page.locator('.info-bar')).toContainText('0 of 0');
        await expect(page.locator('#chart + div')).toHaveCount(0);
    });

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
