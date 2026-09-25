// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

// #897 — vitest runs a function RETURNED from `beforeEach`/`beforeAll` as that
// hook's teardown. An expression-bodied arrow returns whatever its expression
// does, and `mock.mockResolvedValue(…)` returns the MOCK: so vitest called the
// mocked API once more after every test, and a test that had armed it to reject
// failed after its assertions passed. The second selector closes the same hole
// through a block body's explicit `return`, while still admitting a returned
// function LITERAL, which is vitest's documented teardown idiom. It sees only a
// `return` at the top of the hook's body: one nested under an `if` or a loop
// passes, because esquery cannot say "a descendant, but not inside a nested
// function", and a plain descendant selector would flag every callback's own
// `return`. Shared by the web block and the rest-of-studio block below, because
// a later block's `no-restricted-syntax` REPLACES an earlier one's rather than
// adding to it.
const HOOK_RETURNS_TEARDOWN = [
  {
    selector:
      "CallExpression[callee.name=/^(beforeEach|beforeAll)$/] > ArrowFunctionExpression[body.type!='BlockStatement']",
    message:
      'Give this hook a block body. vitest runs a function returned from beforeEach/beforeAll as its teardown, and `() => mock.mockResolvedValue(…)` returns the mock (#897).',
  },
  {
    selector:
      'CallExpression[callee.name=/^(beforeEach|beforeAll)$/] > :matches(ArrowFunctionExpression, FunctionExpression) > BlockStatement > ReturnStatement[argument][argument.type!=/^(ArrowFunctionExpression|FunctionExpression)$/]',
    message:
      'Return only a function literal from beforeEach/beforeAll: vitest runs whatever function the hook returns as its teardown, so returning a call result (a mock, say) runs it again after the test (#897).',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.sqlite',
      '**/*.sqlite-*',
      // Playwright run artifacts (#713). The HTML reporter emits `report.js`
      // and bundled trace JS, which `eslint .` would otherwise enumerate and
      // fail on. Kept in step with the same three entries in `.gitignore`.
      '**/test-results/**',
      '**/playwright-report/**',
      '**/blob-report/**',
    ],
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
      // #1227 — a `<label>` must not WRAP a `<select>`/`<textarea>`. Both render
      // their content (option text, the controlled value) as child text nodes,
      // so a wrapping label's text is `name + content`: Playwright's `getByLabel`
      // stops matching the moment a textarea is typed into, and a non-exact
      // match can resolve on another field's VALUE. Pair by `htmlFor`/`id`
      // (`useId`) instead — the idiom `ConfigFieldControl` and the trigger
      // editors already use. `<input>` is exempt: its value is an attribute.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "JSXElement[openingElement.name.name='label'] JSXElement[openingElement.name.name=/^(select|textarea)$/]",
          message:
            "Use LabelledControl (src/lib/LabelledControl.tsx) rather than wrapping this control in a <label>: a wrapping label absorbs the control's option text / value (#1227).",
        },
        ...HOOK_RETURNS_TEARDOWN,
      ],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['packages/web/**'],
    rules: {
      'no-restricted-syntax': ['error', ...HOOK_RETURNS_TEARDOWN],
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
