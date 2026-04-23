/*
 * Copyright (c) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Playwright E2E tests for the SDS Media Viewer webview panel.
 *
 * Tests image, audio, and video sub-viewers:
 *  - Canvas rendering
 *  - Frame navigation (prev/next/slider)
 *  - Play/pause for video
 *  - Toolbar buttons
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

async function clickSliderAt(page: Page, sliderLocator: string, ratio: number) {
    const slider = page.locator(sliderLocator).first();
    await expect(slider).toBeVisible();
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    if (!box) {
        return;
    }

    const x = box.x + Math.max(2, Math.min(box.width - 2, box.width * ratio));
    const y = box.y + box.height / 2;
    await page.mouse.click(x, y);
}

// ── Image Viewer ────────────────────────────────────────────

test.describe('Media Viewer — Image', () => {
    test('canvas renders at correct dimensions', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');

        const canvas = page.locator('canvas').first();
        await expect(canvas).toBeVisible();

        const width = await canvas.getAttribute('width');
        const height = await canvas.getAttribute('height');
        expect(width).toBe('4');
        expect(height).toBe('4');
    });

    test('frame navigation buttons exist', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');

        await expect(page.locator('button[title="Previous Frame"]')).toBeVisible();
        await expect(page.locator('button[title="Next Frame"]')).toBeVisible();
        await expect(page.locator('.ant-slider')).toBeVisible();
    });

    test('frame info shows current frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('.info-bar');

        const info = await page.locator('.info-bar').textContent();
        expect(info).toContain('1 of 3');
    });

    test('clicking Next advances frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');

        await page.click('button[title="Next Frame"]');

        const info = await page.locator('.info-bar').textContent();
        expect(info).toContain('2 of 3');
    });

    test('clicking Prev goes back', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');

        // Go forward then back
        await page.click('button[title="Next Frame"]');
        await page.click('button[title="Previous Frame"]');

        const info = await page.locator('.info-bar').textContent();
        expect(info).toContain('1 of 3');
    });

    test('slider changes frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');

        await clickSliderAt(page, '.controls .ant-slider', 0.95);

        const info = await page.locator('.info-bar').textContent();
        expect(info).toContain('3 of 3');
    });

    test('toolbar zoom buttons exist', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');

        await expect(page.locator('button[title="Zoom In"]').first()).toBeVisible();
        await expect(page.locator('button[title="Zoom Out"]').first()).toBeVisible();
        await expect(page.locator('button[title="Fit to Window"]').first()).toBeVisible();
    });
});

// ── Audio Viewer ────────────────────────────────────────────

test.describe('Media Viewer — Audio', () => {
    test('waveform canvas renders', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('canvas');

        const canvas = page.locator('canvas').first();
        await expect(canvas).toBeVisible();

        const box = await canvas.boundingBox();
        expect(box!.width).toBeGreaterThan(0);
        expect(box!.height).toBeGreaterThan(0);
    });

    test('toolbar buttons exist', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('canvas');

        await expect(page.locator('button[title="Zoom In"]').first()).toBeVisible();
        await expect(page.locator('button[title="Zoom Out"]').first()).toBeVisible();
        await expect(page.locator('button[title="Fit"]').first()).toBeVisible();
    });

    test('zoom buttons work without errors', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('canvas');

        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        await page.locator('button[title="Zoom In"]').first().click();
        await page.locator('button[title="Zoom Out"]').first().click();
        await page.locator('button[title="Fit"]').first().click();

        expect(errors).toEqual([]);
    });
});

// ── Video Viewer ────────────────────────────────────────────

test.describe('Media Viewer — Video', () => {
    test('canvas renders at correct dimensions', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('canvas');

        const canvas = page.locator('canvas').first();
        await expect(canvas).toBeVisible();

        const width = await canvas.getAttribute('width');
        const height = await canvas.getAttribute('height');
        expect(width).toBe('4');
        expect(height).toBe('4');
    });

    test('play button exists and shows Play initially', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('.controls');

        const playBtn = page.locator('.controls button').first();
        await expect(playBtn).toBeVisible();
        const text = await playBtn.textContent();
        expect(text).toContain('Play');
    });

    test('clicking Play toggles to Pause', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('.controls');

        await page.locator('.controls button').first().click();

        const text = await page.locator('.controls button').first().textContent();
        expect(text).toContain('Pause');

        // Click again to pause
        await page.locator('.controls button').first().click();
        const text2 = await page.locator('.controls button').first().textContent();
        expect(text2).toContain('Play');
    });

    test('frame navigation works', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('canvas');

        const info1 = await page.locator('.info-bar').textContent();
        expect(info1).toContain('1 of 5');

        await page.locator('.controls button').nth(2).click();
        const info2 = await page.locator('.info-bar').textContent();
        expect(info2).toContain('2 of 5');

        await page.locator('.controls button').nth(2).click();
        await page.locator('.controls button').nth(2).click();
        const info4 = await page.locator('.info-bar').textContent();
        expect(info4).toContain('4 of 5');

        await page.locator('.controls button').nth(1).click();
        const info3 = await page.locator('.info-bar').textContent();
        expect(info3).toContain('3 of 5');
    });

    test('Next stops playback', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('.controls');

        // Start playing
        await page.locator('.controls button').first().click();
        const playing = await page.locator('.controls button').first().textContent();
        expect(playing).toContain('Pause');

        // Click Next — should stop playback
        await page.locator('.controls button').nth(2).click();
        const stopped = await page.locator('.controls button').first().textContent();
        expect(stopped).toContain('Play');
    });

    test('slider updates frame display', async ({ page }) => {
        await page.goto(`${baseUrl}/video`);
        await page.waitForSelector('canvas');

        await clickSliderAt(page, '.controls .ant-slider', 0.75);

        const info = await page.locator('.info-bar').textContent();
        expect(info).toContain('4 of 5');
    });
});
