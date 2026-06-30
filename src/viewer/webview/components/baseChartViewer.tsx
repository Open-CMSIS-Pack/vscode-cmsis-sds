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
        getContext: () => { views: { layout: { width: number; height: number; marginLeft: number; marginRight: number; marginTop: number; marginBottom: number; paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number; innerWidth: number; innerHeight: number } }[] };
        getDataByXY: (point: ChartCoordinateLike, options?: { shared: boolean }) => Record<string, ChartSample> | undefined;
        on?: (event: string, handler: (e: ChartPointerEvent) => void) => void;
        off?: (event: string, handler: (e: ChartPointerEvent) => void) => void;
    };
}

interface ChartPointerEvent {
    target?: { attributes?: { class?: string } };
    buttons?: number;
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
        if (x === null || x === undefined || !Number.isFinite(x) || !resolveXRange || !plotRegion) {
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

    const tooltipTitle = (value: ChartSample) => {
        const blockIndex = typeof value?.index === 'number' ? value.index : null;
        const blockTitle = blockIndex !== null ? `Block: ${blockIndex + 1}` : 'Block';

        if (userTooltip?.title && typeof userTooltip.title === 'function') {
            const userTitle = userTooltip.title(value);
            if (typeof userTitle === 'string' && userTitle.length > 0) {
                return `${blockTitle} | ${userTitle}`;
            }
        }

        return blockTitle;
    };

    const config = {
        data,
        xField,
        yField,
        seriesField,
        // Ensure multi-series line colors follow the provided palette.
        colorField: seriesField,
        color,
        scale: color && color.length > 0
            ? {
                color: {
                    range: color,
                },
            }
            : undefined,
        ...otherRest,
        axis: {
            ...(restAxis ?? {}),
            x: {
                ...(restAxis?.x ?? {}),
                labelFormatter: (value: string) => {
                    return blockLabelForX(Number(value)) ?? value;
                },
            },
        },
        animate: false,
        legend: { position: 'top' },
        tooltip: {
            showMarkers: true,
            ...(userTooltip ?? {}),
            title: tooltipTitle,
        },
        slider: { x: false, y: false },
    };

    const mergedOnReady = (plot: ChartPlotLike) => {
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

            const pointerClickEvent = `plot:${ChartEvent.CLICK}`;
            const pointerMoveEvent = `plot:${ChartEvent.POINTER_MOVE}`;
            const sizeChangeEvent = `${ChartEvent.AFTER_RENDER}`;

            const handlePointerEvent = (e: ChartPointerEvent) => {
                if (!e || (e.type === ChartEvent.POINTER_MOVE && e.buttons !== 1) || (e.type === ChartEvent.CLICK && e.buttons !== 0)) {
                    return;
                }
                const { x, y } = e;
                if (typeof x !== 'number' || !Number.isFinite(x)) {
                    return;
                }

                const sample = plot.chart?.getDataByXY({ x: x, y: y }, { shared: true })?.[0];
                const time = sample?.[xField];
                const blockIndex = sample?.index;
                if (typeof time === 'number' && typeof blockIndex === 'number') {
                    emitCursor(time, blockIndex);
                }
            };

            const handleSizeChange = () => {
                setPlotRegionIfChanged(resolvePlotRegion(plot, canvasEl));
            };

            plot.chart?.on?.(pointerClickEvent, handlePointerEvent);
            plot.chart?.on?.(pointerMoveEvent, handlePointerEvent);
            plot.chart?.on?.(sizeChangeEvent, handleSizeChange);
            detachCanvasListenersRef.current = () => {
                plot.chart?.off?.(pointerClickEvent, handlePointerEvent);
                plot.chart?.off?.(pointerMoveEvent, handlePointerEvent);
                plot.chart?.off?.(sizeChangeEvent, handleSizeChange);
                canvasRef.current = null;
            };
        }

        if (typeof userOnReady === 'function') {
            userOnReady(plot);
        }
    };

    const cursorLeftPx = cursorLeftFromX(highlightedX);

    return (
        <div ref={containerRef} style={{ position: 'relative', height: '100%' }} onWheel={handleWheel}>
            <div id='chart' style={{ height: '100%' }}>
                <Line {...config} onReady={mergedOnReady} ref={plotRef} />
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
