// Lint configuration for zamda. Local rules live under scripts/lint/.
// The zamda accessor-callback rule is the project's own (docs/TASKS.md, T-208):
// it catches JavaScript operators where a zamda expression is required.
// TypeScript is parsed with the TypeScript parser and full type information (the nearest tsconfig).

import js from '@eslint/js';
import ts from 'typescript-eslint';
import noJsBooleanOpsInAccessorCallbacks from './scripts/lint/no-js-boolean-ops-in-accessor-callbacks.mjs';

export default [
  { ignores: ['node_modules', 'dist', 'data', 'spike', 'bench/results', 'engine/target', 'tests/lint'] },
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
    files: ['src/**/*.ts', 'demo/**/*.ts', 'scripts/**/*.{ts,mjs}', 'tests/**/*.ts', 'bench/**/*.ts'],
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
];
