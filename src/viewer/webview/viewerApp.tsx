import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WebviewMessenger, getInitialState, WebviewMessage } from '../../webview/bridge';
import { SdsFileStats, SdsMetadata } from '../../sds';
import { Button, Col, Row, Slider, Space } from 'antd';
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

    const domainStart = samples.length > 0 ? samples[0].timeSeconds : 0;
    const domainEnd = samples.length > 0 ? samples[samples.length - 1].timeSeconds : 1;
    const domainSpan = Math.max(domainEnd - domainStart, 0.001);
    const minViewSpan = Math.max(domainSpan / 1000, 0.001);
    const sliderStep = Math.max(domainSpan / 1000, 0.0001);

    const [viewRange, setViewRange] = useState<[number, number]>(() => [domainStart, domainEnd]);

    const clampRange = useCallback((start: number, end: number): [number, number] => {
        if (samples.length === 0) {
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

        if (start < domainStart) {
            start = domainStart;
        }
        if (end > domainEnd) {
            end = domainEnd;
        }

        if (end - start < Math.min(minViewSpan, domainSpan)) {
            end = Math.min(domainEnd, start + Math.min(minViewSpan, domainSpan));
            start = Math.max(domainStart, end - Math.min(minViewSpan, domainSpan));
        }

        if (span <= 0) {
            return [domainStart, domainEnd];
        }

        return [start, end];
    }, [domainEnd, domainSpan, domainStart, minViewSpan, samples.length]);

    const autoFitKey = useMemo(() => {
        if (samples.length === 0) {
            return `${fileName}:empty`;
        }
        return `${fileName}:${samples.length}:${samples[0].timeSeconds}:${samples[samples.length - 1].timeSeconds}`;
    }, [fileName, samples]);

    const onZoomIn = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 0.5;
        const [start, end] = clampRange(center - range / 2, center + range / 2);
        setViewRange([start, end]);
    }
    const onZoomOut = () => {
        const center = (viewStartRef.current + viewEndRef.current) / 2;
        const range = (viewEndRef.current - viewStartRef.current) * 2;
        const [start, end] = clampRange(center - range / 2, center + range / 2);
        setViewRange([start, end]);
    }
    const onFit = () => {
        if (samples.length > 0) {
            setViewRange([domainStart, domainEnd]);
        }
    }

    useEffect(() => {
        viewStartRef.current = viewRange[0];
        viewEndRef.current = viewRange[1];
        drawRef.current();
    }, [viewRange]);

    useEffect(() => {
        if (samples.length === 0) {
            setViewRange([0, 1]);
            return;
        }
        //setViewRange([domainStart, Math.min(domainSpan, minViewSpan * 100) + domainStart]);
        setViewRange([domainStart, domainEnd]);
    }, [autoFitKey, domainEnd, domainStart, samples.length]);

    const onSliderChange = (value: number[]) => {
        if (value.length !== 2) {
            return;
        }
        const [start, end] = clampRange(value[0], value[1]);
        setViewRange([start, end]);
    };

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
        let envelopeModeActive = false;

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

        function lowerBoundTime(target: number) {
            let lo = 0;
            let hi = samples.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (samples[mid].timeSeconds < target) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            return lo;
        }

        function upperBoundTime(target: number) {
            let lo = 0;
            let hi = samples.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (samples[mid].timeSeconds <= target) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            return lo;
        }

        function nearestSampleByTime(target: number) {
            if (samples.length === 0) {
                return null;
            }
            const right = lowerBoundTime(target);
            if (right <= 0) {
                return samples[0];
            }
            if (right >= samples.length) {
                return samples[samples.length - 1];
            }
            const leftSample = samples[right - 1];
            const rightSample = samples[right];
            return Math.abs(leftSample.timeSeconds - target) <= Math.abs(rightSample.timeSeconds - target)
                ? leftSample
                : rightSample;
        }

        drawRef.current = function draw() {
            if (!canvas || !ctx) { return; }
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);

            const plot = getPlotArea();
            if (!plot || plot.w <= 0 || plot.h <= 0 || samples.length === 0) return;

            const viewStart = viewStartRef.current;
            const viewEnd = viewEndRef.current;
            const viewSpan = Math.max(viewEnd - viewStart, 0.000001);
            const visibleStartIndex = lowerBoundTime(viewStart);
            const visibleEndIndex = upperBoundTime(viewEnd);
            if (visibleEndIndex <= visibleStartIndex) return;
            const visibleCount = visibleEndIndex - visibleStartIndex;
            const activeChannelNames = channelNames.filter(ch => activeChannels.has(ch));
            if (activeChannelNames.length === 0) return;

            let yMin = Infinity, yMax = -Infinity;
            for (let idx = visibleStartIndex; idx < visibleEndIndex; idx++) {
                const s = samples[idx];
                for (const ch of activeChannelNames) {
                    const v = s.values[ch];
                    if (v !== undefined) {
                        if (v < yMin) yMin = v;
                        if (v > yMax) yMax = v;
                    }
                }
            }
            if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) return;
            if (yMin === yMax) { yMin -= 1; yMax += 1; }
            const yPad = (yMax - yMin) * 0.05;
            yMin -= yPad; yMax += yPad;

            const xToPixel = (t: number) => plot.x + (t - viewStart) / viewSpan * plot.w;
            const yToPixel = (v: number) => plot.y + plot.h - (v - yMin) / (yMax - yMin) * plot.h;

            ctx.strokeStyle = 'rgba(128,128,128,0.15)';
            ctx.lineWidth = 1;
            const xTicks = niceScale(viewStart, viewEnd, 8);
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

            const binCount = Math.max(1, Math.floor(plot.w));
            const samplesPerPixel = visibleCount / binCount;
            const envelopeEnterSpp = 1.4;
            const envelopeExitSpp = 0.9;
            if (envelopeModeActive) {
                envelopeModeActive = samplesPerPixel >= envelopeExitSpp;
            } else {
                envelopeModeActive = samplesPerPixel >= envelopeEnterSpp;
            }
            const useEnvelope = envelopeModeActive;

            channelNames.forEach((ch, i) => {
                if (!activeChannels.has(ch)) return;
                ctx.strokeStyle = COLORS[i % COLORS.length];
                ctx.lineWidth = 1.5;

                if (useEnvelope) {
                    const binMin = new Float32Array(binCount);
                    const binMax = new Float32Array(binCount);
                    for (let b = 0; b < binCount; b++) {
                        binMin[b] = Infinity;
                        binMax[b] = -Infinity;
                    }

                    for (let idx = visibleStartIndex; idx < visibleEndIndex; idx++) {
                        const s = samples[idx];
                        const v = s.values[ch];
                        if (v === undefined) continue;
                        const normalized = (s.timeSeconds - viewStart) / viewSpan;
                        const xBin = Math.min(binCount - 1, Math.max(0, Math.floor(normalized * (binCount - 1))));
                        if (v < binMin[xBin]) binMin[xBin] = v;
                        if (v > binMax[xBin]) binMax[xBin] = v;
                    }

                    ctx.beginPath();
                    for (let b = 0; b < binCount; b++) {
                        if (!Number.isFinite(binMin[b]) || !Number.isFinite(binMax[b])) {
                            continue;
                        }
                        const px = plot.x + b;
                        const pyMin = yToPixel(binMin[b]);
                        const pyMax = yToPixel(binMax[b]);
                        ctx.moveTo(px, pyMin);
                        ctx.lineTo(px, pyMax);
                    }
                    ctx.stroke();
                } else {
                    ctx.beginPath();
                    let started = false;
                    let lastXBin = -1;
                    for (let idx = visibleStartIndex; idx < visibleEndIndex; idx++) {
                        const s = samples[idx];
                        const v = s.values[ch];
                        if (v === undefined) continue;
                        const px = xToPixel(s.timeSeconds);
                        const xBin = Math.round(px);
                        if (started && xBin === lastXBin) {
                            continue;
                        }
                        const py = yToPixel(v);
                        if (!started) { ctx.moveTo(px, py); started = true; }
                        else { ctx.lineTo(px, py); }
                        lastXBin = xBin;
                    }
                    ctx.stroke();
                }
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
            const [start, end] = clampRange(center - ratio * newRange, center + (1 - ratio) * newRange);
            setViewRange([start, end]);
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
                const [start, end] = clampRange(dragViewStart + shift, dragViewEnd + shift);
                setViewRange([start, end]);
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const plot = getPlotArea();

            if (!plot) { return; }
            if (mx >= plot.x && mx <= plot.x + plot.w && my >= plot.y && my <= plot.y + plot.h) {
                const t = viewStartRef.current + (mx - plot.x) / plot.w * (viewEndRef.current - viewStartRef.current);
                const best = nearestSampleByTime(t);
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

        return () => {
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('mousedown', onMouseDown);
            canvas.removeEventListener('mousemove', onMouseMove);
            canvas.removeEventListener('mouseup', onMouseUp);
            canvas.removeEventListener('mouseleave', onMouseLeave);
            window.removeEventListener('resize', resize);
        };
    }, [channelNames, clampRange, initial.error, metadata, samples, stats, activeChannels]);

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

    const sliderContainerStyle: React.CSSProperties = {
        padding: '2px 8px 8px 8px'
    };

    const sliderMetaStyle: React.CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        gap: 12
    };

    const sliderStyle: React.CSSProperties = {
        flex: 1,
        margin: 0
    };

    const windowLength = Math.max(0, viewRange[1] - viewRange[0]);

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
                <Col style={statsTitleStyle}>Duration</Col><Col style={statsValueStyle}>{(stats.recordingTimeSeconds ?? 0).toFixed(3)} s</Col>
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
            <div style={sliderContainerStyle}>
                <div style={sliderMetaStyle}>
                    <Slider
                        range={{ draggableTrack: true }}
                        min={domainStart}
                        max={domainEnd}
                        step={sliderStep}
                        value={viewRange}
                        onChange={onSliderChange}
                        style={sliderStyle}
                        tooltip={{ formatter: (v) => `${(v ?? 0).toFixed(3)}s` }}
                        disabled={samples.length === 0 || domainEnd <= domainStart}
                    />
                    <span style={{ opacity: 0.75, fontSize: '80%', whiteSpace: 'nowrap' }}>
                        Window: {windowLength.toFixed(3)} s
                    </span>
                    <Button icon={<ZoomInOutlined />} type="link" title="Zoom In" onClick={onZoomIn}></Button>
                    <Button icon={<ZoomOutOutlined />} type="link" title="Zoom Out" onClick={onZoomOut} disabled={domainSpan === windowLength}></Button>
                </div>
            </div>
        </div >
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ViewerApp />);
}
