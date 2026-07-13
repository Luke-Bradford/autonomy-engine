import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * Builds a fresh, fully-isolated app instance: a brand-new tmp SQLite DB and
 * a brand-new tmp master-key file, so tests never touch a developer's real
 * `~/.autonomy-studio/secrets/master.key` and never collide with another
 * test file's DB. `buildApp` is imported dynamically AFTER these env vars
 * are set (matching the pre-existing `app.test.ts` pattern) — `DB_PATH` is
 * read at `index.ts` module-eval time, and `AUTONOMY_MASTER_KEY_FILE` is
 * read inside `resolveMasterKey` when `buildApp()` calls it.
 *
 * Not itself a `.test.ts` file (so vitest never runs it as a suite), but
 * still excluded from `pnpm build`'s output by
 * `tsconfig.build.json`'s `src/**\/__tests__/**` exclude pattern.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-server-test-'));
  process.env.DB_PATH = join(tmpDir, 'test.sqlite');
  process.env.AUTONOMY_MASTER_KEY_FILE = join(tmpDir, 'master.key');
  const { buildApp } = await import('../index.js');
  const app = await buildApp();
  await app.ready();
  return app;
}
