import { vi } from 'vitest';

/**
 * #1206 — module mocks for the api surfaces EVERY test hits by accident.
 *
 * `vitest.setup.ts` now fails any test that reaches the real `fetch`, and the
 * first thing that guard found was the shell: `VersionBadge` and `UpdateBanner`
 * load on every mount, so every suite that renders the app shell — four of them
 * today, and any written tomorrow — was making two unmocked network attempts.
 * A per-file mock is closed under nothing; this is, which is the whole reason
 * the same retrofit appears four times in `routes.test.tsx`'s comments.
 *
 * Used from a `vi.mock` factory, which is why it is a plain function rather
 * than a value: the factory is hoisted above every import in the test file, so
 * it can only reach this through a lazy `await import(...)`.
 *
 *   vi.mock('./api/version', async () =>
 *     (await import('./testing/apiModuleMocks')).versionModuleMock());
 *
 * No `importActual` is needed: these two functions ARE the module's whole
 * surface, so there is nothing to spread. The return type is checked against
 * the real module through a TYPE-only import, which does not trip the mock.
 */
const TEST_BUILD = {
  version: '0.0.0-test',
  commit: 'testcommit',
  builtAt: '2026-01-01T00:00:00.000Z',
  arch: 'test-arch',
};

export function versionModuleMock(): typeof import('../api/version') {
  return {
    getVersion: vi.fn().mockResolvedValue(TEST_BUILD),
    // `latest: null` + `updateAvailable: false` is the honest quiet default —
    // the schema keeps those two deliberately distinct, so a test about the
    // banner must say which it means rather than inherit it from here.
    getUpdateStatus: vi.fn().mockResolvedValue({
      current: TEST_BUILD,
      latest: null,
      updateAvailable: false,
      notes: null,
    }),
  };
}
