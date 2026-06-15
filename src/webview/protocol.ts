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

import { SDS_FILE_MATCHER } from "./utilities";

export type Message =
    | BroadcastMessage
    | InitMessage
    | UpdateStateMessage
    | WebviewMessage;

export type BroadcastMessage = WebviewMessage & {
    type: 'broadcast';
    timeStamp: number;
    fileName: string;
};

export type InitMessage = WebviewMessage & {
    type: 'init';
    payload: { state: AppState };
};

export type UpdateStateMessage = WebviewMessage & {
    type: 'updateState';
    payload: Partial<AppState>;
};

export type AppState = WebviewMessage & {
    foo: string;
};

export type WebviewMessage = {
    type?: string;
    command?: string;
    message?: string;
    [key: string]: unknown;
};

export type MediaFrame = { timestamp: number; };
export type ImageFrame = MediaFrame & { rgbaBase64: string };
export type SampleFrame = MediaFrame & { samples: number[] };

export function getIndexedSdsSuffix(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    return value.match(SDS_FILE_MATCHER)?.[2].toLowerCase() ?? null;
}

export function isTimestampInFrameRange(timeStamp: number | undefined, frames: MediaFrame[]) {
    if (timeStamp === undefined || frames.length === 0) {
        return false;
    }

    const firstTimestamp = frames[0].timestamp;
    const lastTimestamp = frames[frames.length - 1].timestamp;
    const minTimestamp = Math.min(firstTimestamp, lastTimestamp);
    const maxTimestamp = Math.max(firstTimestamp, lastTimestamp);
    return timeStamp >= minTimestamp && timeStamp <= maxTimestamp;
}

function lowerBoundFrameTimestamp(target: number, frames: MediaFrame[]) {
    let lo = 0;
    let hi = frames.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid].timestamp < target) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo;
}


export function getNearestFrameIndexAtTimestamp(target: number, frames: MediaFrame[]) {
    if (!isTimestampInFrameRange(target, frames)) {
        return null;
    }

    const right = lowerBoundFrameTimestamp(target, frames);
    if (right <= 0) {
        return 0;
    }
    if (right >= frames.length) {
        return frames.length - 1;
    }

    const left = right - 1;
    return Math.abs(frames[left].timestamp - target) <= Math.abs(frames[right].timestamp - target)
        ? left
        : right;
}