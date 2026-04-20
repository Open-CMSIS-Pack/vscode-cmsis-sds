import { useEffect, useRef, useState } from 'react';

type AudioState = {
    samples: number[];
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
    const { samples, sampleRate, bitDepth, channels, totalSamples, totalRecords } = state;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [view, setView] = useState<{ start: number; end: number }>({ start: 0, end: 1 });

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

            let yMin = -1;
            let yMax = 1;
            for (const v of visible) {
                if (v < yMin) yMin = v;
                if (v > yMax) yMax = v;
            }
            const yPad = (yMax - yMin) * 0.1 || 0.1;
            yMin -= yPad;
            yMax += yPad;

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
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();

            if (visible.length > pW * 2) {
                ctx.fillStyle = '#4fc3f733';
                const binSize = visible.length / pW;
                for (let px = 0; px < pW; px++) {
                    const from = Math.floor(px * binSize);
                    const to = Math.min(Math.floor((px + 1) * binSize), visible.length);
                    let min = Infinity;
                    let max = -Infinity;
                    for (let j = from; j < to; j++) {
                        if (visible[j] < min) min = visible[j];
                        if (visible[j] > max) max = visible[j];
                    }
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

        let dragging = false;
        let dragX = 0;
        let dragViewStart = 0;
        let dragViewEnd = 0;
        const onDown = (e: MouseEvent) => {
            dragging = true;
            dragX = e.clientX;
            dragViewStart = view.start;
            dragViewEnd = view.end;
        };
        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            const pW = (canvas.width / dpr) - 70;
            const dx = e.clientX - dragX;
            const shift = -(dx / pW) * (dragViewEnd - dragViewStart);
            const start = Math.max(0, Math.min(1 - (dragViewEnd - dragViewStart), dragViewStart + shift));
            setView({ start, end: start + (dragViewEnd - dragViewStart) });
        };
        const onUp = () => {
            dragging = false;
        };

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
                <h2>{filename ? filename : 'Audio Viewer'}</h2>
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