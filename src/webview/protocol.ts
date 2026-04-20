// protocol.ts

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

export function getIndexedSdsSuffix(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }

    return value.match(/\.\d+\.sds$/i)?.[0].toLowerCase() ?? null;
}