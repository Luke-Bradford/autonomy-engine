import { defineConfig } from 'vitest/config';
import { TEST_INCLUDE } from '../../vitest.shared.js';

/**
 * #1199 — nothing package-specific; the argument lives in `vitest.shared.ts`.
 *
 * This package has no `dist/` on disk today, so it is the least exposed of the
 * four. It gets the guard anyway because the exposure is structural — a
 * project that includes tests and can emit — rather than a property of what
 * happens to be on disk this week.
 */
export default defineConfig({
  test: {
    include: TEST_INCLUDE,
  },
});
