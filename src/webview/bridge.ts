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

/*
 * Shared helper for VS Code webview messaging.
 * Provides a tiny typed wrapper around postMessage / message events
 * so each webview app can register handlers consistently.
 */

import { WebviewMessage } from './protocol';
import { broadcastMessage } from './vscode-api';

export class WebviewMessenger<Inbound extends WebviewMessage, Outbound extends WebviewMessage> {
    private readonly handlers = new Map<string, Set<(message: Inbound) => void>>();

    constructor() {
        this.handleMessage = this.handleMessage.bind(this);
        window.addEventListener('message', this.handleMessage);
    }

    public send(message: Outbound): void {
        broadcastMessage(message);
    }

    public on(type: Inbound['type'], handler: (message: Inbound) => void): () => void {
        if (!type) {
            return () => undefined;
        }
        const existing = this.handlers.get(type) ?? new Set();
        existing.add(handler);
        this.handlers.set(type, existing);
        return () => existing.delete(handler);
    }

    public dispose(): void {
        window.removeEventListener('message', this.handleMessage);
        this.handlers.clear();
    }

    private handleMessage(event: MessageEvent<Inbound>): void {
        if (event.origin !== window.location.origin) {
            return;
        }

        const message = event.data;
        const msgType = message?.type ?? message?.command;
        if (!message || typeof msgType !== 'string') {
            return;
        }
        const handlers = this.handlers.get(msgType);
        if (!handlers) {
            return;
        }
        handlers.forEach(fn => fn(message));
    }
}

export function getInitialState<T>(fallback: T): T {
    const anyWindow = window as unknown as { __INITIAL_STATE__?: unknown };
    if (anyWindow.__INITIAL_STATE__ !== undefined) {
        return anyWindow.__INITIAL_STATE__ as T;
    }
    return fallback;
}
