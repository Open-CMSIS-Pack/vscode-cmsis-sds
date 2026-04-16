import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebviewMessenger, getInitialState, WebviewMessage } from '../../webview/bridge';
import { SdsFileStats, SdsMetadata } from '../../sds';
import { Button, Col, Row, Space } from 'antd';
import { ExpandOutlined, ExportOutlined, ZoomInOutlined, ZoomOutOutlined } from '@ant-design/icons';

type Sample = { timestamp: number; timeSeconds: number; values: Record<string, number> };

type InitialState = {
    samples?: Sample[];
    channelNames?: string[];
    stats?: SdsFileStats;
    metadata?: SdsMetadata;
    fileName?: string;
    error?: string;
};

type OutboundMessage = ({ command: 'exportCsv' } & WebviewMessage) | WebviewMessage;

const messenger = new WebviewMessenger<WebviewMessage, OutboundMessage>();

function ViewerApp() {
    const initial = getInitialState<InitialState>({});
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const tooltipRef = useRef<HTMLDivElement | null>(null);
    const [activeChannels, setActiveChannels] = useState(() => new Set(initial.channelNames));

    const samples = useMemo(() => initial.samples ?? [], [initial.samples]);
    const channelNames = useMemo(() => initial.channelNames ?? [], [initial.channelNames]);
    const stats = initial.stats ?? {} as SdsFileStats;
    const metadata = initial.metadata ?? null;
    const fileName = initial.fileName ?? 'SDS Viewer';

    const viewStartRef = useRef(0);
    const viewEndRef = useRef(1);
    const drawRef = useRef<() => void>(() => { });
    const lastAutoFitKeyRef = useRef<string | null>(null);

    const autoFitKey = useMemo(() => {
        if (samples.length === 0) {
            return `${fileName}:empty`;
        }
        return `${fileName}:${samples.length}:${samples[0].timeSeconds}:${samples[samples.length - 1].timeSeconds}`;
    }, [fileName, samples]);

    const onZoomIn = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 0.5;
        viewStartRef.current = center - range / 2;
        viewEndRef.current = center + range / 2;
        drawRef.current();
    }
    const onZoomOut = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 2;
        viewStartRef.current = center - range / 2;
        viewEndRef.current = center + range / 2;
        drawRef.current();
    }
    const onFit = () => {
        if (samples.length > 0) {
            viewStartRef.current = samples[0].timeSeconds;
            viewEndRef.current = samples[samples.length - 1].timeSeconds;
            const pad = (viewEndRef.current - viewStartRef.current) * 0.02;
            viewStartRef.current -= pad;
            viewEndRef.current += pad;
        }
        drawRef.current();
    }

    const onExport = () => messenger.send({ command: 'exportCsv' });
    const COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#fff176', '#f06292', '#90a4ae', '#aed581'];

    useEffect(() => {
        if (initial.error) { return; }
        const canvas = canvasRef.current;
        const tooltip = tooltipRef.current;
        if (!canvas || !tooltip) { return; }

        let isDragging = false;
        let dragStartX = 0;
        let dragViewStart = 0;
        let dragViewEnd = 0;
        let dpr = window.devicePixelRatio || 1;

        const escape = (val: unknown) => String(val).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const stat = (label: string, value: unknown) => {
            if (value === undefined || value === null) { return ''; }
            return `<span><span class="stat-label">${escape(label)}:</span> ${escape(value)}</span>`;
        };

        const ctx = canvas.getContext('2d');
        if (!ctx || !canvas) { return; }
        const MARGIN = { top: 20, right: 40, bottom: 40, left: 60 };

        function resize() {
            dpr = window.devicePixelRatio || 1;
            if (!ctx || !canvas) { return; }
            const rect = canvas.parentElement?.getBoundingClientRect();
            if (!rect) { return; }
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            drawRef.current();
        }

        function getPlotArea() {
            if (!canvas) { return; }
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            return { x: MARGIN.left, y: MARGIN.top, w: w - MARGIN.left - MARGIN.right, h: h - MARGIN.top - MARGIN.bottom };
        }

        drawRef.current = function draw() {
            if (!canvas || !ctx) { return; }
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);

            const plot = getPlotArea();
            if (!plot || plot.w <= 0 || plot.h <= 0 || samples.length === 0) return;

            const visible = samples.filter(s => s.timeSeconds >= viewStartRef.current && s.timeSeconds <= viewEndRef.current);
            if (visible.length === 0) return;

            let yMin = Infinity, yMax = -Infinity;
            for (const s of visible) {
                for (const ch of activeChannels) {
                    const v = s.values[ch];
                    if (v !== undefined) {
                        if (v < yMin) yMin = v;
                        if (v > yMax) yMax = v;
                    }
                }
            }
            if (yMin === yMax) { yMin -= 1; yMax += 1; }
            const yPad = (yMax - yMin) * 0.05;
            yMin -= yPad; yMax += yPad;

            const xToPixel = (t: number) => plot.x + (t - viewStartRef.current) / (viewEndRef.current - viewStartRef.current) * plot.w;
            const yToPixel = (v: number) => plot.y + plot.h - (v - yMin) / (yMax - yMin) * plot.h;

            ctx.strokeStyle = 'rgba(128,128,128,0.15)';
            ctx.lineWidth = 1;
            const xTicks = niceScale(viewStartRef.current, viewEndRef.current, 8);
            const yTicks = niceScale(yMin, yMax, 6);

            ctx.beginPath();
            for (const xt of xTicks) {
                const px = xToPixel(xt);
                ctx.moveTo(px, plot.y);
                ctx.lineTo(px, plot.y + plot.h);
            }
            for (const yt of yTicks) {
                const py = yToPixel(yt);
                ctx.moveTo(plot.x, py);
                ctx.lineTo(plot.x + plot.w, py);
            }
            ctx.stroke();

            ctx.fillStyle = getComputedStyle(document.body).color || '#ccc';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            for (const xt of xTicks) { ctx.fillText(formatTime(xt), xToPixel(xt), plot.y + plot.h + 16); }
            ctx.textAlign = 'right';
            for (const yt of yTicks) { ctx.fillText(yt.toPrecision(4), plot.x - 6, yToPixel(yt) + 3); }

            ctx.save();
            ctx.textAlign = 'center';
            ctx.fillText('Time (s)', plot.x + plot.w / 2, plot.y + plot.h + 34);
            ctx.restore();

            channelNames.forEach((ch, i) => {
                if (!activeChannels.has(ch)) return;
                ctx.strokeStyle = COLORS[i % COLORS.length];
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                let started = false;
                for (const s of visible) {
                    const v = s.values[ch];
                    if (v === undefined) continue;
                    const px = xToPixel(s.timeSeconds);
                    const py = yToPixel(v);
                    if (!started) { ctx.moveTo(px, py); started = true; }
                    else { ctx.lineTo(px, py); }
                }
                ctx.stroke();
            });

            ctx.strokeStyle = 'rgba(128,128,128,0.3)';
            ctx.lineWidth = 1;
            ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
        }

        function niceScale(min: number, max: number, maxTicks: number) {
            const range = max - min;
            if (range <= 0) return [min];
            const rough = range / maxTicks;
            const pow = Math.pow(10, Math.floor(Math.log10(rough)));
            let step = pow;
            if (rough / pow >= 5) step = pow * 5;
            else if (rough / pow >= 2) step = pow * 2;
            const ticks: number[] = [];
            let t = Math.ceil(min / step) * step;
            while (t <= max) { ticks.push(t); t += step; }
            return ticks;
        }

        function formatTime(t: number) {
            if (Math.abs(t) < 0.001) return '0';
            if (Math.abs(t) < 1) return (t * 1000).toFixed(1) + 'ms';
            return t.toFixed(3) + 's';
        }

        function onWheel(e: WheelEvent) {
            if (!canvas) { return; }
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const plot = getPlotArea();
            if (!plot) { return; }
            const ratio = (mouseX - plot.x) / plot.w;
            const range = viewEndRef.current - viewStartRef.current;
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            const newRange = range * factor;
            const center = viewStartRef.current + ratio * range;
            viewStartRef.current = center - ratio * newRange;
            viewEndRef.current = center + (1 - ratio) * newRange;
            drawRef.current();
        }

        function onMouseDown(e: MouseEvent) {
            isDragging = true;
            dragStartX = e.clientX;
            dragViewStart = viewStartRef.current;
            dragViewEnd = viewEndRef.current;
        }

        function onMouseMove(e: MouseEvent) {
            if (!canvas) { return; }
            if (isDragging) {
                const plot = getPlotArea();
                if (!plot) { return; }
                const dx = e.clientX - dragStartX;
                const range = dragViewEnd - dragViewStart;
                const shift = -dx / plot.w * range;
                viewStartRef.current = dragViewStart + shift;
                viewEndRef.current = dragViewEnd + shift;
                drawRef.current();
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const plot = getPlotArea();

            if (!plot) { return; }
            if (mx >= plot.x && mx <= plot.x + plot.w && my >= plot.y && my <= plot.y + plot.h) {
                const t = viewStartRef.current + (mx - plot.x) / plot.w * (viewEndRef.current - viewStartRef.current);
                let best: Sample | null = null; let bestDist = Infinity;
                for (const s of samples) {
                    const d = Math.abs(s.timeSeconds - t);
                    if (d < bestDist) { bestDist = d; best = s; }
                }
                if (best) {
                    let text = `Time: ${best.timeSeconds.toFixed(4)}s\n`;
                    text += `Timestamp: ${best.timestamp}\n`;
                    for (const ch of channelNames) {
                        if (activeChannels.has(ch) && best.values[ch] !== undefined) {
                            text += `${ch}: ${best.values[ch].toFixed(4)}\n`;
                        }
                    }
                    if (!tooltip) { return; }
                    tooltip.style.display = 'block';
                    tooltip.style.left = `${mx}px`;
                    tooltip.style.top = `${my + 30}px`;
                    tooltip.textContent = text.trimEnd();
                }
            } else {
                if (!tooltip) { return; }
                tooltip.style.display = 'none';
            }
        }

        function onMouseUp() { isDragging = false; }
        function onMouseLeave() { isDragging = false; if (tooltip) { tooltip.style.display = 'none'; } }


        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('mousedown', onMouseDown);
        canvas.addEventListener('mousemove', onMouseMove);
        canvas.addEventListener('mouseup', onMouseUp);
        canvas.addEventListener('mouseleave', onMouseLeave);
        window.addEventListener('resize', resize);
        resize();

        if (samples.length > 0 && lastAutoFitKeyRef.current !== autoFitKey) {
            lastAutoFitKeyRef.current = autoFitKey;
            onFit();
        }

        return () => {
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('mousedown', onMouseDown);
            canvas.removeEventListener('mousemove', onMouseMove);
            canvas.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('mouseleave', onMouseLeave);
            window.removeEventListener('resize', resize);
        };
    }, [autoFitKey, channelNames, initial.error, metadata, samples, stats, activeChannels]);

    if (initial.error) {
        return (
            <div style={{ background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontFamily: 'var(--vscode-font-family)', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
                <div style={{ textAlign: 'center' }}>
                    <h2 style={{ color: 'var(--vscode-errorForeground)', marginBottom: 16 }}>Failed to load SDS Viewer</h2>
                    <p>{initial.error}</p>
                </div>
            </div>
        );
    }

    const toggleChannel = (name: string) => {
        setActiveChannels(prev => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
        drawRef.current();
    };

    const statsTitleStyle: React.CSSProperties = {
        opacity: 0.5,
        fontSize: '80%'
    };

    const statsValueStyle: React.CSSProperties = {
        paddingRight: 32,
        fontSize: '80%'
    };

    const canvasContainerStyle: React.CSSProperties = {
        position: 'relative',
        width: '100%',
        flex: 1,
        minHeight: 0
    };

    const canvasStyle: React.CSSProperties = {
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%'
    };

    const toolTipStyle: React.CSSProperties = {
        position: 'absolute',
        background: 'var(--vscode-editorHoverWidget-background)',
        border: '1px solid var(--vscode-editorHoverWidget-border)',
        padding: '6px 10px',
        borderRadius: 4,
        fontSize: 11,
        pointerEvents: 'none',
        display: 'none',
        zIndex: 10,
        whiteSpace: 'pre'
    };

    return (
        <div style={{ background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 13, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <Row>
                <Col span={4} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {fileName}
                </Col>
                <Col span={10} >
                    <Space>
                        <Button icon={<ZoomInOutlined />} type="primary" title="Zoom In" onClick={onZoomIn}></Button>
                        <Button icon={<ZoomOutOutlined />} type="primary" title="Zoom Out" onClick={onZoomOut}></Button>
                        <Button icon={<ExpandOutlined />} type="primary" title="Fit to Window" onClick={onFit}></Button>
                        <Button icon={<ExportOutlined />} type="primary" title="Export CSV" onClick={onExport}></Button>
                    </Space>
                </Col>
                <Col span={10} style={{ textAlign: 'right' }}>
                    <Space.Compact>
                        {channelNames.map((name, i) => {
                            const cColor = COLORS[i % COLORS.length];
                            const active = activeChannels.has(name);
                            return (
                                <Button key={name} style={{ borderColor: cColor, backgroundColor: active ? cColor : 'transparent' }} ghost onClick={() => toggleChannel(name)}>
                                    {name}
                                </Button>
                            )
                        })}
                    </Space.Compact>
                </Col>
            </Row>
            <Row gutter={8}>
                <Col style={statsTitleStyle}>Records</Col><Col style={statsValueStyle}>{stats.totalRecords}</Col>
                <Col style={statsTitleStyle}>Duration</Col><Col style={statsValueStyle}>{(stats.recordingTimeSeconds ?? 0).toFixed(2)} s</Col>
                <Col style={statsTitleStyle}>Interval</Col><Col style={statsValueStyle}>{(stats.recordingIntervalMs || 0).toFixed(1)} ms</Col>
                <Col style={statsTitleStyle}>Data Rate</Col><Col style={statsValueStyle}>{(stats.dataRate ?? 0)} B/s</Col>
                <Col style={statsTitleStyle}>Avg Block</Col><Col style={statsValueStyle}>{(stats.avgBlockSize ?? 0)} B</Col>
                {metadata &&
                    <>
                        <Col style={statsTitleStyle}>Frequency</Col><Col style={statsValueStyle}>{metadata?.sds?.frequency} Hz</Col>
                        <Col style={statsTitleStyle}>Stream</Col><Col style={statsValueStyle}>{metadata?.sds?.name}</Col>
                    </>
                }
            </Row>
            <div style={canvasContainerStyle}>
                <canvas id="chart" ref={canvasRef} style={canvasStyle}></canvas>
                <div id="tooltip" ref={tooltipRef} style={toolTipStyle}></div>
            </div>
        </div >
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ViewerApp />);
}
