import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getInitialState } from '../../webview/bridge';
import Button from 'antd/lib/button/Button';
import { ExpandOutlined, LeftCircleOutlined, RightCircleOutlined, SaveOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';
import { Col, ConfigProvider, Row, Slider, Space, theme } from 'antd';
import { BroadcastMessage, Message } from '../../webview/protocol';
import { broadcastMessage } from '../../webview/vscode-api';

type Frame = { timestamp: number; rgbaBase64: string };

type InitialState = {
    mediaType?: 'image' | 'audio' | 'video';
    image?: { frames: Frame[]; width: number; height: number; totalFrames: number };
    audio?: { samples: number[]; sampleRate: number; bitDepth: number; channels: number; totalSamples: number; totalRecords: number };
    video?: { frames: Frame[]; width: number; height: number; fps: number; totalFrames: number };
    fileName?: string;
    error?: string;
};

function decodeFrame(frame: Frame, width: number, height: number): ImageData {
    const raw = atob(frame.rgbaBase64);
    const arr = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return new ImageData(arr, width, height);
}

const statsTitleStyle: React.CSSProperties = {
    opacity: 0.5,
    fontSize: '80%'
};

const statsValueStyle: React.CSSProperties = {
    paddingRight: 32,
    fontSize: '80%'
};

function ImageViewer({ state, filename }: { state: NonNullable<InitialState['image']>; filename?: string }) {
    const { frames, width, height, totalFrames } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [index, setIndex] = useState(0);
    const [zoom, setZoom] = useState(1);

    function isTimestampInFrameRange(timeStamp: number | undefined) {
        if (timeStamp === undefined || frames.length === 0) {
            return false;
        }

        const firstTimestamp = frames[0].timestamp;
        const lastTimestamp = frames[frames.length - 1].timestamp;
        const minTimestamp = Math.min(firstTimestamp, lastTimestamp);
        const maxTimestamp = Math.max(firstTimestamp, lastTimestamp);
        return timeStamp >= minTimestamp && timeStamp <= maxTimestamp;
    }

    function lowerBoundFrameTimestamp(target: number) {
        let lo = 0;
        let hi = frames.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (frames[mid].timestamp < target) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    function getNearestFrameIndexAtTimestamp(target: number) {
        if (!isTimestampInFrameRange(target)) {
            return null;
        }

        const right = lowerBoundFrameTimestamp(target);
        if (right < 0) {
            // return 0;
            return null;
        }
        if (right >= frames.length) {
            // return frames.length - 1;
            return null;
        }

        const left = right - 1;
        return Math.abs(frames[left].timestamp - target) <= Math.abs(frames[right].timestamp - target)
            ? left
            : right;
    }

    window.addEventListener('message', (event) => {
        const msg = event.data as Message;

        switch (msg.type) {
            case 'broadcast':
                if (isTimestampInFrameRange((msg as BroadcastMessage).timeStamp)) {
                    const nextIndex = getNearestFrameIndexAtTimestamp((msg as BroadcastMessage).timeStamp as number);
                    if (nextIndex !== null) {
                        setIndex(nextIndex);
                    }
                    break;
                }
                // setIndex(Math.max(0, Math.min(frames.length - 1, (msg as BroadcastMessage).currentFrame)));
                break;
        }
    });

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
            currentFrame: nextIndex,
            timeStamp: frames[nextIndex]?.timestamp,
        });
    }

    return (
        <div className="media-page">
            <Row>
                <Col span={4} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    🖼 {filename ? filename : 'Image Viewer'}
                </Col>
                <Col span={10} >
                    <Space>
                        <Button icon={<ZoomInOutlined />} type="text" title="Zoom In" onClick={() => setZoom(z => Math.min(8, z * 1.5))}></Button>
                        <Button icon={<ZoomOutOutlined />} type="text" title="Zoom Out" onClick={() => setZoom(z => Math.max(0.25, z / 1.5))}></Button>
                        <Button icon={<ExpandOutlined />} type="text" title="Fit to Window" onClick={() => setZoom(1)}></Button>
                        <Button icon={<SaveOutlined />} type="text" title="Export CSV" onClick={() => { /* TODO: Implement CSV export */ }}></Button>
                    </Space>
                </Col>
                <Col span={10} style={{ textAlign: 'right' }}>
                </Col>
            </Row>
            <div className="info-bar">
                <Row gutter={8}>
                    <Col style={statsTitleStyle}>Dimensions</Col>
                    <Col style={statsValueStyle}>{width}×{height}</Col>
                    <Col style={statsTitleStyle}>Frames</Col>
                    <Col style={statsValueStyle}>{totalFrames}</Col>
                    <Col style={statsTitleStyle}>Showing</Col>
                    <Col style={statsValueStyle}>{frames.length} of {totalFrames}</Col>
                    <Col style={statsTitleStyle}>Timestamp</Col>
                    <Col style={statsValueStyle}>{frames[index]?.timestamp}</Col>
                </Row>
            </div>
            <div className="canvas-area">
                <canvas ref={canvasRef} width={width} height={height}></canvas>
            </div>
            <Row>
                <Col span="2" style={{ textAlign: 'center' }}>
                    <Button icon={<LeftCircleOutlined />} type="link" title="Previous Frame" onClick={() => onChangeIndex(Math.max(0, index - 1))} />
                </Col>
                <Col span="16">
                    <Slider min={0} max={Math.max(0, frames.length - 1)} value={index} onChange={value => onChangeIndex(value)} style={{ width: '100%' }} />
                </Col>
                <Col span="2" style={{ textAlign: 'center' }}>
                    <Button icon={<RightCircleOutlined />} type="link" title="Next Frame" onClick={() => onChangeIndex(Math.min(frames.length - 1, index + 1))} />
                </Col>
                <Col span="2" style={{ textAlign: 'right' }}>
                    <div className="frame-info">Frame {Math.min(index + 1, frames.length)}/{frames.length}</div>
                </Col>
            </Row>
        </div>
    );
}

function AudioViewer({ state, filename }: { state: NonNullable<InitialState['audio']>; filename?: string }) {
    const { samples, sampleRate, bitDepth, channels, totalSamples, totalRecords } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [view, setView] = useState<{ start: number; end: number }>({ start: 0, end: 1 });

    window.addEventListener('message', (event) => {
        const msg = event.data as Message;

        switch (msg.type) {
            case 'broadcast':
                console.log(msg.payload);
                break;
        }
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) { return; }
        const ctx = canvas.getContext('2d');
        if (!ctx) { return; }
        let dpr = window.devicePixelRatio || 1;

        const resize = () => {
            dpr = window.devicePixelRatio || 1;
            const rect = canvas.parentElement?.getBoundingClientRect();
            if (!rect) { return; }
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            draw();
        };

        const draw = () => {
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);
            if (samples.length === 0) return;
            const M = { top: 20, right: 20, bottom: 30, left: 50 };
            const pW = w - M.left - M.right;
            const pH = h - M.top - M.bottom;
            const startIdx = Math.floor(view.start * samples.length);
            const endIdx = Math.ceil(view.end * samples.length);
            const visible = samples.slice(startIdx, endIdx);

            let yMin = -1, yMax = 1;
            for (const v of visible) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
            const yPad = (yMax - yMin) * 0.1 || 0.1;
            yMin -= yPad; yMax += yPad;

            const zeroY = M.top + pH - (-yMin) / (yMax - yMin) * pH;
            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(M.left, zeroY);
            ctx.lineTo(M.left + pW, zeroY);
            ctx.stroke();

            ctx.strokeStyle = '#4fc3f7';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < visible.length; i++) {
                const x = M.left + (i / visible.length) * pW;
                const y = M.top + pH - (visible[i] - yMin) / (yMax - yMin) * pH;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();

            if (visible.length > pW * 2) {
                ctx.fillStyle = '#4fc3f733';
                const binSize = visible.length / pW;
                for (let px = 0; px < pW; px++) {
                    const from = Math.floor(px * binSize);
                    const to = Math.min(Math.floor((px + 1) * binSize), visible.length);
                    let min = Infinity, max = -Infinity;
                    for (let j = from; j < to; j++) { if (visible[j] < min) min = visible[j]; if (visible[j] > max) max = visible[j]; }
                    const y1 = M.top + pH - (max - yMin) / (yMax - yMin) * pH;
                    const y2 = M.top + pH - (min - yMin) / (yMax - yMin) * pH;
                    ctx.fillRect(M.left + px, y1, 1, y2 - y1);
                }
            }

            const tStart = startIdx / sampleRate;
            const tEnd = endIdx / sampleRate;
            ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            for (let i = 0; i <= 5; i++) {
                const t = tStart + (tEnd - tStart) * i / 5;
                const px = M.left + (i / 5) * pW;
                ctx.fillText(`${t.toFixed(3)}s`, px, M.top + pH + 16);
            }

            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.strokeRect(M.left, M.top, pW, pH);
        };

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const pW = (canvas.width / dpr) - 70;
            const ratio = Math.max(0, Math.min(1, (mx - 50) / pW));
            const range = view.end - view.start;
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            const newRange = Math.max(0.001, Math.min(1, range * factor));
            const center = view.start + ratio * range;
            const start = Math.max(0, Math.min(1 - newRange, center - ratio * newRange));
            setView({ start, end: start + newRange });
        };

        let dragging = false; let dragX = 0; let dragVS = 0; let dragVE = 0;
        const onDown = (e: MouseEvent) => { dragging = true; dragX = e.clientX; dragVS = view.start; dragVE = view.end; };
        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            const pW = (canvas.width / dpr) - 70;
            const dx = e.clientX - dragX;
            const shift = -(dx / pW) * (dragVE - dragVS);
            const start = Math.max(0, Math.min(1 - (dragVE - dragVS), dragVS + shift));
            setView({ start, end: start + (dragVE - dragVS) });
        };
        const onUp = () => { dragging = false; };

        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('mousedown', onDown);
        canvas.addEventListener('mousemove', onMove);
        canvas.addEventListener('mouseup', onUp);
        window.addEventListener('resize', resize);
        resize();

        return () => {
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('mousedown', onDown);
            canvas.removeEventListener('mousemove', onMove);
            canvas.removeEventListener('mouseup', onUp);
            window.removeEventListener('resize', resize);
        };
    }, [samples, sampleRate, view.end, view.start]);

    return (
        <div className="media-page">
            <div className="toolbar">
                <h2>🔊 {filename ? filename : 'Audio Viewer'}</h2>
                <button onClick={() => setView(v => ({ start: v.start + (v.end - v.start) * 0.25, end: v.end - (v.end - v.start) * 0.25 }))}>🔍+</button>
                <button onClick={() => setView(v => ({ start: Math.max(0, v.start - (v.end - v.start)), end: Math.min(1, v.end + (v.end - v.start)) }))}>🔍−</button>
                <button onClick={() => setView({ start: 0, end: 1 })}>Fit</button>
            </div>
            <div className="info-bar">
                <span>{sampleRate} Hz</span>
                <span>{bitDepth}-bit</span>
                <span>{channels}ch</span>
                <span>{totalSamples.toLocaleString()} samples</span>
                <span>{(totalSamples / sampleRate).toFixed(2)}s</span>
                <span>{totalRecords} records</span>
            </div>
            <div className="canvas-area">
                <canvas ref={canvasRef}></canvas>
            </div>
        </div>
    );
}

function VideoViewer({ state, filename }: { state: NonNullable<InitialState['video']>; filename?: string }) {
    const { frames, width, height, fps, totalFrames } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [index, setIndex] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [playing, setPlaying] = useState(false);
    const timerRef = useRef<NodeJS.Timeout | null>(null);

    window.addEventListener('message', (event) => {
        const msg = event.data as Message;

        switch (msg.type) {
            case 'broadcast':
                console.log(msg.payload);
                break;
        }
    });

    useEffect(() => {
        if (!playing) { return; }
        timerRef.current = setInterval(() => {
            setIndex(i => (i + 1) % Math.max(1, frames.length));
        }, 1000 / fps);
        return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    }, [frames.length, fps, playing]);

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

    const togglePlay = () => setPlaying(p => !p);

    return (
        <div className="media-page">
            <div className="toolbar">
                <h2>🎬 {filename ? filename : 'Video Viewer'}</h2>
                <button onClick={() => setZoom(z => Math.min(8, z * 1.5))}>🔍+</button>
                <button onClick={() => setZoom(z => Math.max(0.25, z / 1.5))}>🔍−</button>
                <button onClick={() => setZoom(1)}>Fit</button>
            </div>
            <div className="info-bar">
                <span>{width}×{height}</span>
                <span>{fps} FPS</span>
                <span>{totalFrames} total frames</span>
                <span>Loaded: {frames.length}</span>
            </div>
            <div className="canvas-area">
                <canvas ref={canvasRef} width={width} height={height}></canvas>
            </div>
            <div className="controls">
                <button onClick={togglePlay}>{playing ? '⏸ Pause' : '▶ Play'}</button>
                <button onClick={() => { setPlaying(false); setIndex(i => Math.max(0, i - 1)); }}>◀</button>
                <input type="range" min={0} max={Math.max(0, frames.length - 1)} value={index} onChange={e => { setPlaying(false); setIndex(parseInt(e.target.value, 10)); }} />
                <button onClick={() => { setPlaying(false); setIndex(i => Math.min(frames.length - 1, i + 1)); }}>▶</button>
                <div className="frame-info">Frame {Math.min(index + 1, frames.length)}/{frames.length}</div>
            </div>
        </div>
    );
}

function MediaViewerApp() {
    const initial = getInitialState<InitialState>({});

    if (initial.error) {
        return (
            <div className="error-page">
                <div className="error">
                    <h2>Media Viewer Error</h2>
                    <p>{initial.error}</p>
                </div>
            </div>
        );
    }

    let body: React.ReactNode = null;
    if (initial.mediaType === 'image' && initial.image) { body = <ImageViewer state={initial.image} filename={initial.fileName} />; }
    else if (initial.mediaType === 'audio' && initial.audio) { body = <AudioViewer state={initial.audio} filename={initial.fileName} />; }
    else if (initial.mediaType === 'video' && initial.video) { body = <VideoViewer state={initial.video} filename={initial.fileName} />; }
    else { body = <div style={{ padding: 16 }}>No media content available.</div>; }

    return (
        <div className="page">
            <style>{`
            body,html,#root,.page{margin:0;padding:0;width:100%;height:100%;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);font-size:13px;}
            .toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);}
            .toolbar h2{font-size:14px;margin-right:16px;}
            .toolbarX button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 12px;border-radius:3px;cursor:pointer;font-size:12px;}
            .toolbarX button:hover{background:var(--vscode-button-hoverBackground);}
            .info-bar{display:flex;gap:16px;padding:6px 12px;font-size:11px;opacity:0.8;border-bottom:1px solid var(--vscode-panel-border);}
            .canvas-area{flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;padding:20px;}
            canvas{image-rendering:pixelated;border:1px solid var(--vscode-panel-border);}
            .controls {display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--vscode-panel-border);}
            .controls input[type=range]{flex:1;}
            .frame-info{font-size:11px;min-width:140px;text-align:center;}
            .media-page{display:flex;flex-direction:column;height:100%;}
            .error-page{display:flex;align-items:center;justify-content:center;height:100vh;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);}
            .error{text-align:center;}
            .error h2{color:var(--vscode-errorForeground);margin-bottom:16px;}
            `}</style>
            {body}
        </div>
    );
}

function ThemedViewerApp() {
    const getIsDarkTheme = () => {
        const classList = document.body.classList;
        return classList.contains('vscode-dark') || classList.contains('vscode-high-contrast');
    };

    const [isDarkTheme, setIsDarkTheme] = useState(getIsDarkTheme);

    useEffect(() => {
        const updateTheme = () => setIsDarkTheme(getIsDarkTheme());
        const observer = new MutationObserver(updateTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
        updateTheme();

        return () => {
            observer.disconnect();
        };
    }, []);

    return (
        <ConfigProvider theme={{ algorithm: isDarkTheme ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
            <MediaViewerApp />
        </ConfigProvider>
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ThemedViewerApp />);
}
