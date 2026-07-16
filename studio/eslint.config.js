// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.sqlite', '**/*.sqlite-*'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  // #467 — the two TYPE-AWARE async-safety rules. Kept as a focused block (not
  // the whole `recommendedTypeChecked` preset) so the gate is bounded to the one
  // hazard it must close: an async callback whose rejection escapes a synchronous
  // `try/catch` and becomes an unhandled rejection — process-fatal on a headless
  // server. `projectService` is set ONLY here (not globally) and the block is
  // scoped to `packages/*/src/**`, so root config files (`eslint.config.js`,
  // `vite.config.ts`, `vitest.setup.ts`) keep the untyped parser and are not
  // "not found by the project service". Must stay AFTER `...recommended` so it
  // layers on rather than being overridden.
  {
    files: ['packages/*/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['**/*.config.{js,ts}', '**/vite.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
