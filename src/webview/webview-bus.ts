/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';
import { AppState, Message } from './protocol';

class WebviewBus {
    private views = new Set<vscode.Webview>();

    register(webview: vscode.Webview) {
        this.views.add(webview);
    }

    unregister(webview: vscode.Webview) {
        this.views.delete(webview);
    }

    handleIncoming(sender: vscode.Webview, msg: Message) {
        switch (msg.type) {
            case 'broadcast':
                this.broadcast(sender, msg);
                break;

            case 'updateState':
                this.updateState(msg.payload as Partial<AppState>);
                this.broadcast(sender, msg);
                break;
        }
    }

    private broadcast(sender: vscode.Webview, msg: Message) {
        for (const wv of this.views) {
            if (wv !== sender) {
                wv.postMessage(msg);
            }
        }
    }

    private state: AppState = { foo: 'init' };

    private updateState(patch: Partial<AppState>) {
        this.state = { ...this.state, ...patch };
    }

    sendInit(webview: vscode.Webview) {
        webview.postMessage({
            type: 'init',
            payload: { state: this.state },
        });
    }
}

export const webviewBus = new WebviewBus();