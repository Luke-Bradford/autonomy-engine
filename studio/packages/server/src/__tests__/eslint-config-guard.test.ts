import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// #467 — a REGRESSION GUARD for a *silently* fail-open lint gate.
//
// `@typescript-eslint/no-floating-promises` and `no-misused-promises` are the
// two type-aware rules that catch an async callback whose rejection escapes a
// synchronous `try/catch` and becomes an unhandled rejection — on this headless
// server, that can take the process down. They are enabled in
// `studio/eslint.config.js` on `packages/*/src/**`.
//
// The plain `lint` CI check CANNOT catch their removal: delete the rules and
// `eslint .` stays green (there is nothing left to flag), so the gate would fail
// open in silence — exactly the class of bug #467 exists to close. This test
// resolves the EFFECTIVE config for a real server source file (globs included,
// via ESLint's own resolver) and asserts both rules are `error`, so turning
// either off fails loudly here instead.
//
// `eslint` is the workspace-root lint toolchain (declared in server's devDeps so
// this import is honest, not an implicit hoist); the config file it loads is the
// repo-root `studio/eslint.config.js`, four levels up from this test.
const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

// A file that MUST be covered by the typed block's `packages/*/src/**` glob —
// server's own entrypoint, the headless process the fail-open rejection would
// crash. If the glob ever stops matching real source, this resolves to the
// untyped config and the assertions fail.
const coveredFile = resolve(studioRoot, 'packages/server/src/index.ts');

describe('#467 typed-lint async-safety gate', () => {
  // #650 — flaked under the full-parallel workspace `pnpm test` (four packages'
  // vitest processes at once): constructing a real `ESLint` instance with the
  // typed-project service is the contention point, and the default timeout can
  // trip under that load while the same test passes standalone and in CI. The
  // retry is honest here BECAUSE the assertions are deterministic config
  // resolution — a genuine gate regression (rule removed/downgraded) fails all
  // three attempts identically; only environment contention is absorbed.
  it(
    'enables no-floating-promises and no-misused-promises for server source',
    { retry: 2, timeout: 30_000 },
    async () => {
      const eslint = new ESLint({ cwd: studioRoot });
      const config = await eslint.calculateConfigForFile(coveredFile);

      // `calculateConfigForFile` NORMALIZES severity to a number: `2` === 'error'
      // (`1` === 'warn', `0` === 'off'). Asserting `2` catches both "rule removed"
      // (undefined) and "downgraded to warn" (`1`), either of which reopens the gate.
      expect(config.rules?.['@typescript-eslint/no-floating-promises']?.[0]).toBe(2);
      expect(config.rules?.['@typescript-eslint/no-misused-promises']?.[0]).toBe(2);
    },
  );
});
