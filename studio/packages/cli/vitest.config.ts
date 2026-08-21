import { defineConfig } from 'vitest/config';

/**
 * #1199 — the cli package's test-file allowlist. The full argument for why this
 * is an allowlist rather than a `dist/` exclusion, and the measurements behind
 * it, are in `packages/shared/vitest.config.ts`; it is not repeated four times.
 *
 * This package has no `dist/` on disk today, so it is the least exposed of the
 * four. It gets the same guard anyway: the exposure is structural (`tsc -b
 * packages/cli` would select the test-including project and emit), not a
 * property of what happens to be on disk this week.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
