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
import { SampleFrame } from '../../../webview/protocol';
import { broadcastMessage } from '../../../webview/vscode-api';
import { ViewRange } from './viewportMath';

let playbackRequestSequence = 0;

export function useAudioPlayback(sampleRate: number, bitDepth: number, channels: number, domainEnd: number, filename?: string) {
    const [isPlaying, setIsPlaying] = useState(false);
    const contextRef = useRef<AudioContext | null>(null);
    const sourcesRef = useRef(new Set<AudioBufferSourceNode>());
    const sessionRef = useRef<{
        nextTime: number; scheduledUntil: number; limit: number; follow: boolean;
        pending: number | null; broadcast: boolean;
    } | null>(null);
    const domainEndRef = useRef(domainEnd);
    domainEndRef.current = domainEnd;

    const stopPlayback = useCallback((broadcast = true) => {
        const session = sessionRef.current;
        sessionRef.current = null;
        for (const source of sourcesRef.current) {
            source.onended = null;
            source.disconnect();
            try { source.stop(); } catch { continue; }
        }
        sourcesRef.current.clear();
        setIsPlaying(false);
        if (broadcast && session) {
            broadcastMessage({ type: 'broadcast', timeStamp: session.nextTime, fileName: filename, playbackState: 'stopped' });
        }
    }, [filename]);

    const pump = useCallback(() => {
        const session = sessionRef.current;
        const context = contextRef.current;
        if (!session || !context || session.pending !== null || session.scheduledUntil - context.currentTime >= 4) { return; }
        const limit = session.follow ? domainEndRef.current : session.limit;
        if (session.nextTime >= limit - 0.5 / sampleRate) { return; }
        const requestId = --playbackRequestSequence;
        session.pending = requestId;
        broadcastMessage({
            command: 'requestMediaAudioWindow', requestId,
            payload: {
                rangeStart: session.nextTime, rangeEnd: Math.min(limit, session.nextTime + 2),
                quality: 'high', purpose: 'playback'
            },
        });
    }, [sampleRate]);

    const play = useCallback(async (range: ViewRange, broadcast = true) => {
        stopPlayback(false);
        if (sampleRate <= 0 || range[1] <= range[0]) { return; }
        const context = contextRef.current ?? new AudioContext({ sampleRate });
        contextRef.current = context;
        const session = {
            nextTime: range[0], scheduledUntil: context.currentTime, limit: range[1],
            follow: Math.abs(range[1] - domainEndRef.current) <= 1 / sampleRate,
            pending: null as number | null, broadcast,
        };
        sessionRef.current = session;
        setIsPlaying(true);
        try {
            if (context.state === 'suspended') { await context.resume(); }
            if (sessionRef.current !== session) { return; }
            session.scheduledUntil = context.currentTime;
            pump();
        } catch {
            if (sessionRef.current === session) { stopPlayback(); }
        }
    }, [pump, sampleRate, stopPlayback]);

    useEffect(() => {
        const onWindow = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) { return; }
            const message = event.data;
            const session = sessionRef.current;
            const context = contextRef.current;
            if (!session || !context || message.command !== 'mediaAudioWindowData' || message.requestId !== session.pending) { return; }
            session.pending = null;
            const frames: SampleFrame[] = message.payload?.samples ?? [];
            const pcm: number[] = [];
            let nextTime = session.nextTime;
            for (const frame of frames) {
                for (let index = 0; index < frame.samples.length; index++) {
                    const time = frame.timestamp + index / sampleRate;
                    if (time < nextTime - 0.5 / sampleRate) { continue; }
                    if (time > nextTime + 0.5 / sampleRate) { break; }
                    pcm.push(frame.samples[index]);
                    nextTime += 1 / sampleRate;
                }
            }
            if (!pcm.length) {
                if (!sourcesRef.current.size) { stopPlayback(); }
                return;
            }
            if (sourcesRef.current.size && session.scheduledUntil < context.currentTime) {
                stopPlayback();
                return;
            }
            const buffer = context.createBuffer(1, pcm.length, sampleRate);
            buffer.copyToChannel(Float32Array.from(pcm), 0);
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            const startAt = Math.max(context.currentTime, session.scheduledUntil);
            session.scheduledUntil = startAt + pcm.length / sampleRate;
            session.nextTime = nextTime;
            sourcesRef.current.add(source);
            source.onended = () => {
                source.disconnect();
                sourcesRef.current.delete(source);
                if (sessionRef.current !== session) { return; }
                if (!sourcesRef.current.size) { stopPlayback(); } else { pump(); }
            };
            source.start(startAt);
            if (session.broadcast) {
                session.broadcast = false;
                broadcastMessage({ type: 'broadcast', timeStamp: frames[0].timestamp, fileName: filename, playbackState: 'playing' });
            }
            pump();
        };
        window.addEventListener('message', onWindow);
        const timer = setInterval(pump, 250);
        return () => {
            clearInterval(timer);
            window.removeEventListener('message', onWindow);
        };
    }, [filename, pump, sampleRate, stopPlayback]);

    useEffect(() => { pump(); }, [domainEnd, pump]);

    useEffect(() => {
        setIsPlaying(false);
        return () => {
            stopPlayback(false);
            const context = contextRef.current;
            contextRef.current = null;
            if (context) { void context.close(); }
        };
    }, [sampleRate, bitDepth, channels, stopPlayback]);

    return { isPlaying, play, stopPlayback };
}
