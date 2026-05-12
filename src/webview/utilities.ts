/*
 * Copyright (C) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */
import { ImageFrame } from "./protocol";

const decodedFrameCache = new WeakMap<ImageFrame, Map<string, ImageData>>();

export function decodeFrame(frame: ImageFrame, width: number, height: number): ImageData {
    const cacheKey = `${width}x${height}`;
    const cachedFrames = decodedFrameCache.get(frame);
    const cachedImage = cachedFrames?.get(cacheKey);
    if (cachedImage) {
        return cachedImage;
    }

    const raw = atob(frame.rgbaBase64);
    const rawLength = raw.length;
    const arr = new Uint8ClampedArray(rawLength);
    for (let i = 0; i < rawLength; i++) {
        arr[i] = raw.charCodeAt(i);
    }

    const imageData = new ImageData(arr, width, height);
    const nextCachedFrames = cachedFrames ?? new Map<string, ImageData>();
    nextCachedFrames.set(cacheKey, imageData);
    if (!cachedFrames) {
        decodedFrameCache.set(frame, nextCachedFrames);
    }

    return imageData;
}