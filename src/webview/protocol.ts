// protocol.ts

export type Message =
    | BroadcastMessage
    | InitMessage
    | UpdateStateMessage
    | WebviewMessage;

export type BroadcastMessage = WebviewMessage & {
    type: 'broadcast';
    currentFrame: number;
    timeStamp?: number;
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

// export function createBroadcastSourceId(startTimestamp: number, endTimestamp: number): string {
//     const input = `${startTimestamp}:${endTimestamp}`;
//     let hash = 0xcbf29ce484222325n;
//     const prime = 0x100000001b3n;
//     const mask = 0xffffffffffffffffn;

//     for (let index = 0; index < input.length; index++) {
//         hash ^= BigInt(input.charCodeAt(index));
//         hash = (hash * prime) & mask;
//     }

//     console.log(`Generated broadcast source ID ${hash.toString(16)} for range ${input}`);

//     return hash.toString(36);
// }

