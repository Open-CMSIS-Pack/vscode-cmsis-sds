/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

export type ChartMargin = { top: number; right: number; bottom: number; left: number };

export type PlotArea = { x: number; y: number; w: number; h: number };

export type EnvelopeBins = {
    min: Float32Array;
    max: Float32Array;
    sum: Float32Array;
    counts: Uint16Array;
};

export function getPlotArea(canvas: HTMLCanvasElement, dpr: number, margin: ChartMargin): PlotArea {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    return {
        x: margin.left,
        y: margin.top,
        w: w - margin.left - margin.right,
        h: h - margin.top - margin.bottom,
    };
}

export function createTimeToPixelMapper(viewStart: number, viewEnd: number, plot: PlotArea) {
    const span = Math.max(viewEnd - viewStart, 0.000001);
    return (time: number) => {
        const normalized = (time - viewStart) / span;
        return plot.x + normalized * plot.w;
    };
}

export function updateEnvelopeMode(
    previousMode: boolean,
    visibleSampleCount: number,
    plotWidthPixels: number,
    enterSamplesPerPixel = 1.4,
    exitSamplesPerPixel = 0.9,
): boolean {
    const samplesPerPixel = visibleSampleCount / Math.max(1, plotWidthPixels);
    if (previousMode) {
        return samplesPerPixel >= exitSamplesPerPixel;
    }
    return samplesPerPixel >= enterSamplesPerPixel;
}

export function createEnvelopeBins(binCount: number): EnvelopeBins {
    const min = new Float32Array(binCount);
    const max = new Float32Array(binCount);
    const sum = new Float32Array(binCount);
    const counts = new Uint16Array(binCount);

    for (let i = 0; i < binCount; i++) {
        min[i] = Infinity;
        max[i] = -Infinity;
    }

    return { min, max, sum, counts };
}

export function getEnvelopeBinIndex(time: number, viewStart: number, viewEnd: number, binCount: number): number {
    const span = Math.max(viewEnd - viewStart, 0.000001);
    const normalized = (time - viewStart) / span;
    return Math.min(binCount - 1, Math.max(0, Math.floor(normalized * (binCount - 1))));
}

export function accumulateEnvelopeValue(bins: EnvelopeBins, binIndex: number, value: number) {
    if (value < bins.min[binIndex]) bins.min[binIndex] = value;
    if (value > bins.max[binIndex]) bins.max[binIndex] = value;
    bins.sum[binIndex] += value;
    bins.counts[binIndex]++;
}