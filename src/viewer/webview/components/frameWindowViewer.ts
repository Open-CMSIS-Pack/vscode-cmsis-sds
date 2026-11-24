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

import { useCallback, useEffect, useRef, useState } from 'react';
import { BroadcastMessage, ImageFrame, getIndexedSdsSuffix, getNearestFrameIndexAtTimestamp, isSameSdsFile, isTimestampInFrameRange, Message } from '../../../webview/protocol';
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
    followLatest?: boolean;
    onManualChangeStart?: () => void;
    onPlaybackStateChange?: (state: 'playing' | 'stopped') => void;
};

const DRAG_REQUEST_THROTTLE_MS = 12;
let frameWindowRequestSequence = 0;

export function useFrameWindowViewer({
    state,
    filename,
    mediaType,
    getWindowSize,
    getNearEdgeMargin,
    stationaryRequestQuality,
    followLatest = false,
    onManualChangeStart,
    onPlaybackStateChange,
}: FrameWindowViewerOptions) {
    const { frames, rangeStart = 0, totalFrames } = state;
    const [index, setIndex] = useState(rangeStart);
    const [windowFrames, setWindowFrames] = useState<ImageFrame[]>(frames);
    const [windowStart, setWindowStart] = useState(rangeStart);
    const [isDragMode, setIsDragMode] = useState(false);
    const requestSeqRef = useRef(frameWindowRequestSequence);
    const minimumValidRequestSeqRef = useRef(frameWindowRequestSequence + 1);
    const latestAppliedSeqRef = useRef(0);
    const inFlightRequestRef = useRef<number | null>(null);
    const pendingWindowRequestRef = useRef<{ centerIndex: number; quality: Quality } | null>(null);
    const dragRequestTimerRef = useRef<NodeJS.Timeout | null>(null);
    const pendingDragRequestRef = useRef<{ centerIndex: number; quality: Quality } | null>(null);
    const lastRequestAtRef = useRef(0);
    const lastRequestKeyRef = useRef('');
    const lastAppliedWindowRef = useRef<{ rangeStart: number; rangeEnd: number; quality: Quality } | null>(null);
    const needsPostDragHighRef = useRef(false);
    const previousTotalRef = useRef(totalFrames);

    const getLoadedFrame = useCallback((absoluteIndex: number) => {
        const localIndex = absoluteIndex - windowStart;
        if (localIndex < 0 || localIndex >= windowFrames.length) {
            return null;
        }
        return windowFrames[localIndex];
    }, [windowFrames, windowStart]);

    const requestFrameWindow = useCallback((centerIndex: number, quality: Quality) => {
        if (inFlightRequestRef.current !== null) {
            pendingWindowRequestRef.current = { centerIndex, quality };
            return;
        }
        const requestId = ++frameWindowRequestSequence;
        requestSeqRef.current = requestId;
        inFlightRequestRef.current = requestId;
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
    }, [getWindowSize, mediaType]);

    const buildRequestKey = useCallback((centerIndex: number, quality: Quality) => {
        const windowSize = getWindowSize(quality);
        const maxIndex = Math.max(0, totalFrames - 1);
        const clampedCenter = Math.max(0, Math.min(maxIndex, Math.floor(centerIndex)));
        const requestRangeStart = Math.max(0, Math.min(clampedCenter - Math.floor(windowSize / 2), Math.max(0, totalFrames - windowSize)));
        const requestRangeEnd = Math.min(totalFrames, requestRangeStart + windowSize);
        return `${mediaType}|${quality}|${windowSize}|${requestRangeStart}|${requestRangeEnd}`;
    }, [getWindowSize, mediaType, totalFrames]);

    const requestFrameWindowIfNeeded = useCallback((centerIndex: number, quality: Quality, force = false) => {
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
    }, [buildRequestKey, getLoadedFrame, getNearEdgeMargin, requestFrameWindow, totalFrames, windowFrames.length, windowStart]);

    const scheduleDragFrameWindowRequest = useCallback((centerIndex: number, quality: Quality) => {
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
    }, [requestFrameWindowIfNeeded]);

    useEffect(() => {
        setWindowFrames(frames);
        setWindowStart(rangeStart);
    }, [frames, rangeStart]);

    useEffect(() => {
        const previousTotal = previousTotalRef.current;
        previousTotalRef.current = totalFrames;
        setIndex((prev) => {
            if (followLatest && totalFrames > previousTotal && prev === Math.max(0, previousTotal - 1)) {
                return totalFrames - 1;
            }
            const next = Math.max(0, Math.min(totalFrames - 1, prev));
            return Number.isFinite(next) ? next : rangeStart;
        });
    }, [followLatest, rangeStart, totalFrames]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) {
                return;
            }

            const msg = event.data as Message;
            const messageType = (msg.type ?? msg.command) as string | undefined;

            switch (messageType) {
                case 'broadcast': {
                    const broadcast = msg as BroadcastMessage;
                    if (getIndexedSdsSuffix(filename) !== getIndexedSdsSuffix(broadcast.fileName)) {
                        break;
                    }

                    if (typeof broadcast.timeStamp !== 'number' || !isTimestampInFrameRange(broadcast.timeStamp, windowFrames)) {
                        break;
                    }

                    if (typeof broadcast.playbackState === 'string' && isSameSdsFile(filename, broadcast.fileName)) {
                        onPlaybackStateChange?.(broadcast.playbackState);
                    }

                    const nextIndex = getNearestFrameIndexAtTimestamp(broadcast.timeStamp, windowFrames);
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
                    if (mediaMessage.requestId === inFlightRequestRef.current) {
                        inFlightRequestRef.current = null;
                        const pendingRequest = pendingWindowRequestRef.current;
                        pendingWindowRequestRef.current = null;
                        if (pendingRequest) {
                            requestFrameWindow(pendingRequest.centerIndex, pendingRequest.quality);
                        }
                    }
                    if (typeof mediaMessage.requestId === 'number') {
                        if (mediaMessage.requestId < minimumValidRequestSeqRef.current || mediaMessage.requestId < latestAppliedSeqRef.current) {
                            break;
                        }
                    }
                    if (!Array.isArray(mediaMessage.payload?.frames)) {
                        break;
                    }

                    const responseStart = typeof mediaMessage.payload.rangeStart === 'number' ? mediaMessage.payload.rangeStart : 0;
                    if (index < responseStart || index >= responseStart + mediaMessage.payload.frames.length) {
                        break;
                    }
                    if (typeof mediaMessage.requestId === 'number') {
                        latestAppliedSeqRef.current = mediaMessage.requestId;
                    }
                    setWindowFrames(mediaMessage.payload.frames);
                    setWindowStart(responseStart);
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
    }, [filename, index, mediaType, onPlaybackStateChange, requestFrameWindow, windowFrames]);

    useEffect(() => {
        const loadedStart = windowStart;
        const loadedEnd = windowStart + windowFrames.length - 1;
        const requestIndex = stationaryRequestQuality === 'low'
            ? Math.min(totalFrames - 1, index + Math.floor(getWindowSize('low') / 2))
            : index;

        if (windowFrames.length === 0 || index < loadedStart || index > loadedEnd) {
            if (isDragMode) {
                scheduleDragFrameWindowRequest(index, 'low');
            } else {
                requestFrameWindowIfNeeded(requestIndex, stationaryRequestQuality);
            }
            return;
        }

        const nearEdgeMargin = getNearEdgeMargin(windowFrames.length);
        if (index <= loadedStart + nearEdgeMargin || index >= loadedEnd - nearEdgeMargin) {
            if (isDragMode) {
                scheduleDragFrameWindowRequest(index, 'low');
            } else {
                requestFrameWindowIfNeeded(requestIndex, stationaryRequestQuality);
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- request helpers are recreated each render; depending on them would refetch windows excessively
    }, [getNearEdgeMargin, index, isDragMode, stationaryRequestQuality, totalFrames, windowFrames.length, windowStart]);

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

    const changeIndex = useCallback((nextIndex: number, { manual = true, broadcast = true }: { manual?: boolean; broadcast?: boolean } = {}) => {
        if (manual) {
            onManualChangeStart?.();
        }

        const clamped = Math.max(0, Math.min(totalFrames - 1, nextIndex));
        if (manual || clamped < index) {
            minimumValidRequestSeqRef.current = requestSeqRef.current + 1;
            lastRequestKeyRef.current = '';
            pendingWindowRequestRef.current = null;
        }
        setIndex(clamped);
        const frame = getLoadedFrame(clamped);
        if (broadcast && typeof frame?.timestamp === 'number') {
            broadcastMessage({
                type: 'broadcast',
                timeStamp: frame.timestamp,
                fileName: filename,
            });
        }
    }, [filename, getLoadedFrame, index, onManualChangeStart, totalFrames]);

    return {
        index,
        windowFrames,
        windowStart,
        setIsDragMode,
        getLoadedFrame,
        changeIndex,
        markNeedsPostDragHighQuality: () => {
            needsPostDragHighRef.current = true;
        },
    };
}
