/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { ZoomInOutlined, ZoomOutOutlined, ExpandOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BroadcastMessage, getIndexedSdsSuffix, Message, SampleFrame } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';

type AudioState = {
    samples: SampleFrame[];
    sampleRate: number;
    bitDepth: number;
    channels: number;
    totalSamples: number;
    totalRecords: number;
};

type AudioViewerProps = {
    state: AudioState;
    filename?: string;
};

export function AudioViewer({ state, filename }: AudioViewerProps) {
    const { samples, sampleRate, bitDepth, channels, totalRecords } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [view, setView] = useState<{ start: number; end: number }>({ start: 0, end: 1 });
    const [isPlaying, setIsPlaying] = useState(false);
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const playbackCursorSampleRef = useRef(-1);
    const playbackStartSampleRef = useRef(0);
    const playbackLengthRef = useRef(0);
    const playbackStartedAtRef = useRef(0);
    const playbackRafRef = useRef<number | null>(null);

    const frameStartOffsets = useMemo(() => {
        const offsets: number[] = [];
        let total = 0;

        for (const frame of samples) {
            offsets.push(total);
            total += frame.samples.length;
        }

        return offsets;
    }, [samples]);

    const totalSampleCount = useMemo(() => samples.reduce((sum, frame) => sum + frame.samples.length, 0), [samples]);
    const totalDurationSeconds = useMemo(() => {
        if (samples.length === 0) {
            return 0;
        }

        const firstFrame = samples[0];
        const lastFrame = samples[samples.length - 1];
        return Math.max(0, lastFrame.timestamp + (lastFrame.samples.length / sampleRate) - firstFrame.timestamp);
    }, [sampleRate, samples]);

    const viewStartRef = useRef(0);
    const viewEndRef = useRef(1);
    const cursorRef = useRef(-1);
    const drawRef = useRef<() => void>(() => { });

    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

    const findFrameIndexForSampleIndex = (sampleIndex: number) => {
        let lo = 0;
        let hi = samples.length;

        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const frameStart = frameStartOffsets[mid];
            const frameEnd = frameStart + samples[mid].samples.length;
            if (frameEnd <= sampleIndex) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        return Math.min(lo, samples.length - 1);
    };

    const stopPlayback = (updateState = true) => {
        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
            playbackRafRef.current = null;
        }

        const source = sourceRef.current;
        if (source) {
            try {
                source.stop();
            } catch {
                // no-op: source may already be stopped.
            }
            source.disconnect();
            sourceRef.current = null;
        }

        if (updateState) {
            setIsPlaying(false);
        }

        playbackCursorSampleRef.current = -1;
        drawRef.current();
    };

    const startPlaybackTicker = () => {
        const tick = () => {
            const audioCtx = audioCtxRef.current;
            if (!audioCtx || !sourceRef.current) {
                playbackRafRef.current = null;
                return;
            }

            const elapsedSeconds = Math.max(0, audioCtx.currentTime - playbackStartedAtRef.current);
            const playedSamples = Math.floor(elapsedSeconds * sampleRate);
            const boundedPlayedSamples = Math.min(Math.max(playedSamples, 0), Math.max(playbackLengthRef.current - 1, 0));
            playbackCursorSampleRef.current = playbackStartSampleRef.current + boundedPlayedSamples;
            drawRef.current();

            playbackRafRef.current = requestAnimationFrame(tick);
        };

        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
        }
        playbackRafRef.current = requestAnimationFrame(tick);
    };

    const playVisibleRange = async () => {
        if (totalSampleCount === 0 || samples.length === 0) {
            return;
        }

        const startSample = clamp(Math.floor(viewStartRef.current * totalSampleCount), 0, Math.max(totalSampleCount - 1, 0));
        const endSample = clamp(Math.ceil(viewEndRef.current * totalSampleCount), Math.min(startSample + 1, totalSampleCount), totalSampleCount);
        const targetLength = Math.max(0, endSample - startSample);
        if (targetLength === 0) {
            return;
        }

        if (!audioCtxRef.current) {
            audioCtxRef.current = new AudioContext({ sampleRate });
        }
        const audioCtx = audioCtxRef.current;
        if (!audioCtx) {
            return;
        }
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        const pcm = new Float32Array(targetLength);
        let write = 0;
        let frameIndex = findFrameIndexForSampleIndex(startSample);
        let currentSample = startSample;

        while (frameIndex < samples.length && currentSample < endSample) {
            const frame = samples[frameIndex];
            const frameStart = frameStartOffsets[frameIndex];
            const fromOffset = Math.max(0, currentSample - frameStart);
            const toOffset = Math.min(frame.samples.length, endSample - frameStart);

            for (let offset = fromOffset; offset < toOffset; offset++) {
                pcm[write++] = frame.samples[offset];
            }

            currentSample = frameStart + toOffset;
            frameIndex += 1;
        }

        if (write === 0) {
            return;
        }

        stopPlayback(false);

        const audioBuffer = audioCtx.createBuffer(1, write, sampleRate);
        audioBuffer.copyToChannel(pcm.subarray(0, write), 0);

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        source.onended = () => {
            if (sourceRef.current === source) {
                sourceRef.current = null;
                setIsPlaying(false);
                playbackCursorSampleRef.current = -1;
                if (playbackRafRef.current !== null) {
                    cancelAnimationFrame(playbackRafRef.current);
                    playbackRafRef.current = null;
                }
                drawRef.current();
            }
        };

        playbackStartSampleRef.current = startSample;
        playbackLengthRef.current = write;
        playbackStartedAtRef.current = audioCtx.currentTime;
        playbackCursorSampleRef.current = startSample;
        sourceRef.current = source;
        setIsPlaying(true);
        source.start();
        startPlaybackTicker();
    };

    useEffect(() => {
        viewStartRef.current = view.start;
        viewEndRef.current = view.end;
        drawRef.current();
    }, [view]);

    useEffect(() => {
        return () => {
            stopPlayback(false);
            const audioCtx = audioCtxRef.current;
            if (audioCtx) {
                void audioCtx.close();
                audioCtxRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) { return; }
        const activeCanvas = canvas;

        const ctx = canvas.getContext('2d');
        if (!ctx) { return; }

        let dpr = window.devicePixelRatio || 1;
        const M = { top: 20, right: 20, bottom: 30, left: 50 };

        function clampSampleIndex(sampleIndex: number) {
            return Math.max(0, Math.min(totalSampleCount - 1, sampleIndex));
        }

        function findFrameIndexForSampleIndex(sampleIndex: number) {
            let lo = 0;
            let hi = samples.length;

            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                const frameStart = frameStartOffsets[mid];
                const frameEnd = frameStart + samples[mid].samples.length;
                if (frameEnd <= sampleIndex) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }

            return Math.min(lo, samples.length - 1);
        }

        function getVisibleSampleRange() {
            if (totalSampleCount === 0) {
                return { start: 0, end: 0, count: 0 };
            }

            const start = Math.max(0, Math.min(totalSampleCount - 1, Math.floor(viewStartRef.current * totalSampleCount)));
            const end = Math.max(start + 1, Math.min(totalSampleCount, Math.ceil(viewEndRef.current * totalSampleCount)));
            return { start, end, count: end - start };
        }

        function getTimeAtSampleIndex(sampleIndex: number) {
            if (totalSampleCount === 0) {
                return 0;
            }

            const clampedIndex = clampSampleIndex(sampleIndex);
            const frameIndex = findFrameIndexForSampleIndex(clampedIndex);
            const frame = samples[frameIndex];
            const frameStart = frameStartOffsets[frameIndex];
            const sampleOffset = clampedIndex - frameStart;
            return frame.timestamp + (sampleOffset / sampleRate);
        }

        function getTimeAtSampleBoundary(sampleIndex: number) {
            if (totalSampleCount === 0) {
                return 0;
            }

            if (sampleIndex <= 0) {
                return samples[0].timestamp;
            }

            if (sampleIndex >= totalSampleCount) {
                const lastFrame = samples[samples.length - 1];
                return lastFrame.timestamp + (lastFrame.samples.length / sampleRate);
            }

            const frameIndex = findFrameIndexForSampleIndex(sampleIndex);
            const frame = samples[frameIndex];
            const frameStart = frameStartOffsets[frameIndex];
            const sampleOffset = sampleIndex - frameStart;
            return frame.timestamp + (sampleOffset / sampleRate);
        }

        function forEachVisibleSample(startSampleIndex: number, endSampleIndex: number, callback: (value: number, sampleIndex: number) => void) {
            if (totalSampleCount === 0 || endSampleIndex <= startSampleIndex) {
                return;
            }

            let frameIndex = findFrameIndexForSampleIndex(startSampleIndex);
            let currentSampleIndex = startSampleIndex;

            while (frameIndex < samples.length && currentSampleIndex < endSampleIndex) {
                const frame = samples[frameIndex];
                const frameStart = frameStartOffsets[frameIndex];
                const fromOffset = Math.max(0, currentSampleIndex - frameStart);
                const toOffset = Math.min(frame.samples.length, endSampleIndex - frameStart);

                for (let sampleOffset = fromOffset; sampleOffset < toOffset; sampleOffset++) {
                    callback(frame.samples[sampleOffset], frameStart + sampleOffset);
                }

                currentSampleIndex = frameStart + toOffset;
                frameIndex += 1;
            }
        }

        function getNearestSampleIndexAtTimestamp(target: number) {
            if (samples.length === 0 || totalSampleCount === 0) {
                return null;
            }

            let lo = 0;
            let hi = samples.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (samples[mid].timestamp < target) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }

            const candidateFrameIndexes = new Set<number>();
            if (lo < samples.length) {
                candidateFrameIndexes.add(lo);
            }
            if (lo > 0) {
                candidateFrameIndexes.add(lo - 1);
            }

            let bestSampleIndex: number | null = null;
            let bestDelta = Number.POSITIVE_INFINITY;

            for (const frameIndex of candidateFrameIndexes) {
                const frame = samples[frameIndex];
                if (frame.samples.length === 0) {
                    continue;
                }

                const sampleOffset = Math.max(0, Math.min(frame.samples.length - 1, Math.round((target - frame.timestamp) * sampleRate)));
                const sampleTime = frame.timestamp + (sampleOffset / sampleRate);
                const delta = Math.abs(sampleTime - target);
                if (delta < bestDelta) {
                    bestDelta = delta;
                    bestSampleIndex = frameStartOffsets[frameIndex] + sampleOffset;
                }
            }

            if (bestSampleIndex !== null) {
                return bestSampleIndex;
            }

            return target <= samples[0].timestamp ? 0 : totalSampleCount - 1;
        }

        function getPlotArea() {
            const w = activeCanvas.width / dpr;
            const h = activeCanvas.height / dpr;
            return { x: M.left, y: M.top, w: w - M.left - M.right, h: h - M.top - M.bottom };
        }

        function getCanvasPoint(clientX: number, clientY: number) {
            const rect = activeCanvas.getBoundingClientRect();
            return { x: clientX - rect.left, y: clientY - rect.top };
        }

        function isPointInPlot(clientX: number, clientY: number) {
            const plot = getPlotArea();
            const point = getCanvasPoint(clientX, clientY);
            return point.x >= plot.x && point.x <= plot.x + plot.w &&
                point.y >= plot.y && point.y <= plot.y + plot.h;
        }

        function getNearestSampleIndexAtClientX(clientX: number): number | null {
            if (totalSampleCount === 0) { return null; }

            const plot = getPlotArea();
            const visibleRange = getVisibleSampleRange();
            if (visibleRange.count === 0) {
                return null;
            }

            const rect = activeCanvas.getBoundingClientRect();
            const mouseX = clientX - rect.left;
            if (mouseX < plot.x || mouseX > plot.x + plot.w) { return null; }

            const normalizedInView = (mouseX - plot.x) / plot.w;
            return clampSampleIndex(Math.round(visibleRange.start + normalizedInView * Math.max(visibleRange.count - 1, 0)));
        }

        function getCursorScreenX(): number | null {
            const cursorSampleIndex = cursorRef.current;
            if (cursorSampleIndex < 0 || cursorSampleIndex >= totalSampleCount) { return null; }

            const plot = getPlotArea();
            const visibleRange = getVisibleSampleRange();
            if (visibleRange.count === 0 || cursorSampleIndex < visibleRange.start || cursorSampleIndex >= visibleRange.end) {
                return null;
            }

            return plot.x + ((cursorSampleIndex - visibleRange.start) / Math.max(visibleRange.count - 1, 1)) * plot.w;
        }

        function updateCursorFromClientX(clientX: number) {
            const nextCursor = getNearestSampleIndexAtClientX(clientX);
            if (nextCursor === null || nextCursor === cursorRef.current) { return false; }

            cursorRef.current = nextCursor;
            broadcastMessage({
                type: 'broadcast',
                timeStamp: getTimeAtSampleIndex(nextCursor),
                fileName: filename,
            });
            drawRef.current();
            return true;
        }

        const handleMessage = (event: MessageEvent) => {
            const msg = event.data as Message;

            switch (msg.type) {
                case 'broadcast': {
                    if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix((msg as BroadcastMessage).fileName)) {
                        break;
                    }

                    const timeStamp = (msg as BroadcastMessage).timeStamp;
                    if (timeStamp === undefined || totalSampleCount === 0) {
                        break;
                    }

                    const nextCursor = getNearestSampleIndexAtTimestamp(timeStamp);
                    if (nextCursor === null || nextCursor === cursorRef.current) {
                        break;
                    }

                    cursorRef.current = nextCursor;
                    drawRef.current();
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);

        let pointerMode: 'idle' | 'cursor' | 'pan' = 'idle';
        let pointerDownX = 0;
        let dragViewStart = 0;
        let dragViewEnd = 0;

        const resize = () => {
            dpr = window.devicePixelRatio || 1;
            const rect = canvas.parentElement?.getBoundingClientRect();
            if (!rect) { return; }
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawRef.current();
        };

        drawRef.current = function draw() {
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);

            if (samples.length === 0 || totalSampleCount === 0) {
                return;
            }

            const pW = w - M.left - M.right;
            const pH = h - M.top - M.bottom;
            const visibleRange = getVisibleSampleRange();
            if (visibleRange.count === 0) {
                return;
            }

            let yMin = -1;
            let yMax = 1;
            forEachVisibleSample(visibleRange.start, visibleRange.end, (value) => {
                if (value < yMin) yMin = value;
                if (value > yMax) yMax = value;
            });

            const yPad = (yMax - yMin) * 0.1 || 0.1;
            yMin -= yPad;
            yMax += yPad;

            const xFromSampleIndex = (sampleIndex: number) => M.left + ((sampleIndex - visibleRange.start) / Math.max(visibleRange.count - 1, 1)) * pW;
            const zeroY = M.top + pH - (-yMin) / (yMax - yMin) * pH;

            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(M.left, zeroY);
            ctx.lineTo(M.left + pW, zeroY);
            ctx.stroke();

            ctx.strokeStyle = '#4fc3f7';
            ctx.lineWidth = 1;

            if (visibleRange.count > pW * 2) {
                ctx.fillStyle = '#4fc3f733';
                const binSize = visibleRange.count / pW;
                for (let px = 0; px < pW; px++) {
                    const from = visibleRange.start + Math.floor(px * binSize);
                    const to = Math.min(visibleRange.start + Math.floor((px + 1) * binSize), visibleRange.end);
                    let min = Infinity;
                    let max = -Infinity;

                    forEachVisibleSample(from, to, (value) => {
                        if (value < min) min = value;
                        if (value > max) max = value;
                    });

                    if (!Number.isFinite(min) || !Number.isFinite(max)) {
                        continue;
                    }

                    const y1 = M.top + pH - (max - yMin) / (yMax - yMin) * pH;
                    const y2 = M.top + pH - (min - yMin) / (yMax - yMin) * pH;
                    ctx.fillRect(M.left + px, y1, 1, y2 - y1);
                }
            } else {
                ctx.beginPath();
                let started = false;
                forEachVisibleSample(visibleRange.start, visibleRange.end, (value, sampleIndex) => {
                    const x = xFromSampleIndex(sampleIndex);
                    const y = M.top + pH - (value - yMin) / (yMax - yMin) * pH;
                    if (!started) {
                        ctx.moveTo(x, y);
                        started = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                });
                ctx.stroke();
            }

            const tStart = getTimeAtSampleBoundary(visibleRange.start);
            const tEnd = getTimeAtSampleBoundary(visibleRange.end);
            ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            for (let i = 0; i <= 5; i++) {
                const timeStamp = tStart + (tEnd - tStart) * i / 5;
                const px = M.left + (i / 5) * pW;
                ctx.fillText(`${timeStamp.toFixed(3)}s`, px, M.top + pH + 16);
            }

            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.strokeRect(M.left, M.top, pW, pH);

            const cursorX = getCursorScreenX();
            if (cursorX !== null) {
                ctx.strokeStyle = 'rgba(200,0,0,0.8)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(cursorX, M.top);
                ctx.lineTo(cursorX, M.top + pH);
                ctx.stroke();
            }

            const playbackSampleIndex = playbackCursorSampleRef.current;
            if (isPlaying && playbackSampleIndex >= visibleRange.start && playbackSampleIndex < visibleRange.end) {
                const playbackX = xFromSampleIndex(playbackSampleIndex);
                ctx.strokeStyle = 'rgba(64, 156, 255, 0.95)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(playbackX, M.top);
                ctx.lineTo(playbackX, M.top + pH);
                ctx.stroke();
            }
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const plot = getPlotArea();
            const ratio = Math.max(0, Math.min(1, (mouseX - plot.x) / plot.w));
            const range = viewEndRef.current - viewStartRef.current;
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            const newRange = Math.max(0.001, Math.min(1, range * factor));
            const center = viewStartRef.current + ratio * range;
            const start = Math.max(0, Math.min(1 - newRange, center - ratio * newRange));
            setView({ start, end: start + newRange });
        };

        const onMouseDown = (e: MouseEvent) => {
            const cursorHitTolerancePx = 10;
            if (!isPointInPlot(e.clientX, e.clientY)) {
                pointerMode = 'idle';
                return;
            }

            pointerDownX = e.clientX;
            dragViewStart = viewStartRef.current;
            dragViewEnd = viewEndRef.current;

            const point = getCanvasPoint(e.clientX, e.clientY);
            const cursorX = getCursorScreenX();
            if (cursorX !== null && Math.abs(point.x - cursorX) <= cursorHitTolerancePx) {
                pointerMode = 'cursor';
                return;
            }

            pointerMode = 'pan';
        };

        const onMouseMove = (e: MouseEvent) => {
            if (pointerMode === 'cursor') {
                updateCursorFromClientX(e.clientX);
                return;
            }

            if (pointerMode === 'pan') {
                const plot = getPlotArea();
                const dx = e.clientX - pointerDownX;
                const range = dragViewEnd - dragViewStart;
                const shift = -(dx / plot.w) * range;
                const start = Math.max(0, Math.min(1 - range, dragViewStart + shift));
                setView({ start, end: start + range });
            }
        };

        const onMouseUp = (e: MouseEvent) => {
            const clickTolerancePx = 3;
            const wasClick = Math.abs(e.clientX - pointerDownX) <= clickTolerancePx;
            const activeMode = pointerMode;
            pointerMode = 'idle';

            if (activeMode === 'cursor') {
                updateCursorFromClientX(e.clientX);
                return;
            }

            if (!wasClick || !isPointInPlot(e.clientX, e.clientY)) {
                return;
            }

            updateCursorFromClientX(e.clientX);
        };

        const onMouseLeave = () => {
            pointerMode = 'idle';
        };

        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseLeave);
        window.addEventListener('resize', resize);
        resize();

        return () => {
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('mousedown', onMouseDown);
            canvas.removeEventListener('mousemove', onMouseMove);
            canvas.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('mouseleave', onMouseLeave);
            window.removeEventListener('resize', resize);
            window.removeEventListener('message', handleMessage);
        };
    }, [samples, sampleRate, filename, frameStartOffsets, totalSampleCount, isPlaying]);

    const windowLength = Math.max(0, view.end - view.start);
    const windowLengthSeconds = windowLength * totalDurationSeconds;
    const sliderStep = Math.max(1 / Math.max(totalSampleCount, 1), 0.0001);
    const viewRange: [number, number] = [view.start, view.end];
    const sliderStyle: React.CSSProperties = { flex: 1, margin: 0 };

    const onSliderChange = (value: number[]) => {
        if (value.length !== 2) {
            return;
        }
        let [start, end] = value;
        if (start > end) {
            [start, end] = [end, start];
        }
        const minSpan = Math.min(1, sliderStep);
        if (end - start < minSpan) {
            const center = (start + end) / 2;
            start = center - minSpan / 2;
            end = center + minSpan / 2;
        }
        if (start < 0) {
            end += -start;
            start = 0;
        }
        if (end > 1) {
            start -= (end - 1);
            end = 1;
        }
        start = Math.max(0, Math.min(1, start));
        end = Math.max(0, Math.min(1, end));
        setView({ start, end });
    };

    const onZoomIn = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 0.5;
        let start = center - range / 2;
        let end = center + range / 2;
        start = Math.max(0, start);
        end = Math.min(1, end);
        if (end - start < sliderStep) {
            end = Math.min(1, start + sliderStep);
            start = Math.max(0, end - sliderStep);
        }
        setView({ start, end });
    };

    const onZoomOut = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 2;
        let start = center - range / 2;
        let end = center + range / 2;
        if (start < 0) {
            end += -start;
            start = 0;
        }
        if (end > 1) {
            start -= (end - 1);
            end = 1;
        }
        start = Math.max(0, start);
        end = Math.min(1, end);
        setView({ start, end });
    };

    const onFit = () => {
        setView({ start: 0, end: 1 });
    };

    return (
        <div className="media-page">
            <Row>
                <Col flex="none">
                    <h2>{filename ? filename : 'Audio Viewer'}</h2>
                </Col>
                <Col flex="auto" style={{ textAlign: 'right' }}>
                    <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={() => setView(v => ({ start: v.start + (v.end - v.start) * 0.25, end: v.end - (v.end - v.start) * 0.25 }))}></Button>
                    <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={() => setView(v => ({ start: Math.max(0, v.start - (v.end - v.start)), end: Math.min(1, v.end + (v.end - v.start) * 0.25) }))}></Button>
                    <Button icon={<ExpandOutlined />} type="text" title="Fit" onClick={() => setView({ start: 0, end: 1 })}></Button>
                </Col>
            </Row>
            <div className="info-bar">
                <span>{sampleRate} Hz</span>
                <span>{bitDepth}-bit</span>
                <span>{channels}ch</span>
                <span>{totalSampleCount.toLocaleString()} samples</span>
                <span>{totalDurationSeconds.toFixed(2)}s</span>
                <span>{totalRecords} records</span>
            </div>
            <div className="canvas-area">
                <canvas ref={canvasRef}></canvas>
            </div>
            <Row className="controls" gutter={12}>
                <Col flex="none">
                    <Button
                        icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                        type="text"
                        title={isPlaying ? 'Stop Playback' : 'Play Visible Range'}
                        onClick={() => {
                            if (isPlaying) {
                                stopPlayback();
                            } else {
                                void playVisibleRange();
                            }
                        }}
                        disabled={totalSampleCount === 0}
                    ></Button>
                </Col>
                <Col flex="auto">
                    <Slider
                        range={{ draggableTrack: true }}
                        min={0}
                        max={1}
                        step={sliderStep}
                        value={viewRange}
                        onChange={onSliderChange}
                        style={sliderStyle}
                        tooltip={{ formatter: (v) => `${((v ?? 0) * totalDurationSeconds).toFixed(3)}s` }}
                        disabled={totalSampleCount === 0}
                    />
                </Col>
                <Col flex="none" style={{ opacity: 0.75, fontSize: '80%', whiteSpace: 'nowrap' }}>
                    Window: {windowLengthSeconds.toFixed(3)} s
                </Col>
                <Col flex="none">
                    <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={onZoomOut} disabled={windowLength >= 0.999999}></Button>
                    <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={onFit}></Button>
                </Col>
            </Row>
        </div>
    );
}