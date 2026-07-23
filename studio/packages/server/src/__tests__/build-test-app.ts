import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../index.js';

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
