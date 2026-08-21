import { defineConfig } from 'vitest/config';
import { TEST_INCLUDE } from '../../vitest.shared.js';

/**
 * #1199 — nothing package-specific: this exists only to apply the workspace's
 * one test-file allowlist, whose whole argument (why vitest 4 stopped excluding
 * `dist/`, why an allowlist rather than a denylist, and why it is one file
 * rather than four) lives in `vitest.shared.ts`.
 *
 * It is TYPECHECKED, per #726's precedent in `packages/server/tsconfig.json` —
 * vitest does not error on unknown keys, so a misspelt option here would leave
 * the guard silently absent with the typecheck still green.
 */
export default defineConfig({
  test: {
    include: TEST_INCLUDE,
  },
});
