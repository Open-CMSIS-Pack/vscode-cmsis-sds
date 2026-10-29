import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseChartViewer } from '../../src/viewer/webview/components/baseChartViewer';

const chart = vi.hoisted(() => ({ line: vi.fn(() => null) }));
vi.mock('@ant-design/charts', () => ({ Line: chart.line, ChartEvent: {} }));

describe('BaseChartViewer viewport bounds', () => {
    beforeEach(() => { chart.line.mockClear(); });

    it('keeps the requested viewport even when loaded points cover only part of it', () => {
        renderToString(createElement(BaseChartViewer, {
            data: [{ x: 12, y: 1, index: 0 }, { x: 13, y: 2, index: 1 }],
            xRange: [10, 20], color: ['red'],
        }));
        expect(chart.line).toHaveBeenCalledWith(expect.objectContaining({
            scale: { x: { domain: [10, 20], nice: false }, color: { range: ['red'] } },
        }), expect.anything());
    });

    it('updates the plotted domain when the fitted or following viewport grows', () => {
        for (const xRange of [[0, 10], [0, 19], [9, 19]] as [number, number][]) {
            renderToString(createElement(BaseChartViewer, { data: [], xRange }));
            expect(chart.line).toHaveBeenLastCalledWith(expect.objectContaining({
                scale: { x: { domain: xRange, nice: false } },
            }), expect.anything());
        }
    });
});
