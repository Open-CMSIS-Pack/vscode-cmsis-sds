/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
/*
 * Copyright (C) 2025-2026 Matthias Hertel
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Playwright E2E tests for the SDS Recorder webview panel.
 *
 * Tests UI behavior: mode switching, button states, config panels,
 * message sending, and status updates via injected messages.
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

/** Navigate to the recorder panel and wait for the script to initialize. */
async function openRecorder(page: Page): Promise<void> {
    await page.goto(`${baseUrl}/recorder`);
    await page.waitForSelector('select');
}

function modeSelect(page: Page) {
    return page.locator('select').first();
}

function inputByLabel(page: Page, label: string) {
    return page.locator(`label:has-text("${label}")`).locator('xpath=../input').first();
}

/** Get the list of captured outbound messages from the webview. */
async function getMessages(page: Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__messages);
}

/** Simulate an extension→webview message. */
async function postToWebview(page: Page, msg: any): Promise<void> {
    await page.evaluate((m) => (window as any).__postToWebview(m), msg);
}

// ── Default State ───────────────────────────────────────────

test.describe('Recorder Panel — Default State', () => {
    test('USB mode selected by default, start enabled, stop disabled', async ({ page }) => {
        await openRecorder(page);

        const mode = await modeSelect(page).inputValue();
        expect(mode).toBe('usb');

        await expect(page.getByRole('button', { name: /Start Recording/i })).toBeEnabled();
        await expect(page.getByRole('button', { name: /Stop/i })).toBeDisabled();
    });

    test('status panel is hidden initially', async ({ page }) => {
        await openRecorder(page);
        await expect(page.getByText(/Recording in progress|Server running/i)).toHaveCount(0);
    });

    test('server state shows "Stopped"', async ({ page }) => {
        await openRecorder(page);
        await expect(page.getByText('Stopped', { exact: true })).toBeVisible();
    });
});

// ── Mode Switching ──────────────────────────────────────────

test.describe('Recorder Panel — Mode Switching', () => {
    test('selecting Serial shows serial config, hides others', async ({ page }) => {
        await openRecorder(page);
        await modeSelect(page).selectOption('serial');

        await expect(page.getByText('Serial Port', { exact: true })).toBeVisible();
        await expect(page.getByText('IP Address', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Stream Name', { exact: true })).toHaveCount(0);
    });

    test('selecting Socket shows socket config, hides others', async ({ page }) => {
        await openRecorder(page);
        await modeSelect(page).selectOption('socket');

        await expect(page.getByText('IP Address', { exact: true })).toBeVisible();
        await expect(page.getByText('Serial Port', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Stream Name', { exact: true })).toHaveCount(0);
    });

    test('selecting Demo shows demo config, hides others', async ({ page }) => {
        await openRecorder(page);
        await modeSelect(page).selectOption('demo');

        await expect(page.getByText('Stream Name', { exact: true })).toBeVisible();
        await expect(page.getByText('Serial Port', { exact: true })).toHaveCount(0);
        await expect(page.getByText('IP Address', { exact: true })).toHaveCount(0);
    });

    test('selecting USB hides all config panels', async ({ page }) => {
        await openRecorder(page);
        await modeSelect(page).selectOption('serial');
        await expect(page.getByText('Serial Port', { exact: true })).toBeVisible();

        await modeSelect(page).selectOption('usb');
        await expect(page.getByText('Serial Port', { exact: true })).toHaveCount(0);
        await expect(page.getByText('IP Address', { exact: true })).toHaveCount(0);
        await expect(page.getByText('Stream Name', { exact: true })).toHaveCount(0);
    });

    test('switching to Serial triggers getSerialPorts message', async ({ page }) => {
        await openRecorder(page);
        // Clear initial messages (getServerState fires on load)
        await page.evaluate(() => { (window as any).__messages = []; });

        await modeSelect(page).selectOption('serial');

        const msgs = await getMessages(page);
        const portMsg = msgs.find((m: any) => m.command === 'getSerialPorts');
        expect(portMsg).toBeDefined();
    });
});

// ── Start Recording ─────────────────────────────────────────

test.describe('Recorder Panel — Start Recording', () => {
    test('clicking Start sends startRecording with correct config', async ({ page }) => {
        await openRecorder(page);
        await inputByLabel(page, 'Output Directory').fill('./my_output');
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.getByRole('button', { name: /Start Recording/i }).click();

        const msgs = await getMessages(page);
        const startMsg = msgs.find((m: any) => m.command === 'startRecording');
        expect(startMsg).toBeDefined();
        expect(startMsg.config.mode).toBe('usb');
        expect(startMsg.config.streamName).toBeUndefined();
        expect(startMsg.config.outputDirectory).toBe('./my_output');
    });

    test('clicking Start in demo mode sends demo config', async ({ page }) => {
        await openRecorder(page);
        await modeSelect(page).selectOption('demo');
        await inputByLabel(page, 'Frequency (Hz)').fill('200');
        await inputByLabel(page, 'Channels').fill('a, b');
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.getByRole('button', { name: /Start Recording/i }).click();

        const msgs = await getMessages(page);
        const startMsg = msgs.find((m: any) => m.command === 'startRecording');
        expect(startMsg.config.mode).toBe('demo');
        expect(startMsg.config.streamName).toBe('Sensors');
        expect(startMsg.config.frequency).toBe(200);
        expect(startMsg.config.channels).toEqual(['a', 'b']);
    });
});

// ── Extension Messages (Inbound) ────────────────────────────

test.describe('Recorder Panel — Inbound Messages', () => {
    test('recordingStarted shows status panel and disables start', async ({ page }) => {
        await openRecorder(page);
        await postToWebview(page, {
            command: 'recordingStarted',
            isHardwareMode: false,
        });

        await expect(page.getByText('Recording in progress...')).toBeVisible();
        await expect(page.getByRole('button', { name: /Start Recording/i })).toBeDisabled();
        await expect(page.getByRole('button', { name: /Stop/i })).toBeEnabled();
    });

    test('recordingStopped hides status panel and resets buttons', async ({ page }) => {
        await openRecorder(page);
        // Start first
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: false });
        await expect(page.getByText('Recording in progress...')).toBeVisible();

        // Then stop
        await postToWebview(page, { command: 'recordingStopped' });

        await expect(page.getByText(/Recording in progress|Server running/i)).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Start Recording/i })).toBeEnabled();
        await expect(page.getByRole('button', { name: /Stop/i })).toBeDisabled();
    });

    test('serverStateChanged updates state indicator', async ({ page }) => {
        await openRecorder(page);

        await postToWebview(page, { command: 'serverStateChanged', state: 'waiting' });
        await expect(page.getByText('Waiting for device...', { exact: true })).toBeVisible();

        await postToWebview(page, { command: 'serverStateChanged', state: 'connected' });
        await expect(page.getByText('Device connected', { exact: true })).toBeVisible();

        await postToWebview(page, { command: 'serverStateChanged', state: 'recording' });
        await expect(page.getByText('Recording data', { exact: true })).toBeVisible();
    });

    test('serialPorts populates port dropdown', async ({ page }) => {
        await openRecorder(page);
        await modeSelect(page).selectOption('serial');

        await postToWebview(page, {
            command: 'serialPorts',
            ports: ['/dev/ttyACM0', '/dev/ttyUSB1', 'COM3'],
        });

        const options = await page.locator('label:has-text("Serial Port")').locator('xpath=../div/select/option').allTextContents();
        expect(options).toContain('/dev/ttyACM0');
        expect(options).toContain('/dev/ttyUSB1');
        expect(options).toContain('COM3');
    });

    test('serverEvent appends log entries', async ({ page }) => {
        await openRecorder(page);
        // Show log panel by starting a hardware recording
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: true });

        await postToWebview(page, {
            command: 'serverEvent',
            event: { type: 'log', message: 'Server started on port 5050' },
        });
        await postToWebview(page, {
            command: 'serverEvent',
            event: { type: 'error', message: 'Connection failed' },
        });

        await expect(page.getByText('Server started on port 5050')).toBeVisible();
        await expect(page.getByText('Connection failed')).toBeVisible();
    });

    test('recordingStatus updates stats display', async ({ page }) => {
        await openRecorder(page);
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: false });

        await postToWebview(page, {
            command: 'recordingStatus',
            recordCount: 42,
            totalBytes: 2048,
            elapsed: 5000,
        });

        const panelText = (await page.locator('body').textContent()) ?? '';
        expect(panelText).toContain('Records');
        expect(panelText).toContain('42');
        expect(panelText).toContain('2.0 KB');
    });
});

// ── Stop Recording ──────────────────────────────────────────

test.describe('Recorder Panel — Stop Recording', () => {
    test('clicking Stop sends stopRecording message', async ({ page }) => {
        await openRecorder(page);
        // Enable stop button via recordingStarted
        await postToWebview(page, { command: 'recordingStarted', isHardwareMode: false });
        await page.evaluate(() => { (window as any).__messages = []; });

        await page.getByRole('button', { name: /Stop/i }).click();

        const msgs = await getMessages(page);
        expect(msgs.some((m: any) => m.command === 'stopRecording')).toBe(true);
    });
});
