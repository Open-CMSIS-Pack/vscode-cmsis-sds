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

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const js = require('@eslint/js');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const unusedImports = require('eslint-plugin-unused-imports');
const globals = require('globals');

const sharedRules = {
    '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
    }],

    '@typescript-eslint/no-this-alias': ['off'],
    '@typescript-eslint/prefer-readonly': ['error'],
    'block-spacing': ['error', 'always'],

    'brace-style': ['error', '1tbs', {
        allowSingleLine: true,
    }],

    'eol-last': ['error'],

    indent: ['error', 4, {
        SwitchCase: 1,
    }],

    'linebreak-style': ['error', 'unix'],

    'no-constant-condition': ['error', {
        checkLoops: false,
    }],

    'no-redeclare': 'off',
    'no-trailing-spaces': ['error'],
    'object-curly-spacing': ['error', 'always'],

    quotes: ['error', 'single', {
        avoidEscape: true,
    }],

    semi: ['error', 'always'],
    'space-in-parens': 'error',
    'space-before-blocks': 'error',
    'keyword-spacing': 'error',
    'space-infix-ops': 'error',
    'react/prop-types': 'off',
    'unused-imports/no-unused-imports': 'error',

    'unused-imports/no-unused-vars': ['warn', {
        vars: 'all',
        varsIgnorePattern: '^_',
        args: 'after-used',
        argsIgnorePattern: '^_',
    }],
};

module.exports = [
    {
        ignores: ['out/**', 'dist/**', 'node_modules/**', 'esbuild.js', '**/*.vsix'],
    },
    js.configs.recommended,
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: {
                project: ['./tsconfig.json', './scripts/tsconfig.json'],
                tsconfigRootDir: __dirname,
            },
            globals: {
                ...globals.node,
                ...globals.browser,
            },
        },
        settings: {
            react: {
                version: '18.3',
            },
        },
        plugins: {
            '@typescript-eslint': tsPlugin,
            react,
            'react-hooks': reactHooks,
            'unused-imports': unusedImports,
        },
        rules: {
            ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
            ...tsPlugin.configs.recommended.rules,
            ...react.configs.recommended.rules,
            'react/react-in-jsx-scope': 'off',
            'react/jsx-uses-react': 'off',
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
            ...sharedRules,
        },
    },
    {
        files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
            }],
            'no-trailing-spaces': ['error'],
            'eol-last': ['error'],
            semi: ['error', 'always'],
            quotes: ['error', 'single', {
                avoidEscape: true,
            }],
        },
    },
];