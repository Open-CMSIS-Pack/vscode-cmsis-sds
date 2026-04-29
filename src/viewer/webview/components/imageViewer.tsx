/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { ExpandOutlined, LeftCircleOutlined, RightCircleOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider, Space } from 'antd';
import { BroadcastMessage, ImageFrame, getIndexedSdsSuffix, getNearestFrameIndexAtTimestamp, isTimestampInFrameRange, Message } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';
import { decodeFrame } from '../../../webview/utilities';

type ImageState = {
    frames: ImageFrame[];
    rangeStart?: number;
    width: number;
    height: number;
    totalFrames: number;
};

type ImageViewerProps = {
    state: ImageState;
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

export function ImageViewer({ state, filename }: ImageViewerProps) {
    const { frames, rangeStart = 0, width, height, totalFrames } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [index, setIndex] = useState(rangeStart);
    const [windowFrames, setWindowFrames] = useState<ImageFrame[]>(frames);
    const [windowStart, setWindowStart] = useState(rangeStart);
    const [isDragMode, setIsDragMode] = useState(false);
    const [zoom, setZoom] = useState(1);
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
        const windowSize = quality === 'low' ? 32 : 160;
        broadcastMessage({
            command: 'requestMediaFrameWindow',
            requestId,
            payload: {
                mediaType: 'image',
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
        const handleMessage = (event: MessageEvent) => {
            const msg = event.data as Message;
            const messageType = (msg.type ?? msg.command) as string | undefined;

            switch (messageType) {
                case 'broadcast': {
                    if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix((msg as BroadcastMessage).fileName)) {
                        break;
                    }

                    if (!isTimestampInFrameRange((msg as BroadcastMessage).timeStamp, windowFrames)) {
                        break;
                    }

                    const nextIndex = getNearestFrameIndexAtTimestamp((msg as BroadcastMessage).timeStamp as number, windowFrames);
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
                    if (mediaMessage.payload?.mediaType !== 'image') {
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
    }, [filename, totalFrames, windowFrames]);

    useEffect(() => {
        const loadedStart = windowStart;
        const loadedEnd = windowStart + windowFrames.length - 1;
        if (windowFrames.length === 0 || index < loadedStart || index > loadedEnd) {
            requestFrameWindow(index, 'low');
            return;
        }

        const nearEdgeMargin = Math.max(8, Math.floor(windowFrames.length * 0.2));
        if (index <= loadedStart + nearEdgeMargin || index >= loadedEnd - nearEdgeMargin) {
            requestFrameWindow(index, isDragMode ? 'low' : 'high');
        }
    }, [index, isDragMode, windowFrames.length, windowStart]);

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

    function onChangeIndex(nextIndex: number) {
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
                    {filename ? filename : 'Image Viewer'}
                </Col>
                <Col flex="auto" style={{ textAlign: 'right' }}>
                    <Space>
                        <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={() => setZoom(z => Math.min(8, z * 1.5))}></Button>
                        <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={() => setZoom(z => Math.max(0.25, z / 1.5))}></Button>
                        <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={() => setZoom(1)}></Button>
                    </Space>
                </Col>
            </Row>
            <Row className="info-bar">
                <Col style={statsTitleStyle}>Dimensions</Col>
                <Col style={statsValueStyle}>{width}×{height}</Col>
                <Col style={statsTitleStyle}>Frame</Col>
                <Col style={statsValueStyle}>{Math.min(index + 1, totalFrames)} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Showing</Col>
                <Col style={statsValueStyle}>{windowFrames.length} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Timestamp</Col>
                <Col style={statsValueStyle}>{(getLoadedFrame(index)?.timestamp ?? 0).toFixed(4)}s</Col>
            </Row>
            <Row className="canvas-area">
                <Col style={{ width: `${width * zoom}px`, height: `${height * zoom}px` }}>
                    <canvas ref={canvasRef} width={width * zoom} height={height * zoom}></canvas>
                </Col>
            </Row>
            <Row className="controls">
                <Col flex="none" style={{ textAlign: 'center' }}>
                    <Button icon={<LeftCircleOutlined />} type="link" title="Previous Frame" onClick={() => onChangeIndex(Math.max(0, index - 1))} />
                </Col>
                <Col flex="auto">
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
                </Col>
                <Col flex="none" style={{ textAlign: 'center' }}>
                    <Button icon={<RightCircleOutlined />} type="link" title="Next Frame" onClick={() => onChangeIndex(Math.min(totalFrames - 1, index + 1))} />
                </Col>
            </Row>
        </div>
    );
}