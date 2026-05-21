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

import { ExpandOutlined, PauseCircleOutlined, PlayCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BroadcastMessage, getIndexedSdsSuffix, Message, SampleFrame } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';
import { BaseChartViewer, ChartSample } from './BaseChartViewer';
import { decimateExtremaSeries, DecimationPreset } from './decimation';
import { getIsDarkTheme } from '../../../webview/utilities';

type AudioState = {
    samples: SampleFrame[];
    rangeStart?: number;
    rangeEnd?: number;
    domainStart?: number;
    domainEnd?: number;
    decimationPreset?: DecimationPreset;
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
    const {
        samples,
        sampleRate,
        bitDepth,
        channels,
        totalSamples,
        totalRecords,
        domainStart,
        domainEnd,
        decimationPreset: initialDecimationPreset,
    } = state;

    const [isPlaying, setIsPlaying] = useState(false);
    const [isDragMode, setIsDragMode] = useState(false);
    const [highlightedTime, setHighlightedTime] = useState<number | null>(null);
    const [viewWidth, setViewWidth] = useState<number>(() => Math.max(640, window.innerWidth));
    const [decimationPreset, setDecimationPreset] = useState<DecimationPreset>(initialDecimationPreset ?? 'accuracy');
    const audioCtxRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<AudioBufferSourceNode | null>(null);

    const totalDurationSeconds = Math.max(0, (domainEnd ?? 0) - (domainStart ?? 0));

    const sampleDomain = useMemo<[number, number]>(() => {
        if (sampleRate <= 0 || samples.length === 0) {
            return [0, 1];
        }

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        for (const frame of samples) {
            if (!Array.isArray(frame.samples) || frame.samples.length === 0) {
                continue;
            }

            const startX = frame.timestamp;
            const endX = frame.timestamp + ((frame.samples.length - 1) / sampleRate);
            if (Number.isFinite(startX) && startX < minX) {
                minX = startX;
            }
            if (Number.isFinite(endX) && endX > maxX) {
                maxX = endX;
            }
        }

        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || minX === maxX) {
            return [0, 1];
        }

        return [minX, maxX];
    }, [sampleRate, samples]);

    const resolvedDomainStart = domainStart ?? sampleDomain[0];
    const resolvedDomainEnd = domainEnd ?? sampleDomain[1];
    const domainSpan = Math.max(resolvedDomainEnd - resolvedDomainStart, 0.001);
    const minViewSpan = Math.max(domainSpan / 1000, 0.001);
    const sliderStep = Math.max(domainSpan / 1000, 0.0001);
    const [viewRange, setViewRange] = useState<[number, number]>(() => [resolvedDomainStart, resolvedDomainEnd]);

    const loadedSampleCount = useMemo(
        () => samples.reduce((sum, frame) => sum + frame.samples.length, 0),
        [samples]
    );

    useEffect(() => {
        setViewRange([resolvedDomainStart, resolvedDomainEnd]);
    }, [resolvedDomainEnd, resolvedDomainStart]);

    const clampRange = useCallback((start: number, end: number): [number, number] => {
        if (resolvedDomainEnd <= resolvedDomainStart) {
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

        if (start < resolvedDomainStart) {
            end += resolvedDomainStart - start;
            start = resolvedDomainStart;
        }
        if (end > resolvedDomainEnd) {
            start -= end - resolvedDomainEnd;
            end = resolvedDomainEnd;
        }

        start = Math.max(resolvedDomainStart, start);
        end = Math.min(resolvedDomainEnd, end);

        if (span <= 0) {
            return [resolvedDomainStart, resolvedDomainEnd];
        }

        return [start, end];
    }, [minViewSpan, resolvedDomainEnd, resolvedDomainStart]);

    const onZoomIn = () => {
        const center = (viewRange[0] + viewRange[1]) / 2;
        const range = (viewRange[1] - viewRange[0]) * 0.5;
        const [start, end] = clampRange(center - range / 2, center + range / 2);
        setViewRange([start, end]);
    };

    const onZoomOut = () => {
        const center = (viewRange[0] + viewRange[1]) / 2;
        const range = (viewRange[1] - viewRange[0]) * 2;
        const [start, end] = clampRange(center - range / 2, center + range / 2);
        setViewRange([start, end]);
    };

    const onFit = () => {
        if (resolvedDomainEnd > resolvedDomainStart) {
            setViewRange([resolvedDomainStart, resolvedDomainEnd]);
        }
    };

    const onSliderChange = (value: number[]) => {
        if (value.length !== 2) {
            return;
        }

        setIsDragMode(true);
        const [start, end] = clampRange(value[0], value[1]);
        setViewRange([start, end]);
    };

    const onSliderAfterChange = () => {
        setIsDragMode(false);
    };

    const sliderStyle: React.CSSProperties = {
        flex: 1,
        margin: 0,
    };

    const chartData = useMemo<ChartSample[]>(() => {
        const data: ChartSample[] = [];
        if (sampleRate <= 0) {
            return data;
        }

        const [start, end] = viewRange;

        for (const frame of samples) {
            for (let i = 0; i < frame.samples.length; i++) {
                const x = frame.timestamp + (i / sampleRate);
                if (x < start || x > end) {
                    continue;
                }

                data.push({
                    x,
                    y: frame.samples[i],
                    channel: 'audio',
                });
            }
        }
        const presetFactor = decimationPreset === 'accuracy' ? 2.8 : 1.3;
        const presetFloor = decimationPreset === 'accuracy' ? 2400 : 1200;
        const dragFactor = isDragMode ? 0.7 : 1;
        const maxPoints = Math.max(presetFloor, Math.floor(viewWidth * presetFactor * dragFactor));
        return decimateExtremaSeries(data, maxPoints);
    }, [decimationPreset, isDragMode, sampleRate, samples, viewRange, viewWidth]);

    const onCursorChange = useCallback((time: number) => {
        setHighlightedTime(time);
        broadcastMessage({
            type: 'broadcast',
            timeStamp: time,
            fileName: filename,
        });
    }, [filename]);

    const stopPlayback = () => {
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
        setIsPlaying(false);
    };

    const playLoadedSamples = async () => {
        if (sampleRate <= 0 || samples.length === 0) {
            return;
        }

        const pcm: number[] = [];
        for (const frame of samples) {
            for (const value of frame.samples) {
                pcm.push(value);
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

        stopPlayback();

        const buffer = audioCtx.createBuffer(1, pcm.length, sampleRate);
        buffer.copyToChannel(Float32Array.from(pcm), 0);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.onended = () => {
            if (sourceRef.current === source) {
                sourceRef.current = null;
                setIsPlaying(false);
            }
        };

        sourceRef.current = source;
        setIsPlaying(true);
        source.start();
    };

    useEffect(() => {
        return () => {
            stopPlayback();
            const audioCtx = audioCtxRef.current;
            if (audioCtx) {
                void audioCtx.close();
                audioCtxRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        const onMessage = (event: MessageEvent) => {
            const msg = event.data as Message;
            if (msg.type !== 'broadcast') {
                return;
            }

            const payload = msg as BroadcastMessage;
            if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix(payload.fileName)) {
                return;
            }

            if (typeof payload.timeStamp !== 'number') {
                return;
            }

            setHighlightedTime(payload.timeStamp);
        };

        window.addEventListener('message', onMessage);
        return () => {
            window.removeEventListener('message', onMessage);
        };
    }, [filename]);

    useEffect(() => {
        const onResize = () => {
            setViewWidth(Math.max(640, window.innerWidth));
        };

        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, []);

    return (
        <div className="media-page">
            <Row>
                <Col flex="none">
                    <h2>{filename ? filename : 'Audio Viewer'}</h2>
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
            <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
                <BaseChartViewer
                    data={chartData}
                    xField="x"
                    yField="y"
                    seriesField="channel"
                    height={420}
                    smooth={false}
                    highlightedX={highlightedTime}
                    xRange={viewRange}
                    onCursorChange={onCursorChange}
                    theme={getIsDarkTheme() ? 'classicDark' : 'classic'}
                    tooltip={{
                        showMarkers: true,
                        shared: true,
                        crosshairs: {
                            line: {
                                style: {
                                    stroke: 'rgba(150,150,150,0.45)',
                                    lineWidth: 1,
                                },
                            },
                        },
                        formatter: (datum: any) => ({
                            name: 'audio',
                            value: typeof datum?.y === 'number' ? datum.y.toFixed(5) : String(datum?.y ?? ''),
                        }),
                        title: (value: any) => {
                            const t = typeof value === 'number' ? value : Number(value.x);
                            return Number.isFinite(t) ? `Time: ${t.toFixed(4)} s` : t;
                        },
                    }}
                />
            </div>
            <Row className="controls" gutter={12}>
                <Col flex="none">
                    <Button
                        icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                        type="text"
                        title={isPlaying ? 'Stop Playback' : 'Play Loaded Samples'}
                        onClick={() => {
                            if (isPlaying) {
                                stopPlayback();
                            } else {
                                void playLoadedSamples();
                            }
                        }}
                        disabled={samples.length === 0}
                    ></Button>
                </Col>
                <Col flex="auto">
                    <Slider
                        range={{ draggableTrack: true }}
                        min={resolvedDomainStart}
                        max={resolvedDomainEnd}
                        step={sliderStep}
                        value={viewRange}
                        onChange={onSliderChange}
                        onChangeComplete={onSliderAfterChange}
                        style={sliderStyle}
                        tooltip={{ formatter: (v) => `${(v ?? 0).toFixed(3)}s` }}
                        disabled={resolvedDomainEnd <= resolvedDomainStart}
                    />
                </Col>
                {/* <Col flex="none" style={{ opacity: 0.75, fontSize: '80%', whiteSpace: 'nowrap' }}>
                    Window: {(viewRange[1] - viewRange[0]).toFixed(3)} s
                </Col>
                <Col flex="none" style={{ opacity: 0.75, fontSize: '80%', whiteSpace: 'nowrap' }}>
                    Cursor: {highlightedTime !== null ? `${highlightedTime.toFixed(4)} s` : 'n/a'}
                </Col>
                <Col flex="none">
                    <Space.Compact>
                        <Button
                            type={decimationPreset === 'accuracy' ? 'primary' : 'default'}
                            size="small"
                            onClick={() => setDecimationPreset('accuracy')}
                        >
                            Accuracy
                        </Button>
                        <Button
                            type={decimationPreset === 'performance' ? 'primary' : 'default'}
                            size="small"
                            onClick={() => setDecimationPreset('performance')}
                        >
                            Performance
                        </Button>
                    </Space.Compact>
                </Col>
                <Col flex="none" style={{ opacity: 0.75, fontSize: '80%', whiteSpace: 'nowrap' }}>
                    Mode: {isDragMode ? 'preview' : 'detail'} ({decimationPreset})
                </Col> */}
                <Col flex="none">
                    <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={onZoomOut} disabled={domainSpan === (viewRange[1] - viewRange[0])}></Button>
                    <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={onFit}></Button>
                </Col>
            </Row>
        </div>
    );
}
