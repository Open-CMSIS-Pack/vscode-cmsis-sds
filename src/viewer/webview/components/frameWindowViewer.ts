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

import { useEffect, useRef, useState } from 'react';
import { BroadcastMessage, ImageFrame, getIndexedSdsSuffix, getNearestFrameIndexAtTimestamp, isTimestampInFrameRange, Message } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';

type Quality = 'low' | 'high';
type MediaType = 'image' | 'video';

type FrameWindowState = {
    frames: ImageFrame[];
    rangeStart?: number;
    totalFrames: number;
};

type FrameWindowViewerOptions = {
    state: FrameWindowState;
    filename?: string | undefined;
    mediaType: MediaType;
    getWindowSize: (quality: Quality) => number;
    getNearEdgeMargin: (loadedFrameCount: number) => number;
    stationaryRequestQuality: Quality;
    onManualChangeStart?: () => void;
};

const DRAG_REQUEST_THROTTLE_MS = 80;

export function useFrameWindowViewer({
    state,
    filename,
    mediaType,
    getWindowSize,
    getNearEdgeMargin,
    stationaryRequestQuality,
    onManualChangeStart,
}: FrameWindowViewerOptions) {
    const { frames, rangeStart = 0, totalFrames } = state;
    const [index, setIndex] = useState(rangeStart);
    const [windowFrames, setWindowFrames] = useState<ImageFrame[]>(frames);
    const [windowStart, setWindowStart] = useState(rangeStart);
    const [isDragMode, setIsDragMode] = useState(false);
    const requestSeqRef = useRef(0);
    const latestAppliedSeqRef = useRef(0);
    const dragRequestTimerRef = useRef<NodeJS.Timeout | null>(null);
    const pendingDragRequestRef = useRef<{ centerIndex: number; quality: Quality } | null>(null);
    const lastRequestAtRef = useRef(0);
    const lastRequestKeyRef = useRef('');
    const lastAppliedWindowRef = useRef<{ rangeStart: number; rangeEnd: number; quality: Quality } | null>(null);
    const needsPostDragHighRef = useRef(false);

    const getLoadedFrame = (absoluteIndex: number) => {
        const localIndex = absoluteIndex - windowStart;
        if (localIndex < 0 || localIndex >= windowFrames.length) {
            return null;
        }
        return windowFrames[localIndex];
    };

    const requestFrameWindow = (centerIndex: number, quality: Quality) => {
        const requestId = ++requestSeqRef.current;
        broadcastMessage({
            command: 'requestMediaFrameWindow',
            requestId,
            payload: {
                mediaType,
                centerIndex,
                windowSize: getWindowSize(quality),
                quality,
            },
        });
    };

    const buildRequestKey = (centerIndex: number, quality: Quality) => {
        const windowSize = getWindowSize(quality);
        const maxIndex = Math.max(0, totalFrames - 1);
        const clampedCenter = Math.max(0, Math.min(maxIndex, Math.floor(centerIndex)));
        const requestRangeStart = Math.max(0, Math.min(clampedCenter - Math.floor(windowSize / 2), Math.max(0, totalFrames - windowSize)));
        const requestRangeEnd = Math.min(totalFrames, requestRangeStart + windowSize);
        return `${mediaType}|${quality}|${windowSize}|${requestRangeStart}|${requestRangeEnd}`;
    };

    const requestFrameWindowIfNeeded = (centerIndex: number, quality: Quality, force = false) => {
        if (totalFrames <= 0) {
            return false;
        }

        if (!force && windowFrames.length > 0) {
            const frame = getLoadedFrame(centerIndex);
            if (frame) {
                const loadedStart = windowStart;
                const loadedEnd = windowStart + windowFrames.length - 1;
                const nearEdgeMargin = getNearEdgeMargin(windowFrames.length);
                const isNearEdge = centerIndex <= loadedStart + nearEdgeMargin || centerIndex >= loadedEnd - nearEdgeMargin;
                if (!isNearEdge) {
                    return false;
                }
            }
        }

        const requestKey = buildRequestKey(centerIndex, quality);
        if (requestKey === lastRequestKeyRef.current) {
            return false;
        }

        lastRequestKeyRef.current = requestKey;
        lastRequestAtRef.current = Date.now();
        requestFrameWindow(centerIndex, quality);
        return true;
    };

    const scheduleDragFrameWindowRequest = (centerIndex: number, quality: Quality) => {
        pendingDragRequestRef.current = { centerIndex, quality };

        const elapsed = Date.now() - lastRequestAtRef.current;
        if (!dragRequestTimerRef.current && elapsed >= DRAG_REQUEST_THROTTLE_MS) {
            lastRequestAtRef.current = Date.now();
            const pending = pendingDragRequestRef.current;
            pendingDragRequestRef.current = null;
            if (pending) {
                requestFrameWindowIfNeeded(pending.centerIndex, pending.quality);
            }
            return;
        }

        if (dragRequestTimerRef.current) {
            return;
        }

        const delay = Math.max(0, DRAG_REQUEST_THROTTLE_MS - elapsed);
        dragRequestTimerRef.current = setTimeout(() => {
            dragRequestTimerRef.current = null;
            lastRequestAtRef.current = Date.now();
            const pending = pendingDragRequestRef.current;
            pendingDragRequestRef.current = null;
            if (pending) {
                requestFrameWindowIfNeeded(pending.centerIndex, pending.quality);
            }
        }, delay);
    };

    useEffect(() => {
        setWindowFrames(frames);
        setWindowStart(rangeStart);
        setIndex((prev) => {
            const next = Math.max(0, Math.min(totalFrames - 1, prev));
            return Number.isFinite(next) ? next : rangeStart;
        });
    }, [frames, rangeStart, totalFrames]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const msg = event.data as Message;
            const messageType = (msg.type ?? msg.command) as string | undefined;

            switch (messageType) {
                case 'broadcast': {
                    if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix((msg as BroadcastMessage).fileName)) {
                        break;
                    }

                    if (!isTimestampInFrameRange((msg as BroadcastMessage).timeStamp, windowFrames)) {
                        break;
                    }

                    const nextIndex = getNearestFrameIndexAtTimestamp((msg as BroadcastMessage).timeStamp as number, windowFrames);
                    if (nextIndex === null) {
                        break;
                    }

                    setIndex(prevIndex => prevIndex === nextIndex ? prevIndex : nextIndex);
                    break;
                }
                case 'mediaFrameWindowData': {
                    const mediaMessage = msg as Message & {
                        requestId?: number;
                        payload?: {
                            mediaType?: MediaType;
                            rangeStart?: number;
                            rangeEnd?: number;
                            quality?: Quality;
                            frames?: ImageFrame[];
                        };
                    };

                    if (mediaMessage.payload?.mediaType !== mediaType) {
                        break;
                    }
                    if (typeof mediaMessage.requestId === 'number') {
                        if (mediaMessage.requestId < latestAppliedSeqRef.current) {
                            break;
                        }
                        latestAppliedSeqRef.current = mediaMessage.requestId;
                    }
                    if (!Array.isArray(mediaMessage.payload?.frames)) {
                        break;
                    }

                    setWindowFrames(mediaMessage.payload.frames);
                    setWindowStart(typeof mediaMessage.payload.rangeStart === 'number' ? mediaMessage.payload.rangeStart : 0);
                    if (
                        typeof mediaMessage.payload.rangeStart === 'number' &&
                        typeof mediaMessage.payload.rangeEnd === 'number'
                    ) {
                        lastAppliedWindowRef.current = {
                            rangeStart: mediaMessage.payload.rangeStart,
                            rangeEnd: mediaMessage.payload.rangeEnd,
                            quality: mediaMessage.payload.quality === 'low' ? 'low' : 'high',
                        };
                    }
                    break;
                }
            }
        };

        window.addEventListener('message', handleMessage);
        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [filename, mediaType, windowFrames]);

    useEffect(() => {
        const loadedStart = windowStart;
        const loadedEnd = windowStart + windowFrames.length - 1;

        if (windowFrames.length === 0 || index < loadedStart || index > loadedEnd) {
            if (isDragMode) {
                scheduleDragFrameWindowRequest(index, 'low');
            } else {
                requestFrameWindowIfNeeded(index, stationaryRequestQuality);
            }
            return;
        }

        const nearEdgeMargin = getNearEdgeMargin(windowFrames.length);
        if (index <= loadedStart + nearEdgeMargin || index >= loadedEnd - nearEdgeMargin) {
            if (isDragMode) {
                scheduleDragFrameWindowRequest(index, 'low');
            } else {
                requestFrameWindowIfNeeded(index, stationaryRequestQuality);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- request helpers are recreated each render; depending on them would refetch windows excessively
    }, [getNearEdgeMargin, index, isDragMode, stationaryRequestQuality, windowFrames.length, windowStart]);

    useEffect(() => {
        if (isDragMode || !needsPostDragHighRef.current) {
            return;
        }

        if (dragRequestTimerRef.current) {
            clearTimeout(dragRequestTimerRef.current);
            dragRequestTimerRef.current = null;
        }
        pendingDragRequestRef.current = null;
        needsPostDragHighRef.current = false;

        const appliedWindow = lastAppliedWindowRef.current;
        const isHighQualityCovered = Boolean(
            appliedWindow &&
            appliedWindow.quality === 'high' &&
            index >= appliedWindow.rangeStart &&
            index < appliedWindow.rangeEnd
        );
        if (isHighQualityCovered) {
            return;
        }

        requestFrameWindowIfNeeded(index, 'high', true);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- request helper is recreated each render; only index/drag transitions should retrigger
    }, [index, isDragMode]);

    useEffect(() => {
        return () => {
            if (dragRequestTimerRef.current) {
                clearTimeout(dragRequestTimerRef.current);
                dragRequestTimerRef.current = null;
            }
        };
    }, []);

    const changeIndex = (nextIndex: number, { manual = true }: { manual?: boolean } = {}) => {
        if (manual) {
            onManualChangeStart?.();
        }

        const clamped = Math.max(0, Math.min(totalFrames - 1, nextIndex));
        setIndex(clamped);
        const frame = getLoadedFrame(clamped);
        broadcastMessage({
            type: 'broadcast',
            timeStamp: frame?.timestamp,
            fileName: filename,
        });
    };

    return {
        index,
        windowFrames,
        windowStart,
        isDragMode,
        setIsDragMode,
        getLoadedFrame,
        changeIndex,
        markNeedsPostDragHighQuality: () => {
            needsPostDragHighRef.current = true;
        },
    };
}
