/*
 * Shared helper for VS Code webview messaging.
 * Provides a tiny typed wrapper around postMessage / message events
 * so each webview app can register handlers consistently.
 */

import { WebviewMessage } from "./protocol";
import { broadcastMessage } from "./vscode-api";

// Minimal VS Code webview API surface used by the webview bundles.
// type VsCodeApi = {
//     postMessage(message: unknown): void;
//     getState?<T>(): T | undefined;
//     setState?<T>(state: T): void;
// };

// // Declared globally by VS Code inside the webview; we provide a local declaration for TS.
// declare function acquireVsCodeApi(): VsCodeApi;

export class WebviewMessenger<Inbound extends WebviewMessage, Outbound extends WebviewMessage> {
    private handlers = new Map<string, Set<(message: Inbound) => void>>();
    // private vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : {
    //     postMessage: (_: unknown) => undefined
    // };

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
