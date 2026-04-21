/*
 * Copyright (c) 2026 Arm Limited
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message } from './protocol';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isMessage(msg: any): msg is Message {
    return msg && typeof msg.type === 'string';
}