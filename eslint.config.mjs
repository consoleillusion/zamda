// Lint configuration for the whole workspace. The zamda accessor-callback rule is the library's own
// (packages/zamda/lint/, T-208): it catches JavaScript operators where a zamda expression is required,
// so it applies to every workspace that writes pipelines. TypeScript is parsed with full type
// information from each file's nearest tsconfig.

import js from '@eslint/js';
import ts from 'typescript-eslint';
import noJsBooleanOpsInAccessorCallbacks from './packages/zamda/lint/no-js-boolean-ops-in-accessor-callbacks.mjs';

export default [
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      'data',
      'bench/results',
      'packages/zamda/engine/target',
      'packages/zamda/tests/lint',
      'apps/*/.astro',
      'apps/*/public',
      '**/*.svelte',
      '**/*.astro',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: ts.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', project: true },
    },
    rules: {
      // TypeScript owns name checking; `no-redeclare` also fights TS's declaration merging.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
    },
  },
  {
    files: ['**/*.{ts,mjs}'],
    plugins: {
      zamda: {
        rules: {
          'no-js-boolean-ops-in-accessor-callbacks': noJsBooleanOpsInAccessorCallbacks,
        },
      },
    },
    rules: {
      'zamda/no-js-boolean-ops-in-accessor-callbacks': 'error',
    },
  },
  {
    // The library must not know about anything built on it (BGP data, benchmarks, demos).
    files: ['packages/zamda/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['@zamda/*', '**/bgp-data/**', '**/bench/**', '**/apps/**'], message: 'The zamda library must not import the BGP data, benchmarks or apps.' }] },
      ],
    },
  },
];
