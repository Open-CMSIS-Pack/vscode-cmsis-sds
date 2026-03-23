import { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { WebviewMessenger, getInitialState, WebviewMessage } from '../../webview/bridge';
import { SdsFileStats, SdsMetadata } from '../../sds';

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
    const togglesRef = useRef<HTMLDivElement | null>(null);
    const statsBarRef = useRef<HTMLDivElement | null>(null);

    const samples = useMemo(() => initial.samples ?? [], [initial.samples]);
    const channelNames = useMemo(() => initial.channelNames ?? [], [initial.channelNames]);
    const stats = initial.stats ?? {} as SdsFileStats;
    const metadata = initial.metadata ?? null;
    const fileName = initial.fileName ?? 'SDS Viewer';

    useEffect(() => {
        if (initial.error) { return; }
        const canvas = canvasRef.current;
        const tooltip = tooltipRef.current;
        const toggles = togglesRef.current;
        const statsBar = statsBarRef.current;
        if (!canvas || !tooltip || !toggles || !statsBar) { return; }

        const COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#fff176', '#f06292', '#90a4ae', '#aed581'];
        const activeChannels = new Set(channelNames);
        let viewStart = 0;
        let viewEnd = samples.length > 0 ? samples[samples.length - 1].timeSeconds : 1;
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

        statsBar.innerHTML = [
            stat('Records', stats.totalRecords),
            stat('Duration', (stats.recordingTimeSeconds ?? 0).toFixed(2) + ' s'),
            stat('Interval', (stats.recordingIntervalMs || 0).toFixed(1) + ' ms'),
            stat('Data Rate', (stats.dataRate ?? 0) + ' B/s'),
            stat('Avg Block', (stats.avgBlockSize ?? 0) + ' B'),
            metadata ? stat('Frequency', metadata?.sds?.frequency + ' Hz') : '',
            metadata ? stat('Stream', metadata?.sds?.name) : '',
        ].filter(Boolean).join('');

        toggles.innerHTML = '';
        channelNames.forEach((name, i) => {
            const el = document.createElement('div');
            el.className = 'channel-toggle active';
            el.innerHTML = `<span class="dot" style="background:${COLORS[i % COLORS.length]}"></span>${name}`;
            el.addEventListener('click', () => {
                if (activeChannels.has(name)) {
                    activeChannels.delete(name);
                    el.classList.remove('active');
                } else {
                    activeChannels.add(name);
                    el.classList.add('active');
                }
                draw();
            });
            toggles.appendChild(el);
        });

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
            draw();
        }

        function getPlotArea() {
            if (!canvas) { return; }
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            return { x: MARGIN.left, y: MARGIN.top, w: w - MARGIN.left - MARGIN.right, h: h - MARGIN.top - MARGIN.bottom };
        }

        function draw() {
            if (!canvas || !ctx) { return; }
            const w = canvas.width / dpr;
            const h = canvas.height / dpr;
            ctx.clearRect(0, 0, w, h);

            const plot = getPlotArea();
            if (!plot || plot.w <= 0 || plot.h <= 0 || samples.length === 0) return;

            const visible = samples.filter(s => s.timeSeconds >= viewStart && s.timeSeconds <= viewEnd);
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

            const xToPixel = (t: number) => plot.x + (t - viewStart) / (viewEnd - viewStart) * plot.w;
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
            const range = viewEnd - viewStart;
            const factor = e.deltaY > 0 ? 1.2 : 0.8;
            const newRange = range * factor;
            const center = viewStart + ratio * range;
            viewStart = center - ratio * newRange;
            viewEnd = center + (1 - ratio) * newRange;
            draw();
        }

        function onMouseDown(e: MouseEvent) {
            isDragging = true;
            dragStartX = e.clientX;
            dragViewStart = viewStart;
            dragViewEnd = viewEnd;
        }

        function onMouseMove(e: MouseEvent) {
            if (!canvas) { return; }
            if (isDragging) {
                const plot = getPlotArea();
                if (!plot) { return; }
                const dx = e.clientX - dragStartX;
                const range = dragViewEnd - dragViewStart;
                const shift = -dx / plot.w * range;
                viewStart = dragViewStart + shift;
                viewEnd = dragViewEnd + shift;
                draw();
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const plot = getPlotArea();

            if (!plot) { return; }
            if (mx >= plot.x && mx <= plot.x + plot.w && my >= plot.y && my <= plot.y + plot.h) {
                const t = viewStart + (mx - plot.x) / plot.w * (viewEnd - viewStart);
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
                    tooltip.style.left = `${mx + 12}px`;
                    tooltip.style.top = `${my - 10}px`;
                    tooltip.textContent = text.trimEnd();
                }
            } else {
                if (!tooltip) { return; }
                tooltip.style.display = 'none';
            }
        }

        function onMouseUp() { isDragging = false; }
        function onMouseLeave() { isDragging = false; if (tooltip) { tooltip.style.display = 'none'; } }

        function onZoomIn() {
            const center = (viewStart + viewEnd) / 2;
            const range = (viewEnd - viewStart) * 0.5;
            viewStart = center - range / 2;
            viewEnd = center + range / 2;
            draw();
        }
        function onZoomOut() {
            const center = (viewStart + viewEnd) / 2;
            const range = (viewEnd - viewStart) * 2;
            viewStart = center - range / 2;
            viewEnd = center + range / 2;
            draw();
        }
        function onFit() {
            if (samples.length > 0) {
                viewStart = samples[0].timeSeconds;
                viewEnd = samples[samples.length - 1].timeSeconds;
                const pad = (viewEnd - viewStart) * 0.02;
                viewStart -= pad;
                viewEnd += pad;
            }
            draw();
        }

        const btnZoomIn = document.getElementById('btnZoomIn');
        const btnZoomOut = document.getElementById('btnZoomOut');
        const btnFit = document.getElementById('btnFit');
        const btnExport = document.getElementById('btnExport');
        const onExport = () => messenger.send({ command: 'exportCsv' });
        btnZoomIn?.addEventListener('click', onZoomIn);
        btnZoomOut?.addEventListener('click', onZoomOut);
        btnFit?.addEventListener('click', onFit);
        btnExport?.addEventListener('click', onExport);

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
            btnZoomIn?.removeEventListener('click', onZoomIn);
            btnZoomOut?.removeEventListener('click', onZoomOut);
            btnFit?.removeEventListener('click', onFit);
            btnExport?.removeEventListener('click', onExport);
            window.removeEventListener('resize', resize);
        };
    }, [channelNames, initial.error, metadata, samples, stats]);

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

    return (
        <div style={{ background: 'var(--vscode-editor-background)', color: 'var(--vscode-editor-foreground)', fontFamily: 'var(--vscode-font-family)', fontSize: 13, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <style>{`.toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap;} .toolbar h2{font-size:14px;font-weight:600;margin-right:16px;} .toolbar button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:4px 12px;border-radius:3px;cursor:pointer;font-size:12px;} .toolbar button:hover{background:var(--vscode-button-hoverBackground);} .channel-toggles{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;} .channel-toggle{display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:11px;cursor:pointer;border:1px solid var(--vscode-panel-border);} .channel-toggle.active{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);} .channel-toggle .dot{width:8px;height:8px;border-radius:50%;} .stats-bar{display:flex;gap:16px;padding:6px 12px;font-size:11px;opacity:0.8;border-bottom:1px solid var(--vscode-panel-border);flex-wrap:wrap;} .stats-bar .stat-label{opacity:0.7;} .canvas-container{position:relative;width:100%;flex:1;min-height:0;} canvas{position:absolute;top:0;left:0;width:100%;height:100%;} .tooltip{position:absolute;background:var(--vscode-editorHoverWidget-background);border:1px solid var(--vscode-editorHoverWidget-border);padding:6px 10px;border-radius:4px;font-size:11px;pointer-events:none;display:none;z-index:10;white-space:pre;}`}</style>
            <div className="toolbar">
                <h2>{fileName}</h2>
                <button id="btnZoomIn" title="Zoom In">🔍+</button>
                <button id="btnZoomOut" title="Zoom Out">🔍−</button>
                <button id="btnFit" title="Fit to Window">⊞ Fit</button>
                <button id="btnExport" title="Export CSV">📤 Export</button>
                <div className="channel-toggles" id="channelToggles" ref={togglesRef}></div>
            </div>
            <div className="stats-bar" id="statsBar" ref={statsBarRef}></div>
            <div className="canvas-container">
                <canvas id="chart" ref={canvasRef}></canvas>
                <div className="tooltip" id="tooltip" ref={tooltipRef}></div>
            </div>
        </div>
    );
}

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<ViewerApp />);
}
