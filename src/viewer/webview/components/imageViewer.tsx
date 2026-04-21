/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { ExpandOutlined, LeftCircleOutlined, RightCircleOutlined, SaveOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Button, Col, Row, Slider, Space } from 'antd';
import { BroadcastMessage, ImageFrame, getIndexedSdsSuffix, getNearestFrameIndexAtTimestamp, isTimestampInFrameRange, Message } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';
import { decodeFrame } from '../../../webview/utilities';

type ImageState = {
    frames: ImageFrame[];
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
    const { frames, width, height, totalFrames } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [index, setIndex] = useState(0);
    const [zoom, setZoom] = useState(1);

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
            }
        };

        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [filename, frames]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || frames.length === 0) { return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { return; }
        const frame = frames[Math.min(index, frames.length - 1)];
        const img = decodeFrame(frame, width, height);
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width * zoom}px`;
        canvas.style.height = `${height * zoom}px`;
        ctx.putImageData(img, 0, 0);
    }, [frames, height, index, width, zoom]);

    function onChangeIndex(nextIndex: number) {
        setIndex(nextIndex);
        broadcastMessage({
            type: 'broadcast',
            timeStamp: frames[nextIndex]?.timestamp,
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
                        <Button icon={<SaveOutlined />} type="text" title="Export CSV" onClick={() => { /* TODO: Implement CSV export */ }}></Button>
                    </Space>
                </Col>
            </Row>
            <Row className="info-bar">
                <Col style={statsTitleStyle}>Dimensions</Col>
                <Col style={statsValueStyle}>{width}×{height}</Col>
                <Col style={statsTitleStyle}>Frame</Col>
                <Col style={statsValueStyle}>{Math.min(index + 1, frames.length)} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Showing</Col>
                <Col style={statsValueStyle}>{frames.length} of {totalFrames}</Col>
                <Col style={statsTitleStyle}>Timestamp</Col>
                <Col style={statsValueStyle}>{frames[index]?.timestamp}</Col>
            </Row>
            <Row className="canvas-area">
                <Col>
                    <canvas ref={canvasRef} width={width} height={height}></canvas>
                </Col>
            </Row>
            <Row className="controls">
                <Col flex="none" style={{ textAlign: 'center' }}>
                    <Button icon={<LeftCircleOutlined />} type="link" title="Previous Frame" onClick={() => onChangeIndex(Math.max(0, index - 1))} />
                </Col>
                <Col flex="auto">
                    <Slider
                        min={0}
                        max={Math.max(0, frames.length - 1)}
                        value={index}
                        onChange={value => onChangeIndex(value)}
                        style={{ flex: 1, margin: 0 }}
                    />
                </Col>
                <Col flex="none" style={{ textAlign: 'center' }}>
                    <Button icon={<RightCircleOutlined />} type="link" title="Next Frame" onClick={() => onChangeIndex(Math.min(frames.length - 1, index + 1))} />
                </Col>
            </Row>
        </div>
    );
}