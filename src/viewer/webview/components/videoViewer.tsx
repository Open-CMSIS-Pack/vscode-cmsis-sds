/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExpandOutlined, LeftCircleOutlined, PauseCircleOutlined, PlayCircleOutlined, RightCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider, Space } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { BroadcastMessage, ImageFrame, getIndexedSdsSuffix, getNearestFrameIndexAtTimestamp, isTimestampInFrameRange, Message } from '../../../webview/protocol';
import { decodeFrame } from '../../../webview/utilities';
import { broadcastMessage } from '../../../webview/vscode-api';

type VideoState = {
    frames: ImageFrame[];
    rangeStart?: number;
    width: number;
    height: number;
    fps: number;
    totalFrames: number;
};

type VideoViewerProps = {
    state: VideoState;
    filename?: string;
};

const statsTitleStyle: React.CSSProperties = {
    opacity: 0.5,
    fontSize: '80%'
};

const statsValueStyle: React.CSSProperties = {
    paddingRight: 32,
    fontSize: '80%'
};


export function VideoViewer({ state, filename }: VideoViewerProps) {
    const { frames, rangeStart = 0, width, height, fps, totalFrames } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [index, setIndex] = useState(rangeStart);
    const [windowFrames, setWindowFrames] = useState<ImageFrame[]>(frames);
    const [windowStart, setWindowStart] = useState(rangeStart);
    const [isDragMode, setIsDragMode] = useState(false);
    const [zoom, setZoom] = useState(1);
    const [playing, setPlaying] = useState(false);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const requestSeqRef = useRef(0);
    const latestAppliedSeqRef = useRef(0);

    const getLoadedFrame = (absoluteIndex: number) => {
        const localIndex = absoluteIndex - windowStart;
        if (localIndex < 0 || localIndex >= windowFrames.length) {
            return null;
        }
        return windowFrames[localIndex];
    };

    const requestFrameWindow = (centerIndex: number, quality: 'low' | 'high') => {
        const requestId = ++requestSeqRef.current;
        const windowSize = quality === 'low' ? 80 : 220;
        broadcastMessage({
            command: 'requestMediaFrameWindow',
            requestId,
            payload: {
                mediaType: 'video',
                centerIndex,
                windowSize,
                quality,
            },
        });
    };

    useEffect(() => {
        setWindowFrames(frames);
        setWindowStart(rangeStart);
        setIndex((prev) => {
            const next = Math.max(0, Math.min(totalFrames - 1, prev));
            return Number.isFinite(next) ? next : rangeStart;
        });
    }, [frames, rangeStart, totalFrames]);

    useEffect(() => {
        if (!playing) { return; }
        timerRef.current = setInterval(() => {
            setIndex(i => (i + 1) % Math.max(1, totalFrames));
        }, 1000 / fps);
        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [fps, playing, totalFrames]);

    useEffect(() => {
        const loadedStart = windowStart;
        const loadedEnd = windowStart + windowFrames.length - 1;
        if (windowFrames.length === 0 || index < loadedStart || index > loadedEnd) {
            requestFrameWindow(index, playing || isDragMode ? 'low' : 'high');
            return;
        }

        const nearEdgeMargin = Math.max(6, Math.floor(windowFrames.length * 0.2));
        if (index <= loadedStart + nearEdgeMargin || index >= loadedEnd - nearEdgeMargin) {
            requestFrameWindow(index, playing || isDragMode ? 'low' : 'high');
        }
    }, [index, isDragMode, playing, windowFrames.length, windowStart]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || windowFrames.length === 0) { return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { return; }
        const frame = getLoadedFrame(index) ?? windowFrames[Math.max(0, Math.min(windowFrames.length - 1, index - windowStart))];
        if (!frame) { return; }
        const img = decodeFrame(frame, width, height);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;
        ctx.putImageData(img, 0, 0);
    }, [height, index, width, zoom, windowFrames, windowStart]);

    const togglePlay = () => setPlaying(p => !p);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const msg = event.data as Message;

            switch (msg.type) {
                case 'broadcast': {
                    if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix((msg as BroadcastMessage).fileName)) {
                        break;
                    }

                    if (!isTimestampInFrameRange((msg as BroadcastMessage).timeStamp, frames)) {
                        break;
                    }

                    const nextIndex = getNearestFrameIndexAtTimestamp((msg as BroadcastMessage).timeStamp as number, frames);
                    if (nextIndex === null) {
                        break;
                    }

                    setIndex(prevIndex => prevIndex === nextIndex ? prevIndex : nextIndex);
                    break;
                }
                case 'mediaFrameWindowData': {
                    const mediaMessage = msg as Message & {
                        requestId?: number;
                        payload?: {
                            mediaType?: 'image' | 'video';
                            rangeStart?: number;
                            frames?: ImageFrame[];
                        };
                    };
                    if (mediaMessage.payload?.mediaType !== 'video') {
                        break;
                    }
                    if (typeof mediaMessage.requestId === 'number') {
                        if (mediaMessage.requestId < latestAppliedSeqRef.current) {
                            break;
                        }
                        latestAppliedSeqRef.current = mediaMessage.requestId;
                    }
                    if (!Array.isArray(mediaMessage.payload?.frames)) {
                        break;
                    }

                    setWindowFrames(mediaMessage.payload.frames);
                    setWindowStart(typeof mediaMessage.payload.rangeStart === 'number' ? mediaMessage.payload.rangeStart : 0);
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [filename, frames, totalFrames]);

    function onChangeIndex(nextIndex: number) {
        setPlaying(false);
        const clamped = Math.max(0, Math.min(totalFrames - 1, nextIndex));
        setIndex(clamped);
        const frame = getLoadedFrame(clamped);
        broadcastMessage({
            type: 'broadcast',
            timeStamp: frame?.timestamp,
            fileName: filename,
        });
    }

    return (
        <div className="media-page">
            <Row>
                <Col flex="none" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {filename ? filename : 'Video Viewer'}
                </Col>
                <Col flex="auto" style={{ textAlign: 'right' }}>
                    <Space>
                        <Button icon={<ZoomInOutlined />} type="text" onClick={() => setZoom(z => Math.min(8, z * 1.5))}></Button>
                        <Button icon={<ZoomOutOutlined />} type="text" onClick={() => setZoom(z => Math.max(0.25, z / 1.5))}></Button>
                        <Button icon={<ExpandOutlined />} type="text" onClick={() => setZoom(1)}></Button>
                    </Space>
                </Col>
            </Row>
            <Row className="info-bar">
                <Col style={statsTitleStyle}>Dimensions</Col>
                <Col style={statsValueStyle}>{width}×{height}</Col>
                <Col style={statsTitleStyle}>FPS</Col>
                <Col style={statsValueStyle}>{fps}</Col>
                <Col style={statsTitleStyle}>Frame</Col>
                <Col style={statsValueStyle}>{Math.min(index + 1, totalFrames)} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Loaded</Col>
                <Col style={statsValueStyle}>{windowFrames.length}</Col>
            </Row>
            <Row className="canvas-area">
                <Col>
                    <canvas ref={canvasRef} width={width} height={height}></canvas>
                </Col>
            </Row>
            <div className="controls">
                <Button icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />} type="link" onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</Button>
                <Button icon={<LeftCircleOutlined />} type="link" onClick={() => { onChangeIndex(Math.max(0, index - 1)); }}></Button>
                <Slider
                    min={0}
                    max={Math.max(0, totalFrames - 1)}
                    value={index}
                    onChange={value => {
                        setIsDragMode(true);
                        onChangeIndex(value);
                    }}
                    onChangeComplete={() => setIsDragMode(false)}
                    style={{ flex: 1, margin: 0 }}
                />
                <Button icon={<RightCircleOutlined />} type="link" onClick={() => { onChangeIndex(Math.min(totalFrames - 1, index + 1)); }}></Button>
            </div>
        </div>
    );
}