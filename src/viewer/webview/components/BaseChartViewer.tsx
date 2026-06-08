// Shared base for time-series chart viewers using Ant Design Charts
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Line } from '@ant-design/charts';

export interface ChartSample {
    x: number;
    y: number;
    [key: string]: any;
}

export interface BaseChartViewerProps {
    data: ChartSample[];
    xField?: string;
    yField?: string;
    seriesField?: string;
    title?: string;
    color?: string[];
    highlightedX?: number | null;
    xRange?: [number, number];
    onCursorChange?: (x: number) => void;
    onZoomRangeChange?: (range: [number, number]) => void;
    [key: string]: any;
}

export const BaseChartViewer: React.FC<BaseChartViewerProps> = ({
    data,
    xField = 'x',
    yField = 'y',
    seriesField,
    title,
    color,
    highlightedX,
    xRange,
    onCursorChange,
    onZoomRangeChange,
    ...rest
}) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const detachCanvasListenersRef = useRef<(() => void) | null>(null);
    const plotRegionRef = useRef<{ left: number; right: number; top: number; bottom: number } | null>(null);
    const [plotRegion, setPlotRegion] = useState<{ left: number; right: number; top: number; bottom: number } | null>(null);
    const width = 800;
    const height = 400;

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

    const cursorPercent = useMemo(() => {
        if (highlightedX === null || highlightedX === undefined || !resolveXRange) {
            return null;
        }

        const span = resolveXRange[1] - resolveXRange[0];
        if (!Number.isFinite(span) || span <= 0) {
            return null;
        }

        const relative = (highlightedX - resolveXRange[0]) / span;
        const clamped = Math.max(0, Math.min(1, relative));
        return clamped * 100;
    }, [highlightedX, resolveXRange]);

    const resolvePlotRegion = useCallback((plot: any, canvasEl: HTMLCanvasElement | null) => {
        if (!canvasEl) {
            return null;
        }

        const fallback = {
            left: 0,
            right: canvasEl.clientWidth,
            top: 0,
            bottom: canvasEl.clientHeight,
        };

        const coordinate = plot?.chart?.getCoordinate?.();
        const start = coordinate?.start;
        const end = coordinate?.end;
        if (
            start &&
            end &&
            typeof start.x === 'number' &&
            typeof start.y === 'number' &&
            typeof end.x === 'number' &&
            typeof end.y === 'number'
        ) {
            return {
                left: Math.min(start.x, end.x),
                right: Math.max(start.x, end.x),
                top: Math.min(start.y, end.y),
                bottom: Math.max(start.y, end.y),
            };
        }

        return fallback;
    }, []);

    const cursorTimeFromClientPoint = useCallback((clientX: number, clientY: number) => {
        if (!resolveXRange) {
            return null;
        }

        const rect = containerRef.current?.getBoundingClientRect();
        const region = plotRegionRef.current;
        if (!rect || !region) {
            return null;
        }

        const regionWidth = region.right - region.left;
        const regionHeight = region.bottom - region.top;
        if (regionWidth <= 0 || regionHeight <= 0) {
            return null;
        }

        const localX = clientX - rect.left;
        const localY = clientY - rect.top;

        // Ignore clicks above/below the plotted data region (axes, legend, padding).
        if (localY < region.top || localY > region.bottom) {
            return null;
        }

        const clampedX = Math.max(region.left, Math.min(region.right, localX));
        const relative = (clampedX - region.left) / regionWidth;
        return resolveXRange[0] + (resolveXRange[1] - resolveXRange[0]) * relative;
    }, [resolveXRange]);

    const cursorLeftPx = useMemo(() => {
        if (cursorPercent === null || !plotRegion) {
            return null;
        }

        return plotRegion.left + ((plotRegion.right - plotRegion.left) * (cursorPercent / 100));
    }, [cursorPercent, plotRegion]);

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

        const focusTime = cursorTimeFromClientPoint(event.clientX, event.clientY);
        const anchorTime = focusTime === null ? (currentRange[0] + currentRange[1]) / 2 : focusTime;
        const relativeAnchor = (anchorTime - currentRange[0]) / currentSpan;
        const zoomFactor = Math.exp(event.deltaY * 0.0015);
        const nextSpan = currentSpan * zoomFactor;

        const nextStart = anchorTime - (nextSpan * relativeAnchor);
        const nextEnd = nextStart + nextSpan;
        onZoomRangeChange([nextStart, nextEnd]);
    }, [cursorTimeFromClientPoint, onZoomRangeChange, resolveXRange, xRange]);

    useEffect(() => {
        return () => {
            if (detachCanvasListenersRef.current) {
                detachCanvasListenersRef.current();
                detachCanvasListenersRef.current = null;
            }
        };
    }, []);

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
        animate: false,
        legend: { position: 'top' },
        tooltip: { showMarkers: true },
        slider: { x: false, y: false },
        ...rest,
    };

    const userOnReady = rest.onReady;

    const mergedOnReady = (plot: any) => {
        if (detachCanvasListenersRef.current) {
            detachCanvasListenersRef.current();
            detachCanvasListenersRef.current = null;
        }

        const canvasEl = containerRef.current?.querySelector<HTMLCanvasElement>('canvas') ?? null;
        const region = resolvePlotRegion(plot, canvasEl);
        plotRegionRef.current = region;
        setPlotRegion(region);

        if (onCursorChange && resolveXRange && canvasEl) {
            const emitCursor = (event: MouseEvent) => {
                const time = cursorTimeFromClientPoint(event.clientX, event.clientY);
                if (time === null) {
                    return;
                }
                onCursorChange(time);
            };

            const onCanvasClick = (event: MouseEvent) => {
                emitCursor(event);
            };

            const onCanvasMouseDown = (event: MouseEvent) => {
                emitCursor(event);
            };

            const onCanvasMouseMove = (event: MouseEvent) => {
                if ((event.buttons & 1) !== 1) {
                    return;
                }
                emitCursor(event);
            };

            canvasEl.addEventListener('click', onCanvasClick);
            canvasEl.addEventListener('mousedown', onCanvasMouseDown);
            canvasEl.addEventListener('mousemove', onCanvasMouseMove);

            detachCanvasListenersRef.current = () => {
                canvasEl.removeEventListener('click', onCanvasClick);
                canvasEl.removeEventListener('mousedown', onCanvasMouseDown);
                canvasEl.removeEventListener('mousemove', onCanvasMouseMove);
            };
        }

        if (typeof userOnReady === 'function') {
            userOnReady(plot);
        }
    };

    return (
        <div ref={containerRef} style={{ position: 'relative', height: '100%' }} onWheel={handleWheel}>
            <div id='chart' style={{ height: '100%' }}>
                <Line {...config} onReady={mergedOnReady} />
            </div>
            {cursorLeftPx !== null && (
                <div
                    style={{
                        position: 'absolute',
                        top: plotRegion?.top ?? width,
                        height: plotRegion ? Math.max(0, plotRegion.bottom - plotRegion.top) : height,
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
