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
    test('metadata frequency updates preserve the canvas, zoom, and playback position', async ({ page }) => {
        await page.clock.install();
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');
        await page.clock.pauseAt(new Date());
        const updateFrequency = (interval: string) => page.evaluate(frequency => {
            const initial = (window as unknown as { __INITIAL_STATE__: { image: Record<string, unknown> } }).__INITIAL_STATE__;
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: { command: 'viewerStateChanged', reset: false, payload: { ...initial, image: { ...initial.image, interval: frequency } } },
            }));
        }, interval);
        await updateFrequency('1');
        await page.locator('button[title="Next Frame"]').click();
        await page.locator('button[title="Zoom In"]').first().click();
        const canvas = page.locator('canvas').first();
        await canvas.evaluate(element => { (element as HTMLCanvasElement).dataset.instance = 'retained'; });
        const style = await canvas.getAttribute('style');
        await page.locator('.controls button').first().click();
        await page.clock.runFor(200);
        await expect(page.locator('.info-bar')).toContainText('2 of 3');
        await updateFrequency('4');
        await page.clock.runFor(200);
        await expect(page.locator('.info-bar')).toContainText('2 of 3');
        await page.clock.runFor(100);
        await expect(page.locator('.info-bar')).toContainText('3 of 3');
        await expect(canvas).toHaveAttribute('data-instance', 'retained');
        await expect(canvas).toHaveAttribute('style', style!);
    });

    test('structural metadata updates reject frame responses from the previous viewer', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');
        const requests = () => page.evaluate(() => (
            window as unknown as { __messages: { command?: string; requestId?: number }[] }
        ).__messages.filter(message => message.command === 'requestMediaFrameWindow').map(message => message.requestId!));
        await expect.poll(async () => (await requests()).length).toBeGreaterThan(0);
        const previousRequestId = (await requests()).at(-1)!;
        await page.evaluate(() => {
            const initial = (window as unknown as { __INITIAL_STATE__: { image: Record<string, unknown> } }).__INITIAL_STATE__;
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: { command: 'viewerStateChanged', reset: true, payload: { ...initial, image: { ...initial.image, frames: [] } } },
            }));
        });
        await expect.poll(async () => (await requests()).at(-1)!).toBeGreaterThan(previousRequestId);
        const currentRequestId = (await requests()).at(-1)!;
        const sendFrame = (requestId: number, red: number, green: number) => page.evaluate(({ id, redValue, greenValue }) => {
            const pixels = new Uint8Array(4 * 4 * 4);
            for (let offset = 0; offset < pixels.length; offset += 4) {
                pixels.set([redValue, greenValue, 0, 255], offset);
            }
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: {
                    command: 'mediaFrameWindowData', requestId: id,
                    payload: { mediaType: 'image', rangeStart: 0, rangeEnd: 1, quality: 'low', frames: [{ timestamp: 0, rgbaBase64: btoa(String.fromCharCode(...pixels)) }] },
                },
            }));
        }, { id: requestId, redValue: red, greenValue: green });
        const firstPixel = () => page.locator('canvas').first().evaluate(element => Array.from(
            (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data
        ));
        await sendFrame(currentRequestId, 255, 0);
        await expect.poll(firstPixel).toEqual([255, 0, 0, 255]);
        await sendFrame(previousRequestId, 0, 255);
        await expect.poll(firstPixel).toEqual([255, 0, 0, 255]);
    });

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

    test('playback stops and resets to the first frame', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('.controls');

        const playButton = page.locator('.controls button').first();
        await playButton.click();

        await expect(playButton).toContainText('Play');
        await expect(page.locator('.info-bar')).toContainText('1 of 3');

        const broadcasts = await page.evaluate(() => {
            return (window as unknown as { __messages: Array<{ type?: string; playbackState?: string; timeStamp?: number }> }).__messages
                .filter(message => message.type === 'broadcast');
        });
        expect(broadcasts.at(-1)).toMatchObject({ playbackState: 'stopped', timeStamp: 0 });
    });

    test('late frame windows cannot repaint the image after playback resets', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');
        const canvas = page.locator('canvas');
        const initialPixels = await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL());
        await page.locator('.controls button').first().click();
        await expect.poll(() => page.evaluate(() => {
            return (window as unknown as { __messages: Array<{ playbackState?: string }> }).__messages
                .some(message => message.playbackState === 'stopped');
        })).toBe(true);
        await expect(page.locator('.info-bar')).toContainText('1 of 3');

        const requestId = await page.evaluate(() => {
            return (window as unknown as { __messages: Array<{ command?: string; requestId?: number }> }).__messages
                .filter(message => message.command === 'requestMediaFrameWindow').at(-1)!.requestId!;
        });
        const sendWindow = async (responseId: number, rangeStart: number, color: number) => {
            await page.evaluate(async ({ responseId, rangeStart, color }) => {
                const rgba = new Uint8Array(4 * 4 * 4).fill(color);
                window.dispatchEvent(new MessageEvent('message', {
                    origin: window.location.origin,
                    data: {
                        command: 'mediaFrameWindowData',
                        requestId: responseId,
                        payload: {
                            mediaType: 'image', rangeStart, rangeEnd: rangeStart + 1, quality: 'high',
                            frames: [{ timestamp: rangeStart * 0.1, rgbaBase64: btoa(String.fromCharCode(...rgba)) }],
                        },
                    },
                }));
                await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
            }, { responseId, rangeStart, color });
        };

        await sendWindow(requestId - 1, 0, 100);
        expect(await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())).toBe(initialPixels);
        await sendWindow(requestId, 2, 200);
        expect(await canvas.evaluate(element => (element as HTMLCanvasElement).toDataURL())).toBe(initialPixels);
        await expect(page.locator('.info-bar')).toContainText('1 of 3');
        await expect(page.locator('.ant-slider-handle')).toHaveAttribute('aria-valuenow', '0');
        await expect(page.locator('.controls button').first()).toContainText('Play');

        const resetRequestId = await page.evaluate(() => {
            return (window as unknown as { __messages: Array<{ command?: string; requestId?: number }> }).__messages
                .filter(message => message.command === 'requestMediaFrameWindow').at(-1)!.requestId!;
        });
        await sendWindow(resetRequestId, 0, 255);
        await expect.poll(() => canvas.evaluate(element => {
            return Array.from((element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data);
        })).toEqual([255, 255, 255, 255]);
    });

    test('playback buffers at the loaded edge and coalesces delayed window requests', async ({ page }) => {
        await page.addInitScript(() => {
            let initialState: unknown;
            Object.defineProperty(window, '__INITIAL_STATE__', {
                get: () => initialState,
                set: (state: { image: { frames: Array<{ timestamp: number; rgbaBase64: string }>; totalFrames: number; interval: string } }) => {
                    state.image.frames = Array.from({ length: 32 }, (_, frameIndex) => ({
                        timestamp: frameIndex * 0.1,
                        rgbaBase64: btoa(String.fromCharCode(...Uint8Array.from({ length: 64 }, (_, byteIndex) => byteIndex % 4 === 3 ? 255 : frameIndex))),
                    }));
                    state.image.totalFrames = 136;
                    state.image.interval = '10';
                    initialState = state;
                },
            });
        });
        await page.clock.install();
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');
        await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1)));
        await page.locator('.controls button').first().click();
        await page.clock.runFor(3500);
        const selectedIndex = Number(await page.locator('.ant-slider-handle').getAttribute('aria-valuenow'));
        expect(selectedIndex).toBe(31);

        const outstandingRequests = await page.evaluate(() => {
            return (window as unknown as { __messages: Array<{ command?: string }> }).__messages
                .filter(message => message.command === 'requestMediaFrameWindow').length;
        });
        expect(outstandingRequests).toBe(1);

        await page.evaluate(() => {
            const requests = (window as unknown as {
                __messages: Array<{ command?: string; requestId?: number }>;
            }).__messages.filter(message => message.command === 'requestMediaFrameWindow');
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: {
                    command: 'mediaFrameWindowData',
                    requestId: requests[0].requestId,
                    payload: {
                        mediaType: 'image', rangeStart: 12, rangeEnd: 44, quality: 'low',
                        frames: Array.from({ length: 32 }, (_, localIndex) => ({
                            timestamp: (12 + localIndex) * 0.1,
                            rgbaBase64: btoa(String.fromCharCode(...Uint8Array.from({ length: 64 }, (_, byteIndex) => byteIndex % 4 === 3 ? 255 : 12 + localIndex))),
                        })),
                    },
                },
            }));
        });
        await page.clock.runFor(32);
        await expect.poll(() => page.locator('canvas').evaluate(element => {
            return (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[0];
        })).toBe(selectedIndex);
        await expect(page.locator('.info-bar')).toContainText(`${(selectedIndex * 0.1).toFixed(4)}s`);
        await page.clock.runFor(100);
        await expect(page.locator('.ant-slider-handle')).toHaveAttribute('aria-valuenow', '32');
        await expect(page.locator('.info-bar')).toContainText('3.2000s');
    });

    test('camera-sized playback completes with bounded delayed windows', async ({ page }) => {
        await page.addInitScript(() => {
            let initialState: unknown;
            Object.defineProperty(window, '__INITIAL_STATE__', {
                get: () => initialState,
                set: (state: { image: { frames: unknown[]; width: number; height: number; totalFrames: number; interval: string } }) => {
                    Object.assign(state.image, { frames: [], width: 416, height: 416, totalFrames: 136, interval: '25' });
                    initialState = state;
                },
            });
        });
        await page.clock.install();
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('canvas');
        await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1)));
        await page.evaluate(() => {
            type WindowRequest = {
                command?: string;
                requestId?: number;
                payload?: { centerIndex: number; windowSize: number; quality: string };
            };
            const messages = (window as unknown as { __messages: WindowRequest[] }).__messages;
            const respond = (message: WindowRequest) => {
                if (message.command !== 'requestMediaFrameWindow' || !message.payload) { return; }
                const { centerIndex, windowSize, quality } = message.payload;
                const rangeStart = Math.max(0, Math.min(centerIndex - Math.floor(windowSize / 2), 136 - windowSize));
                setTimeout(() => {
                    window.dispatchEvent(new MessageEvent('message', {
                        origin: window.location.origin,
                        data: {
                            command: 'mediaFrameWindowData', requestId: message.requestId,
                            payload: {
                                mediaType: 'image', rangeStart, rangeEnd: rangeStart + windowSize, quality,
                                frames: Array.from({ length: windowSize }, (_, localIndex) => {
                                    const absoluteIndex = rangeStart + localIndex;
                                    return {
                                        timestamp: absoluteIndex / 25,
                                        rgbaBase64: btoa(String.fromCharCode(absoluteIndex, absoluteIndex, absoluteIndex, 255).repeat(416 * 416)),
                                    };
                                }),
                            },
                        },
                    }));
                }, 120);
            };
            messages.forEach(respond);
            messages.push = (...newMessages) => {
                const count = Array.prototype.push.apply(messages, newMessages);
                newMessages.forEach(respond);
                return count;
            };
        });
        await page.clock.runFor(200);
        await page.locator('.controls button').first().click();
        await page.clock.runFor(3000);
        expect(Number(await page.locator('.ant-slider-handle').getAttribute('aria-valuenow'))).toBeGreaterThan(40);
        await page.clock.runFor(7000);
        await expect(page.locator('.controls button').first()).toContainText('Play');
        await expect(page.locator('.ant-slider-handle')).toHaveAttribute('aria-valuenow', '0');
        await expect.poll(() => page.locator('canvas').evaluate(element => {
            return (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[0];
        })).toBe(0);
        const windowSizes = await page.evaluate(() => {
            return (window as unknown as { __messages: Array<{ command?: string; payload?: { windowSize: number } }> }).__messages
                .filter(message => message.command === 'requestMediaFrameWindow').map(message => message.payload!.windowSize);
        });
        expect(windowSizes.length).toBeGreaterThan(1);
        expect(Math.max(...windowSizes)).toBeLessThanOrEqual(12);
    });

    test('Space toggles playback', async ({ page }) => {
        await page.goto(`${baseUrl}/image`);
        await page.waitForSelector('.controls');

        const playButton = page.locator('.controls button').first();
        await page.locator('.media-page').focus();
        await page.keyboard.press('Space');

        await expect(playButton).toContainText('Pause');
        await page.keyboard.press('Space');
        await expect(playButton).toContainText('Play');
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
        await expect(page.locator('button[title="Fit to Window"]').first()).toBeVisible();
    });

    test('zoom buttons work without errors', async ({ page }) => {
        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('canvas');

        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(err.message));

        await page.locator('button[title="Zoom In"]').first().click();
        await page.locator('button[title="Zoom Out"]').first().click();
        await page.locator('button[title="Fit to Window"]').first().click();

        expect(errors).toEqual([]);
    });

    test('plays only samples in the visible range after zooming', async ({ page }) => {
        await page.addInitScript(() => {
            const audioEvents = { bufferLengths: [] as number[], stopCount: 0 };
            Object.assign(window, { __audioEvents: audioEvents });

            class AudioContextMock {
                public readonly state = 'running';
                public readonly destination = {};

                public createBuffer(_channels: number, length: number) {
                    audioEvents.bufferLengths.push(length);
                    return { copyToChannel: () => undefined };
                }

                public createBufferSource() {
                    return {
                        buffer: null,
                        connect: () => undefined,
                        disconnect: () => undefined,
                        onended: null,
                        start: () => undefined,
                        stop: () => audioEvents.stopCount++,
                    };
                }

                public resume() {
                    return Promise.resolve();
                }

                public close() {
                    return Promise.resolve();
                }
            }

            Object.assign(window, { AudioContext: AudioContextMock });
        });

        await page.goto(`${baseUrl}/audio`);
        await page.waitForSelector('canvas');

        await page.locator('button[title="Zoom In"]').first().click();
        await page.keyboard.press('Space');

        await expect.poll(() => page.evaluate(() => (
            window as Window & { __audioEvents: { bufferLengths: number[] } }
        ).__audioEvents.bufferLengths.at(-1))).toBe(801);

        await page.locator('button[title="Zoom In"]').first().click();

        await expect.poll(() => page.evaluate(() => (
            window as Window & { __audioEvents: { stopCount: number } }
        ).__audioEvents.stopCount)).toBe(1);
        await expect(page.locator('button[title="Play Visible Range"]')).toContainText('Play');
        await page.keyboard.press('Space');
        await expect(page.locator('button[title="Pause"]')).toBeVisible();
        await page.evaluate(() => {
            const initial = (window as unknown as { __INITIAL_STATE__: { audio: Record<string, unknown> } }).__INITIAL_STATE__;
            window.dispatchEvent(new MessageEvent('message', {
                origin: window.location.origin,
                data: { command: 'viewerStateChanged', reset: false, payload: { ...initial, audio: { ...initial.audio, sampleRate: 32000 } } },
            }));
        });
        await expect.poll(() => page.evaluate(() => (
            window as Window & { __audioEvents: { stopCount: number } }
        ).__audioEvents.stopCount)).toBe(2);
        await expect(page.locator('button[title="Play Visible Range"]')).toContainText('Play');
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
