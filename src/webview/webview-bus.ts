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

import * as vscode from 'vscode';
import { AppState, Message } from './protocol';

class WebviewBus {
    private readonly views = new Set<vscode.Webview>();

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
