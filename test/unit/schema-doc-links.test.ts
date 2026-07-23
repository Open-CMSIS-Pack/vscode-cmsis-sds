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

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

type JsonSchemaProperty = {
    title?: string;
};

type JsonSchema = {
    properties: Record<string, JsonSchemaProperty>;
};

const readSchema = (schemaFile: string): JsonSchema => {
    const schemaPath = path.join(process.cwd(), 'schema', schemaFile);
    return JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as JsonSchema;
};

describe('schema documentation links', () => {
    it('links top-level schema properties to their SDS documentation pages', () => {
        const sdsSchema = readSchema('sds.schema.json');
        const sdsioSchema = readSchema('sdsio.schema.json');

        expect(sdsSchema.properties.sds.title).toContain(
            'Documentation: https://arm-software.github.io/SDS-Framework/main/theory.html#sds-metadata-format',
        );
        expect(sdsioSchema.properties.sdsio.title).toContain(
            'Documentation: https://arm-software.github.io/SDS-Framework/main/utilities.html#sdsio-yml',
        );
    });
});
