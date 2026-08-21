import { defineConfig } from 'vitest/config';

/**
 * #1199 — the shared package's test-file ALLOWLIST.
 *
 * WHY THIS FILE EXISTS AT ALL: vitest 4 removed `**\/dist\/**` from its default
 * `exclude`. Measured on the pinned 4.1.10 (`vitest/dist/chunks/defaults.*.js`):
 * `defaultExclude` is exactly `["**\/node_modules\/**", "**\/.git\/**"]`, where
 * every version through 3.x also excluded `dist`. `defaultInclude` matches
 * `**\/*.{test,spec}.?(c|m)[jt]s?(x)`, so a compiled `*.test.js` sitting in a
 * gitignored `dist/` is collected as a SECOND copy of the whole suite. Measured
 * before this fix, after one `tsc -b packages/shared`: `vitest list` reported
 * 5238 tests, of which 2619 came from `dist/` — the suite ran twice and the
 * duplicate copy failed across 96 files, which reads as a catastrophic
 * regression rather than as an artifact on disk.
 *
 * WHY AN ALLOWLIST, not `exclude: [...defaultExclude, '**\/dist\/**']`: naming
 * the known-bad directory only fixes THIS instance. `coverage/`, `.vite/`, a
 * stray `out/` or a copied tree would each need adding, and nothing in CI would
 * report the omission (`studio-ci` typechecks with `--noEmit` and builds AFTER
 * it tests, so no workflow step plants compiled tests before the test step —
 * this hazard is invisible to CI by construction). Stating where tests DO live
 * is closed under new directories; a denylist of the ones that burned us is the
 * same shape as an allowlist of "dangerous keys", which this repo has already
 * been bitten by once.
 *
 * The claim it encodes is checked: every `*.test.*` in this package is under
 * `src/`, and the only `*.spec.*` files in the workspace are Playwright's, in
 * `studio/e2e/`, which no package's vitest run collects.
 *
 * This is the SECOND of two defences and deliberately not the first. The
 * artifacts are stopped from being created at all by `noEmit` on the typecheck
 * project (see `tsconfig.json`); this stops them being *collected* however else
 * they might arrive. Both are needed: `exclude`/`include` would leave the
 * compiled copies rotting on disk, where they feed the other half of the same
 * class — a stale compiled tree going GREEN on code that no longer exists.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
