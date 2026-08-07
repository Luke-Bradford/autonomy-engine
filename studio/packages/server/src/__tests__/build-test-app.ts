import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../index.js';
import { UNREADABLE_ACCOUNT_QUOTA_READER } from '../quota/claude-quota.js';

export interface TestApp {
  app: FastifyInstance;
  /** The per-test scratch dir everything below lives in (also handy for fixtures, e.g. a bare git remote). */
  tmpDir: string;
  /** Where this app instance keeps managed git checkouts (#3 G2). */
  workspaceGitRoot: string;
}

/**
 * Builds a fresh, fully-isolated app instance + returns its context: a
 * brand-new tmp SQLite DB, a brand-new tmp master-key file, and a tmp
 * `workspaceGitRoot` (#3 G2), so tests never touch a developer's real
 * `~/.autonomy-studio/secrets/master.key` (or `data/git`) and never collide
 * with another test file's DB. Everything is passed to `buildApp()` as
 * call-time options rather than via `process.env` — `process.env` is
 * process-global and shared across concurrently-running test files in the
 * same vitest worker, so mutating it here would let two test files stomp
 * each other's paths (the FK-constraint flake this pattern replaced). Each
 * call to this function is independent of every other, in-flight or not.
 *
 * Not itself a `.test.ts` file (so vitest never runs it as a suite), but
 * still excluded from `pnpm build`'s output by
 * `tsconfig.build.json`'s `src/**\/__tests__/**` exclude pattern.
 */
export async function buildTestAppWithContext(
  overrides?: Partial<BuildAppOptions>,
): Promise<TestApp> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-server-test-'));
  const workspaceGitRoot = join(tmpDir, 'git');
  const app = await buildApp({
    dbPath: join(tmpDir, 'test.sqlite'),
    masterKeyFile: join(tmpDir, 'master.key'),
    workspaceGitRoot,
    // #3 G9b — isolate every test app from an AMBIENT `GH_TOKEN`/`GITHUB_TOKEN`
    // (e.g. a CI runner's) by defaulting to an EXPLICIT no-token; a test that
    // exercises auto-open overrides this. `process.env` is process-global and
    // shared across concurrent test files, so without this default a stray env
    // token would make the pull-request route attempt a real network auto-open.
    githubToken: null,
    // #440 (C1) — isolate every test app from the DEVELOPER'S OWN credential
    // store and the live provider, for the same reason as `githubToken` above:
    // the real reader shells out to the macOS Keychain and calls the usage
    // endpoint, so an un-stubbed test app would read a real credential and make
    // a real network call on any machine that has one. The quota suite passes
    // its own reader.
    claudeAccountQuotaReader: UNREADABLE_ACCOUNT_QUOTA_READER,
    // #990 — and isolate it from the developer's own `~/.codex` too, for the
    // same reason: the real codex reader walks a session tree on the host, so an
    // un-stubbed test app's `/api/quota/display` body would differ between a
    // machine that has codex and one that does not. `null` is ABSENT, which is
    // the body every test saw before #990; the quota suite passes its own.
    codexAccountQuotaReader: null,
    ...overrides,
  });
  await app.ready();
  return { app, tmpDir, workspaceGitRoot: overrides?.workspaceGitRoot ?? workspaceGitRoot };
}

/** The original shape most suites use — just the app. */
export async function buildTestApp(): Promise<FastifyInstance> {
  const { app } = await buildTestAppWithContext();
  return app;
}
