import type { Message } from './protocol';

const vscode = acquireVsCodeApi();

export function broadcastMessage(msg: Message) {
    vscode.postMessage(msg);
}

export function getState<T>() {
    return vscode.getState() as T;
}

export function setState<T>(state: T) {
    vscode.setState(state);
}