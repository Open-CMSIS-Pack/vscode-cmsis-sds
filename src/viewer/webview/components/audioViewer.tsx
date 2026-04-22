/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { ZoomInOutlined, ZoomOutOutlined, ExpandOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BroadcastMessage, getIndexedSdsSuffix, Message, SampleFrame } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';
import {
    accumulateEnvelopeValue,
    createEnvelopeBins,
    createTimeToPixelMapper,
    getEnvelopeBinIndex,
    getPlotArea,
    updateEnvelopeMode,
} from './graphCanvas';

type AudioState = {
    samples: SampleFrame[];
    rangeStart?: number;
    rangeEnd?: number;
    domainStart?: number;
    domainEnd?: number;
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

type AudioWindowResponse = {
    command: 'mediaAudioWindowData';
    requestId: number;
    payload?: {
        rangeStart?: number;
        rangeEnd?: number;
        quality?: 'low' | 'high';
        samples?: SampleFrame[];
    };
};

const CHART_MARGIN = { top: 20, right: 20, bottom: 30, left: 50 };
const PREFETCH_FACTOR = 1.5;

export function AudioViewer({ state, filename }: AudioViewerProps) {
    const {
        samples,
        rangeStart,
        rangeEnd,
        domainStart: stateDomainStart,
        domainEnd: stateDomainEnd,
        sampleRate,
        bitDepth,
        channels,
        totalSamples,
        totalRecords,
    } = state;

    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [loadedFrames, setLoadedFrames] = useState<SampleFrame[]>(samples);
    const [loadedRange, setLoadedRange] = useState<{ start: number; end: number }>({
        start: rangeStart ?? stateDomainStart ?? 0,
        end: rangeEnd ?? stateDomainEnd ?? 1,
    });
    const [isDragMode, setIsDragMode] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);

    const domainStart = stateDomainStart ?? loadedRange.start;
    const domainEnd = stateDomainEnd ?? loadedRange.end;

    const [view, setView] = useState<{ start: number; end: number }>({ start: domainStart, end: domainEnd });
    const viewStartRef = useRef(view.start);
    const viewEndRef = useRef(view.end);

    const drawRef = useRef<() => void>(() => { });
    const cursorTimeRef = useRef<number | null>(null);
    const playbackCursorTimeRef = useRef<number | null>(null);

    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);
    const playbackStartTimeRef = useRef(0);
    const playbackDurationRef = useRef(0);
    const playbackStartedAtRef = useRef(0);
    const playbackRafRef = useRef<number | null>(null);

    const requestSeqRef = useRef(0);
    const latestAppliedSeqRef = useRef(0);
    const cachedRangeRef = useRef<{ start: number; end: number; quality: 'low' | 'high' } | null>(null);

    const domainSpan = Math.max(domainEnd - domainStart, 0.001);
    const minViewSpan = Math.max(domainSpan / 1000, 0.001);
    const sliderStep = Math.max(domainSpan / 1000, 0.0001);

    const totalDurationSeconds = Math.max(0, domainEnd - domainStart);
    const loadedSampleCount = useMemo(
        () => loadedFrames.reduce((sum, frame) => sum + frame.samples.length, 0),
        [loadedFrames]
    );

    const clampRange = useCallback((start: number, end: number): [number, number] => {
        if (domainEnd <= domainStart) {
            return [0, 1];
        }

        if (start > end) {
            [start, end] = [end, start];
        }

        let span = end - start;
        if (span < minViewSpan) {
            const center = (start + end) / 2;
            start = center - minViewSpan / 2;
            end = center + minViewSpan / 2;
            span = end - start;
        }

        if (start < domainStart) {
            end += domainStart - start;
            start = domainStart;
        }
        if (end > domainEnd) {
            start -= end - domainEnd;
            end = domainEnd;
        }

        start = Math.max(domainStart, start);
        end = Math.min(domainEnd, end);

        if (span <= 0) {
            return [domainStart, domainEnd];
        }

        return [start, end];
    }, [domainEnd, domainStart, minViewSpan]);

    useEffect(() => {
        setLoadedFrames(samples);
        setLoadedRange({
            start: rangeStart ?? stateDomainStart ?? domainStart,
            end: rangeEnd ?? stateDomainEnd ?? domainEnd,
        });
        cachedRangeRef.current = {
            start: rangeStart ?? stateDomainStart ?? domainStart,
            end: rangeEnd ?? stateDomainEnd ?? domainEnd,
            quality: 'high',
        };
    }, [samples, rangeStart, rangeEnd, stateDomainStart, stateDomainEnd, domainStart, domainEnd]);

    useEffect(() => {
        const [start, end] = clampRange(view.start, view.end);
        setView({ start, end });
    }, [domainStart, domainEnd, clampRange]);

    useEffect(() => {
        viewStartRef.current = view.start;
        viewEndRef.current = view.end;
        drawRef.current();
    }, [view]);

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
                // Source can already be stopped.
            }
            source.disconnect();
            sourceRef.current = null;
        }

        playbackCursorTimeRef.current = null;
        if (updateState) {
            setIsPlaying(false);
        }
        drawRef.current();
    };

    const startPlaybackTicker = () => {
        const tick = () => {
            const audioCtx = audioCtxRef.current;
            if (!audioCtx || !sourceRef.current) {
                playbackRafRef.current = null;
                return;
            }

            const elapsed = Math.max(0, audioCtx.currentTime - playbackStartedAtRef.current);
            const clamped = Math.min(elapsed, playbackDurationRef.current);
            playbackCursorTimeRef.current = playbackStartTimeRef.current + clamped;
            drawRef.current();

            playbackRafRef.current = requestAnimationFrame(tick);
        };

        if (playbackRafRef.current !== null) {
            cancelAnimationFrame(playbackRafRef.current);
        }
        playbackRafRef.current = requestAnimationFrame(tick);
    };

    const playVisibleRange = async () => {
        if (loadedFrames.length === 0 || sampleRate <= 0) {
            return;
        }

        const startTime = Math.max(viewStartRef.current, loadedRange.start);
        const endTime = Math.min(viewEndRef.current, loadedRange.end);
        if (endTime <= startTime) {
            return;
        }

        const pcm: number[] = [];
        for (const frame of loadedFrames) {
            const frameStart = frame.timestamp;
            const frameEnd = frameStart + (frame.samples.length / sampleRate);
            if (frameEnd <= startTime) {
                continue;
            }
            if (frameStart >= endTime) {
                break;
            }

            const fromOffset = Math.max(0, Math.floor((startTime - frameStart) * sampleRate));
            const toOffset = Math.min(frame.samples.length, Math.ceil((endTime - frameStart) * sampleRate));
            for (let i = fromOffset; i < toOffset; i++) {
                pcm.push(frame.samples[i]);
            }
        }

        if (pcm.length === 0) {
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

        stopPlayback(false);

        const audioBuffer = audioCtx.createBuffer(1, pcm.length, sampleRate);
        audioBuffer.copyToChannel(Float32Array.from(pcm), 0);

        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        source.onended = () => {
            if (sourceRef.current === source) {
                sourceRef.current = null;
                setIsPlaying(false);
                playbackCursorTimeRef.current = null;
                if (playbackRafRef.current !== null) {
                    cancelAnimationFrame(playbackRafRef.current);
                    playbackRafRef.current = null;
                }
                drawRef.current();
            }
        };

        playbackStartTimeRef.current = startTime;
        playbackDurationRef.current = pcm.length / sampleRate;
        playbackStartedAtRef.current = audioCtx.currentTime;
        playbackCursorTimeRef.current = startTime;
        sourceRef.current = source;
        setIsPlaying(true);
        source.start();
        startPlaybackTicker();
    };

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

    const requestAudioWindow = useCallback((start: number, end: number, quality: 'low' | 'high') => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const rangeStart = Math.min(start, end);
        const rangeEnd = Math.max(start, end);
        const rangeSpan = Math.max(rangeEnd - rangeStart, minViewSpan);
        const fetchSpan = Math.min(domainEnd - domainStart, rangeSpan * PREFETCH_FACTOR);
        const center = (rangeStart + rangeEnd) / 2;

        let fetchStart = center - fetchSpan / 2;
        let fetchEnd = center + fetchSpan / 2;
        if (fetchStart < domainStart) {
            fetchEnd += domainStart - fetchStart;
            fetchStart = domainStart;
        }
        if (fetchEnd > domainEnd) {
            fetchStart -= fetchEnd - domainEnd;
            fetchEnd = domainEnd;
        }
        fetchStart = Math.max(domainStart, fetchStart);
        fetchEnd = Math.min(domainEnd, fetchEnd);

        const rect = canvas.getBoundingClientRect();
        const plotWidth = Math.max(1, Math.floor(rect.width - CHART_MARGIN.left - CHART_MARGIN.right));
        const requestId = ++requestSeqRef.current;

        broadcastMessage({
            command: 'requestMediaAudioWindow',
            requestId,
            payload: {
                rangeStart: fetchStart,
                rangeEnd: fetchEnd,
                plotWidth,
                quality,
            },
        });
    }, [domainEnd, domainStart, minViewSpan]);

    const shouldRequestForRange = useCallback((start: number, end: number, quality: 'low' | 'high') => {
        const cached = cachedRangeRef.current;
        if (!cached) {
            return true;
        }

        const rangeStart = Math.min(start, end);
        const rangeEnd = Math.max(start, end);
        if (rangeStart < cached.start || rangeEnd > cached.end) {
            return true;
        }

        if (quality === 'high' && cached.quality === 'low') {
            return true;
        }

        return false;
    }, []);

    useEffect(() => {
        if (domainEnd <= domainStart) {
            return;
        }

        const quality: 'low' | 'high' = isDragMode ? 'low' : 'high';
        if (!shouldRequestForRange(view.start, view.end, quality)) {
            return;
        }

        const handle = window.setTimeout(() => {
            requestAudioWindow(view.start, view.end, quality);
        }, isDragMode ? 40 : 100);

        return () => {
            window.clearTimeout(handle);
        };
    }, [domainEnd, domainStart, isDragMode, requestAudioWindow, shouldRequestForRange, view]);

    useEffect(() => {
        const onResize = () => {
            cachedRangeRef.current = null;
            requestAudioWindow(viewStartRef.current, viewEndRef.current, isDragMode ? 'low' : 'high');
        };

        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [isDragMode, requestAudioWindow]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        let dpr = window.devicePixelRatio || 1;
        let envelopeModeActive = false;

        const handleMessage = (event: MessageEvent) => {
            const msg = event.data as Message;

            switch (msg.type) {
                case 'broadcast': {
                    if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix((msg as BroadcastMessage).fileName)) {
                        break;
                    }

                    const ts = (msg as BroadcastMessage).timeStamp;
                    if (typeof ts !== 'number') {
                        break;
                    }

                    cursorTimeRef.current = ts;
                    drawRef.current();
                    break;
                }
            }

            const response = msg as unknown as AudioWindowResponse;
            if (response.command === 'mediaAudioWindowData' && typeof response.requestId === 'number') {
                if (response.requestId < latestAppliedSeqRef.current) {
                    return;
                }
                latestAppliedSeqRef.current = response.requestId;

                const payload = response.payload;
                if (!payload || !Array.isArray(payload.samples)) {
                    return;
                }

                setLoadedFrames(payload.samples);
                const nextStart = typeof payload.rangeStart === 'number' ? payload.rangeStart : loadedRange.start;
                const nextEnd = typeof payload.rangeEnd === 'number' ? payload.rangeEnd : loadedRange.end;
                setLoadedRange({ start: nextStart, end: nextEnd });
                cachedRangeRef.current = {
                    start: Math.min(nextStart, nextEnd),
                    end: Math.max(nextStart, nextEnd),
                    quality: payload.quality === 'low' ? 'low' : 'high',
                };
            }
        };

        const resize = () => {
            dpr = window.devicePixelRatio || 1;
            const rect = canvas.parentElement?.getBoundingClientRect();
            if (!rect) {
                return;
            }
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawRef.current();
        };

        const forEachVisibleSample = (cb: (time: number, value: number) => void) => {
            const start = viewStartRef.current;
            const end = viewEndRef.current;
            if (end <= start || loadedFrames.length === 0) {
                return;
            }

            for (const frame of loadedFrames) {
                const frameStart = frame.timestamp;
                const frameEnd = frameStart + (frame.samples.length / sampleRate);
                if (frameEnd < start) {
                    continue;
                }
                if (frameStart > end) {
                    break;
                }

                const from = Math.max(0, Math.floor((start - frameStart) * sampleRate));
                const to = Math.min(frame.samples.length, Math.ceil((end - frameStart) * sampleRate));
                for (let i = from; i < to; i++) {
                    cb(frameStart + (i / sampleRate), frame.samples[i]);
                }
            }
        };

        drawRef.current = () => {
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);

            const plot = getPlotArea(canvas, dpr, CHART_MARGIN);
            if (plot.w <= 0 || plot.h <= 0) {
                return;
            }

            const viewStart = viewStartRef.current;
            const viewEnd = viewEndRef.current;
            const xFromTime = createTimeToPixelMapper(viewStart, viewEnd, plot);

            if (loadedFrames.length === 0) {
                ctx.strokeStyle = 'rgba(128,128,128,0.3)';
                ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
                return;
            }

            let yMin = Infinity;
            let yMax = -Infinity;
            let visibleCount = 0;
            forEachVisibleSample((_time, value) => {
                visibleCount++;
                if (value < yMin) yMin = value;
                if (value > yMax) yMax = value;
            });

            if (visibleCount === 0 || !Number.isFinite(yMin) || !Number.isFinite(yMax)) {
                return;
            }

            if (yMin === yMax) {
                yMin -= 1;
                yMax += 1;
            }
            const yPad = (yMax - yMin) * 0.1 || 0.1;
            yMin -= yPad;
            yMax += yPad;

            const yFromValue = (value: number) => plot.y + plot.h - ((value - yMin) / (yMax - yMin)) * plot.h;

            const zeroY = yFromValue(0);
            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(plot.x, zeroY);
            ctx.lineTo(plot.x + plot.w, zeroY);
            ctx.stroke();

            const binCount = Math.max(1, Math.floor(plot.w));
            envelopeModeActive = updateEnvelopeMode(envelopeModeActive, visibleCount, binCount);

            if (envelopeModeActive) {
                const bins = createEnvelopeBins(binCount);
                forEachVisibleSample((time, value) => {
                    const xBin = getEnvelopeBinIndex(time, viewStart, viewEnd, binCount);
                    accumulateEnvelopeValue(bins, xBin, value);
                });

                ctx.fillStyle = '#4fc3f733';
                for (let px = 0; px < binCount; px++) {
                    if (!Number.isFinite(bins.min[px]) || !Number.isFinite(bins.max[px])) {
                        continue;
                    }
                    const y1 = yFromValue(bins.max[px]);
                    const y2 = yFromValue(bins.min[px]);
                    ctx.fillRect(plot.x + px, y1, 1, y2 - y1);
                }

                // Keep a centerline for readability in dense envelope mode.
                ctx.strokeStyle = '#4fc3f7';
                ctx.lineWidth = 1;
                ctx.beginPath();
                let started = false;
                for (let px = 0; px < binCount; px++) {
                    const count = bins.counts[px];
                    if (count === 0) {
                        started = false;
                        continue;
                    }
                    const x = plot.x + px;
                    const y = yFromValue(bins.sum[px] / count);
                    if (!started) {
                        ctx.moveTo(x, y);
                        started = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                }
                ctx.stroke();
            } else {
                ctx.strokeStyle = '#4fc3f7';
                ctx.lineWidth = 1.25;
                ctx.beginPath();
                let started = false;
                forEachVisibleSample((time, value) => {
                    const x = xFromTime(time);
                    const y = yFromValue(value);
                    if (!started) {
                        ctx.moveTo(x, y);
                        started = true;
                    } else {
                        ctx.lineTo(x, y);
                    }
                });
                ctx.stroke();
            }

            const tStart = viewStartRef.current;
            const tEnd = viewEndRef.current;
            ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            for (let i = 0; i <= 5; i++) {
                const ts = tStart + ((tEnd - tStart) * i) / 5;
                const px = plot.x + (i / 5) * plot.w;
                ctx.fillText(`${ts.toFixed(3)}s`, px, plot.y + plot.h + 16);
            }

            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);

            const cursorTime = cursorTimeRef.current;
            if (cursorTime !== null && cursorTime >= tStart && cursorTime <= tEnd) {
                const x = xFromTime(cursorTime);
                ctx.strokeStyle = 'rgba(200,0,0,0.8)';
                ctx.beginPath();
                ctx.moveTo(x, plot.y);
                ctx.lineTo(x, plot.y + plot.h);
                ctx.stroke();
            }

            const playbackTime = playbackCursorTimeRef.current;
            if (isPlaying && playbackTime !== null && playbackTime >= tStart && playbackTime <= tEnd) {
                const x = xFromTime(playbackTime);
                ctx.strokeStyle = 'rgba(64, 156, 255, 0.95)';
                ctx.beginPath();
                ctx.moveTo(x, plot.y);
                ctx.lineTo(x, plot.y + plot.h);
                ctx.stroke();
            }
        };

        const getCanvasPoint = (clientX: number, clientY: number) => {
            const rect = canvas.getBoundingClientRect();
            return { x: clientX - rect.left, y: clientY - rect.top };
        };

        const isPointInPlot = (clientX: number, clientY: number) => {
            const plot = getPlotArea(canvas, dpr, CHART_MARGIN);
            const point = getCanvasPoint(clientX, clientY);
            return point.x >= plot.x && point.x <= plot.x + plot.w && point.y >= plot.y && point.y <= plot.y + plot.h;
        };

        const updateCursorFromClientX = (clientX: number) => {
            const plot = getPlotArea(canvas, dpr, CHART_MARGIN);
            const rect = canvas.getBoundingClientRect();
            const mouseX = clientX - rect.left;
            if (mouseX < plot.x || mouseX > plot.x + plot.w) {
                return;
            }

            const ratio = (mouseX - plot.x) / plot.w;
            const next = viewStartRef.current + ratio * (viewEndRef.current - viewStartRef.current);
            cursorTimeRef.current = next;
            broadcastMessage({
                type: 'broadcast',
                timeStamp: next,
                fileName: filename,
            });
            drawRef.current();
        };

        let pointerMode: 'idle' | 'cursor' | 'pan' = 'idle';
        let pointerDownX = 0;
        let dragViewStart = 0;
        let dragViewEnd = 0;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const plot = getPlotArea(canvas, dpr, CHART_MARGIN);
            const ratio = Math.max(0, Math.min(1, (mouseX - plot.x) / plot.w));
            const range = viewEndRef.current - viewStartRef.current;
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            const newRange = Math.max(minViewSpan, Math.min(domainSpan, range * factor));
            const center = viewStartRef.current + ratio * range;
            const [start, end] = clampRange(center - ratio * newRange, center + (1 - ratio) * newRange);
            setView({ start, end });
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

            const cursorTime = cursorTimeRef.current;
            if (cursorTime !== null) {
                const plot = getPlotArea(canvas, dpr, CHART_MARGIN);
                const cursorX = plot.x + ((cursorTime - dragViewStart) / Math.max(dragViewEnd - dragViewStart, 0.000001)) * plot.w;
                const point = getCanvasPoint(e.clientX, e.clientY);
                if (Math.abs(point.x - cursorX) <= cursorHitTolerancePx) {
                    pointerMode = 'cursor';
                    return;
                }
            }

            pointerMode = 'pan';
            setIsDragMode(true);
        };

        const onMouseMove = (e: MouseEvent) => {
            if (pointerMode === 'cursor') {
                updateCursorFromClientX(e.clientX);
                return;
            }

            if (pointerMode === 'pan') {
                const plot = getPlotArea(canvas, dpr, CHART_MARGIN);
                const dx = e.clientX - pointerDownX;
                const range = dragViewEnd - dragViewStart;
                const shift = -(dx / plot.w) * range;
                const [start, end] = clampRange(dragViewStart + shift, dragViewEnd + shift);
                setView({ start, end });
            }
        };

        const onMouseUp = (e: MouseEvent) => {
            const activeMode = pointerMode;
            pointerMode = 'idle';
            if (activeMode === 'pan') {
                setIsDragMode(false);
            }
            if (activeMode === 'cursor') {
                updateCursorFromClientX(e.clientX);
            }
        };

        const onMouseLeave = () => {
            if (pointerMode === 'pan') {
                setIsDragMode(false);
            }
            pointerMode = 'idle';
        };

        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseLeave);
        window.addEventListener('resize', resize);
        window.addEventListener('message', handleMessage);

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
    }, [
        clampRange,
        domainSpan,
        filename,
        isPlaying,
        loadedFrames,
        loadedRange.end,
        loadedRange.start,
        minViewSpan,
        sampleRate,
    ]);

    const onSliderChange = (value: number[]) => {
        if (value.length !== 2) {
            return;
        }

        setIsDragMode(true);
        const [start, end] = clampRange(value[0], value[1]);
        setView({ start, end });
    };

    const onSliderAfterChange = () => {
        setIsDragMode(false);
    };

    const onZoomIn = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 0.5;
        const [start, end] = clampRange(center - range / 2, center + range / 2);
        setView({ start, end });
    };

    const onZoomOut = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 2;
        const [start, end] = clampRange(center - range / 2, center + range / 2);
        setView({ start, end });
    };

    const onFit = () => {
        setView({ start: domainStart, end: domainEnd });
    };

    const viewRange: [number, number] = [view.start, view.end];
    const windowLengthSeconds = Math.max(0, view.end - view.start);

    return (
        <div className="media-page">
            <Row>
                <Col flex="none">
                    <h2>{filename ? filename : 'Audio Viewer'}</h2>
                </Col>
                <Col flex="auto" style={{ textAlign: 'right' }}>
                    <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={onZoomOut}></Button>
                    <Button icon={<ExpandOutlined />} type="text" title="Fit" onClick={onFit}></Button>
                </Col>
            </Row>
            <div className="info-bar">
                <span>{sampleRate} Hz</span>
                <span>{bitDepth}-bit</span>
                <span>{channels}ch</span>
                <span>{totalSamples.toLocaleString()} total samples</span>
                <span>{loadedSampleCount.toLocaleString()} loaded samples</span>
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
                        disabled={loadedFrames.length === 0}
                    ></Button>
                </Col>
                <Col flex="auto">
                    <Slider
                        range={{ draggableTrack: true }}
                        min={domainStart}
                        max={domainEnd}
                        step={sliderStep}
                        value={viewRange}
                        onChange={onSliderChange}
                        onChangeComplete={onSliderAfterChange}
                        style={{ flex: 1, margin: 0 }}
                        tooltip={{ formatter: (v) => `${(v ?? 0).toFixed(3)}s` }}
                        disabled={domainEnd <= domainStart}
                    />
                </Col>
                <Col flex="none" style={{ opacity: 0.75, fontSize: '80%', whiteSpace: 'nowrap' }}>
                    Window: {windowLengthSeconds.toFixed(3)} s
                </Col>
                <Col flex="none">
                    <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={onZoomOut} disabled={windowLengthSeconds >= domainSpan}></Button>
                    <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={onFit}></Button>
                </Col>
            </Row>
        </div>
    );
}
