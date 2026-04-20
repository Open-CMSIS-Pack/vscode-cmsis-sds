/* eslint-disable @typescript-eslint/no-explicit-any */
// webview.d.ts

declare function acquireVsCodeApi(): {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
};

declare module '*.css';