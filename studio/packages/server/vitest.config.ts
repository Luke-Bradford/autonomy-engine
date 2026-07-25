import { defineConfig } from 'vitest/config';

/**
 * #723 — the server package's test timeouts.
 *
 * WHY THIS FILE EXISTS: vitest's default `testTimeout` is 5,000 ms, and until
 * this config landed the server package had no vitest config at all, so that
 * default applied to every test. That budget is *below the timeout the code
 * under test grants a single operation*: `src/git/provider.ts` allows
 * `DEFAULT_LOCAL_TIMEOUT_MS = 10_000` for one local git plumbing call (and
 * 60s/120s for fetch/push/clone). The real-git route tests
 * (`routes/__tests__/workspace-git-*.test.ts`, `git/__tests__/provider.test.ts`)
 * shell out to git SEVERAL times per test against temp repos, so the harness
 * was structurally under-budgeted relative to the thing it exercises. That is
 * arithmetic, not a load hypothesis — the load only decided WHICH run tripped.
 *
 * Observed: `pnpm test` from the repo root runs the three packages
 * concurrently, and under that contention a full-suite run failed roughly 1 in
 * 6 with `Error: Test timed out in 5000ms` in a real-git file that passes every
 * time in isolation (`workspace-git-import.test.ts`, whose 5 tests take ~17.8s
 * wall-clock together). A flaky REQUIRED check is the corrosive kind of
 * failure: it trains a reader to re-run until green, which is how a real
 * failure gets waved through.
 *
 * WHY PACKAGE-WIDE rather than per-file: `hookTimeout` covers the
 * `beforeEach` that builds a full Fastify app (DB, master key, boot reconcile)
 * in most suites here, not just the git ones, and the git provider is reachable
 * from any route test. A per-file `vi.setConfig` would have to be repeated
 * across 8 files and re-added by hand on the ninth.
 *
 * WHY 30s and not more: it must exceed `DEFAULT_LOCAL_TIMEOUT_MS` (10s) with
 * headroom for the several ops a single test makes, while still being far below
 * the provider's own 120s clone ceiling — so a genuinely WEDGED git child is
 * still killed by the provider's timeout and surfaces as a real assertion
 * failure, not as a silent 30s stall. This raises the ceiling on how long a
 * hung test can burn before failing; that is the conscious cost of not having
 * a flaky merge gate.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
