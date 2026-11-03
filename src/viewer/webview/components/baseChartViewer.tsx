/**
 * Copyright 2026 Arm Limited
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Shared base for time-series chart viewers using Ant Design Charts
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartEvent, Line } from '@ant-design/charts';

const ChartLine = React.memo(Line);
const slider = { x: false, y: false };

interface ChartCoordinateLike {
    x: number;
    y: number;
}
interface ChartCoordinate {
    start?: ChartCoordinateLike;
    end?: ChartCoordinateLike;
    options?: {
        paddingLeft: number;
        paddingRight: number;
        marginLeft: number;
        marginRight: number;
        width: number;
        height: number;
    };
}

interface ChartPlotLike {
    chart?: {
        getCoordinate: () => ChartCoordinate | undefined;
        getContext: () => {
            canvas?: {
                addEventListener: (event: string, handler: (event: ChartPointerEvent) => void, capture: boolean) => void;
                removeEventListener: (event: string, handler: (event: ChartPointerEvent) => void, capture: boolean) => void;
            };
            views: {
                layout: { width: number; height: number; marginLeft: number; marginRight: number; marginTop: number; marginBottom: number; paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number; innerWidth: number; innerHeight: number };
                scale?: {
                    color?: { getOptions: () => { domain?: unknown[] } };
                    x?: { invert: (value: number) => number };
                };
            }[];
        };
        getDataByXY: (point: ChartCoordinateLike, options?: { shared: boolean }) => Record<string, ChartSample> | undefined;
        emit?: (event: string, payload: { data: { channel: string; value: unknown } }) => void;
        on?: (event: string, handler: (e: ChartPointerEvent) => void) => void;
        off?: (event: string, handler: (e: ChartPointerEvent) => void) => void;
    };
}

interface ChartEventTarget {
    attributes?: { class?: string };
    className?: string;
    parentNode?: ChartEventTarget | null;
    __data__?: { index?: number };
}

interface ChartPointerEvent {
    target?: ChartEventTarget;
    data?: { channel?: string; value?: unknown; values?: unknown[] };
    buttons?: number;
    shiftKey?: boolean;
    stopPropagation?: () => void;
    nativeEvent?: MouseEvent;
    type: (typeof ChartEvent)[keyof typeof ChartEvent];
    x: number;
    y: number;
}

export interface ChartSample {
    x: number;
    y: number;
    index: number;
    [key: string]: unknown;
}

export interface BaseChartViewerProps {
    data: ChartSample[];
    xField?: string;
    yField?: string;
    seriesField?: string;
    color?: string[];
    highlightedX?: number | null;
    xRange?: [number, number];
    onCursorChange?: (x: number, block: number | null) => void;
    onZoomRangeChange?: (range: [number, number]) => void;
    [key: string]: unknown;
}

export const BaseChartViewer: React.FC<BaseChartViewerProps> = ({
    data,
    xField = 'x',
    yField = 'y',
    seriesField,
    title: _title,
    color,
    highlightedX,
    xRange,
    onCursorChange,
    onZoomRangeChange,
    ...rest
}) => {
    type PlotRegion = { left: number; right: number; top: number; bottom: number };

    const containerRef = useRef<HTMLDivElement | null>(null);
    const plotRef = useRef<ChartPlotLike | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const detachCanvasListenersRef = useRef<(() => void) | null>(null);
    const onCursorChangeRef = useRef<typeof onCursorChange>(onCursorChange);
    const selectedValuesRef = useRef<unknown[] | undefined>(undefined);
    const [plotRegion, setPlotRegion] = useState<PlotRegion | null>(null);

    const resolveXRange = useMemo<[number, number] | null>(() => {
        if (xRange && Number.isFinite(xRange[0]) && Number.isFinite(xRange[1]) && xRange[1] > xRange[0]) {
            return xRange;
        }

        if (data.length === 0) {
            return null;
        }

        let minX = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        for (const point of data) {
            const x = point?.[xField];
            if (typeof x !== 'number' || !Number.isFinite(x)) {
                continue;
            }
            if (x < minX) {
                minX = x;
            }
            if (x > maxX) {
                maxX = x;
            }
        }

        if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
            return null;
        }

        return [minX, maxX];
    }, [data, xField, xRange]);

    const resolvePlotRegion = useCallback((plot: ChartPlotLike, canvasEl: HTMLCanvasElement | null) => {
        if (!canvasEl) {
            return null;
        }

        const layout = plot?.chart?.getContext().views[0].layout;

        if (layout && Number.isFinite(layout.width) && Number.isFinite(layout.height)) {
            return {
                left: layout.marginLeft + layout.paddingLeft,
                right: layout.innerWidth + layout.marginLeft + layout.paddingLeft,
                top: layout.marginTop + layout.paddingTop,
                bottom: layout.innerHeight + layout.marginTop + layout.paddingTop,
            };
        }

        return { left: 0, right: canvasEl.clientWidth, top: 0, bottom: canvasEl.clientHeight };
    }, []);

    const setPlotRegionIfChanged = useCallback((nextRegion: PlotRegion | null) => {
        setPlotRegion((prevRegion) => {
            if (prevRegion === null || nextRegion === null) {
                return prevRegion === nextRegion ? prevRegion : nextRegion;
            }

            if (
                prevRegion.left === nextRegion.left &&
                prevRegion.right === nextRegion.right &&
                prevRegion.top === nextRegion.top &&
                prevRegion.bottom === nextRegion.bottom
            ) {
                return prevRegion;
            }

            return nextRegion;
        });
    }, []);

    const xValueFromClientPoint = useCallback((clientX: number, clientY: number) => {
        if (!resolveXRange) {
            return null;
        }

        const rect = canvasRef.current?.getBoundingClientRect() ?? containerRef.current?.getBoundingClientRect();
        if (!rect) {
            return null;
        }

        if (!plotRegion) {
            return null;
        }

        const regionWidth = plotRegion.right - plotRegion.left;
        const regionHeight = plotRegion.bottom - plotRegion.top;
        if (regionWidth <= 0 || regionHeight <= 0) {
            return null;
        }
        const localX = clientX - rect.left;
        const localY = clientY - rect.top;
        // Ignore events above/below the plotted data region (axes, legend, padding).
        if (localY < plotRegion.top || localY > plotRegion.bottom) {
            return null;
        }

        if (localX < plotRegion.left || localX > plotRegion.right) {
            return null;
        }

        const relative = (localX - plotRegion.left) / regionWidth;
        return resolveXRange[0] + (resolveXRange[1] - resolveXRange[0]) * relative;
    }, [plotRegion, resolveXRange]);

    const cursorLeftFromX = useCallback((x: number | null | undefined) => {
        if (x === null || x === undefined || !Number.isFinite(x)) {
            return null;
        }
        if (!resolveXRange || !plotRegion) {
            return null;
        }

        const span = resolveXRange[1] - resolveXRange[0];
        const plotWidth = plotRegion.right - plotRegion.left;
        if (span <= 0 || plotWidth <= 0 || x < resolveXRange[0] || x > resolveXRange[1]) {
            return null;
        }

        return plotRegion.left + (plotWidth * ((x - resolveXRange[0]) / span));
    }, [plotRegion, resolveXRange]);

    const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        if (!onZoomRangeChange || !resolveXRange) {
            return;
        }

        event.preventDefault();

        const currentRange = xRange && Number.isFinite(xRange[0]) && Number.isFinite(xRange[1]) && xRange[1] > xRange[0]
            ? xRange
            : resolveXRange;
        const currentSpan = currentRange[1] - currentRange[0];
        if (!Number.isFinite(currentSpan) || currentSpan <= 0) {
            return;
        }

        if (event.shiftKey) {
            const wheelDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
            if (wheelDelta === 0) {
                return;
            }

            const direction = wheelDelta > 0 ? 1 : -1;
            const panAmount = currentSpan * 0.08 * direction;
            onZoomRangeChange([currentRange[0] + panAmount, currentRange[1] + panAmount]);
            return;
        }

        const focusTime = xValueFromClientPoint(event.clientX, event.clientY);
        const anchorTime = focusTime === null ? (currentRange[0] + currentRange[1]) / 2 : focusTime;
        const relativeAnchor = (anchorTime - currentRange[0]) / currentSpan;
        const zoomFactor = Math.exp(event.deltaY * 0.0015);
        const nextSpan = currentSpan * zoomFactor;

        const nextStart = anchorTime - (nextSpan * relativeAnchor);
        const nextEnd = nextStart + nextSpan;
        onZoomRangeChange([nextStart, nextEnd]);
    }, [onZoomRangeChange, resolveXRange, xRange, xValueFromClientPoint]);

    useEffect(() => {
        onCursorChangeRef.current = onCursorChange;
    }, [onCursorChange]);

    useEffect(() => {
        return () => {
            if (detachCanvasListenersRef.current) {
                detachCanvasListenersRef.current();
                detachCanvasListenersRef.current = null;
            }
        };
    }, []);

    const {
        tooltip: restTooltip,
        axis: restAxis,
        onReady: userOnReady,
        ...otherRest
    } = rest as {
        tooltip?: { title?: unknown;[key: string]: unknown };
        axis?: { x?: { labelFormatter?: unknown;[key: string]: unknown };[key: string]: unknown };
        onReady?: (plot: ChartPlotLike) => void;
        [key: string]: unknown;
    };

    const userTooltip = restTooltip as { title?: unknown } | undefined;
    const blockLabelForX = useCallback((xValue: number) => {
        if (!Number.isFinite(xValue)) {
            return null;
        }

        for (let index = data.length; index > 0; index--) {
            const point = data[index - 1];
            const pointX = point?.[xField];
            if (typeof pointX === 'number' && pointX <= xValue) {
                return String(point.index + 1);
            }
        }

        for (const point of data) {
            const pointX = point?.[xField];
            if (typeof pointX === 'number' && pointX >= xValue) {
                return String(point.index + 1);
            }
        }

        return null;
    }, [data, xField]);

    const userTooltipTitle = userTooltip?.title;
    const tooltipTitle = useCallback((value: ChartSample) => {
        const blockIndex = typeof value?.index === 'number' ? value.index : null;
        const blockTitle = blockIndex !== null ? `Block: ${blockIndex + 1}` : 'Block';

        if (typeof userTooltipTitle === 'function') {
            const userTitle = userTooltipTitle(value);
            if (typeof userTitle === 'string' && userTitle.length > 0) {
                return `${blockTitle} | ${userTitle}`;
            }
        }

        return blockTitle;
    }, [userTooltipTitle]);

    const labelFormatter = useCallback((value: string) => {
        return blockLabelForX(Number(value)) ?? value;
    }, [blockLabelForX]);

    const samplesByX = useMemo(() => {
        const samples = new Map<number, ChartSample>();
        for (const point of data) {
            const position = point[xField];
            if (typeof position === 'number' && Number.isFinite(position)) {
                samples.set(position, point);
            }
        }
        return samples;
    }, [data, xField]);

    const tickPositions = useMemo(() => [...samplesByX.keys()].sort((left, right) => left - right), [samplesByX]);

    const tickMethod = useCallback((min: number, max: number, requestedCount?: number) => {
        const positions = tickPositions.filter(position => position >= min && position <= max);
        const count = requestedCount !== undefined && Number.isFinite(requestedCount)
            ? Math.max(0, Math.floor(requestedCount))
            : positions.length;
        if (positions.length <= count) {
            return positions;
        }
        if (count <= 1) {
            return positions.slice(0, count);
        }
        return Array.from({ length: count }, (_, index) => {
            return positions[Math.round(index * (positions.length - 1) / (count - 1))];
        });
    }, [tickPositions]);

    const { scale, legend } = useMemo(() => ({
        scale: {
            ...(color && color.length > 0 ? { color: { range: color } } : {}),
            x: {
                ...(resolveXRange ? { domain: resolveXRange, nice: false } : {}),
                tickMethod,
            },
        },
        legend: {
            position: 'top',
            color: { defaultSelect: selectedValuesRef.current },
        },
    }), [color, resolveXRange, tickMethod]);

    const axis = useMemo(() => ({
        ...(restAxis ?? {}),
        x: {
            ...(restAxis?.x ?? {}),
            labelFormatter,
        },
    }), [restAxis, labelFormatter]);

    const tooltip = useMemo(() => ({
        showMarkers: true,
        ...(userTooltip ?? {}),
        title: tooltipTitle,
    }), [userTooltip, tooltipTitle]);

    const config = {
        data,
        xField,
        yField,
        seriesField,
        // Ensure multi-series line colors follow the provided palette.
        colorField: seriesField,
        color,
        scale,
        ...otherRest,
        axis,
        animate: false,
        legend,
        tooltip,
        slider,
    };

    const mergedOnReady = useCallback((plot: ChartPlotLike) => {
        if (detachCanvasListenersRef.current) {
            detachCanvasListenersRef.current();
            detachCanvasListenersRef.current = null;
        }

        const canvasEl = containerRef.current?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        canvasRef.current = canvasEl;

        if (canvasEl) {
            const emitCursor = (time: number, blockIndex: number) => {
                if (!Number.isFinite(time) || !Number.isFinite(blockIndex)) {
                    return;
                }
                onCursorChangeRef.current?.(time, blockIndex);
            };

            const pointerClickEvent = ChartEvent.CLICK;
            const pointerMoveEvent = ChartEvent.POINTER_MOVE;
            const sizeChangeEvent = `${ChartEvent.AFTER_RENDER}`;

            const handlePointerEvent = (e: ChartPointerEvent) => {
                if (!e || (e.type === ChartEvent.POINTER_MOVE && e.buttons !== 1) || (e.type === ChartEvent.CLICK && e.buttons !== 0)) {
                    return;
                }
                const { x, y } = e;
                if (typeof x !== 'number' || !Number.isFinite(x)) {
                    return;
                }

                const region = resolvePlotRegion(plot, canvasEl);
                const xScale = plot.chart?.getContext().views[0]?.scale?.x;
                if (!region || !xScale || !Number.isFinite(y) || x < region.left || x > region.right || y < region.top || y > region.bottom || region.right <= region.left) {
                    return;
                }
                const clickedTime = xScale.invert((x - region.left) / (region.right - region.left));
                if (!Number.isFinite(clickedTime) || tickPositions.length === 0) {
                    return;
                }
                let lower = 0;
                let upper = tickPositions.length - 1;
                while (lower < upper) {
                    const middle = Math.floor((lower + upper) / 2);
                    if (tickPositions[middle] < clickedTime) {
                        lower = middle + 1;
                    } else {
                        upper = middle;
                    }
                }
                const nearest = lower > 0 && clickedTime - tickPositions[lower - 1] <= tickPositions[lower] - clickedTime
                    ? lower - 1 : lower;
                const sample = samplesByX.get(tickPositions[nearest]);
                const time = sample?.[xField];
                const blockIndex = sample?.index;
                if (typeof time === 'number' && typeof blockIndex === 'number') {
                    emitCursor(time, blockIndex);
                }
            };

            const handleSizeChange = () => {
                setPlotRegionIfChanged(resolvePlotRegion(plot, canvasEl));
            };

            const handleLegendFilter = (event: ChartPointerEvent) => {
                if (event.data?.channel === 'color') {
                    selectedValuesRef.current = event.data.values ? [...event.data.values] : undefined;
                }
            };
            const handleLegendFocus = (event: ChartPointerEvent) => {
                if (event.data?.channel === 'color') {
                    selectedValuesRef.current = [event.data.value];
                }
            };
            const handleLegendReset = () => {
                selectedValuesRef.current = undefined;
            };

            const handleLegendClick = (event: ChartPointerEvent) => {
                if (!event.shiftKey && !event.nativeEvent?.shiftKey) {
                    return;
                }
                let item = event.target;
                while (item && !item.className?.split(/\s+/).includes('items-item')) {
                    item = item.parentNode ?? undefined;
                }
                const index = item?.__data__?.index;
                const domain = plot.chart?.getContext().views[0]?.scale?.color?.getOptions().domain;
                if (index === undefined || !domain || index < 0 || index >= domain.length) {
                    return;
                }
                event.stopPropagation?.();
                const value = domain[index];
                const selectedValues = selectedValuesRef.current;
                const reset = selectedValues?.length === 1 && selectedValues[0] === value;
                plot.chart?.emit?.(reset ? 'legend:reset' : 'legend:focus', { data: { channel: 'color', value } });
            };

            const chartCanvas = plot.chart?.getContext().canvas;
            plot.chart?.on?.('legend:filter', handleLegendFilter);
            plot.chart?.on?.('legend:focus', handleLegendFocus);
            plot.chart?.on?.('legend:reset', handleLegendReset);
            chartCanvas?.addEventListener('click', handleLegendClick, true);
            chartCanvas?.addEventListener(pointerClickEvent, handlePointerEvent, true);
            chartCanvas?.addEventListener(pointerMoveEvent, handlePointerEvent, true);
            plot.chart?.on?.(sizeChangeEvent, handleSizeChange);
            detachCanvasListenersRef.current = () => {
                plot.chart?.off?.('legend:filter', handleLegendFilter);
                plot.chart?.off?.('legend:focus', handleLegendFocus);
                plot.chart?.off?.('legend:reset', handleLegendReset);
                chartCanvas?.removeEventListener('click', handleLegendClick, true);
                chartCanvas?.removeEventListener(pointerClickEvent, handlePointerEvent, true);
                chartCanvas?.removeEventListener(pointerMoveEvent, handlePointerEvent, true);
                plot.chart?.off?.(sizeChangeEvent, handleSizeChange);
                canvasRef.current = null;
            };
        }

        if (typeof userOnReady === 'function') {
            userOnReady(plot);
        }
    }, [resolvePlotRegion, samplesByX, setPlotRegionIfChanged, tickPositions, userOnReady, xField]);

    const cursorLeftPx = cursorLeftFromX(highlightedX);

    return (
        <div ref={containerRef} style={{ position: 'relative', height: '100%' }} onWheel={handleWheel}>
            <div id='chart' style={{ height: '100%' }}>
                <ChartLine {...config} onReady={mergedOnReady} ref={plotRef} />
            </div>
            {plotRegion && cursorLeftPx !== null && (
                <div
                    style={{
                        position: 'absolute',
                        top: plotRegion.top,
                        height: Math.max(0, plotRegion.bottom - plotRegion.top),
                        left: `${cursorLeftPx - 0.5}px`,
                        borderLeft: '1px dashed rgba(220, 80, 80, 0.95)',
                        pointerEvents: 'none',
                        zIndex: 5,
                    }}
                />
            )}
        </div>
    );
};
