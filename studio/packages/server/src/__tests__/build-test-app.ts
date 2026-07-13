import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../index.js';

/**
 * Builds a fresh, fully-isolated app instance: a brand-new tmp SQLite DB and
 * a brand-new tmp master-key file, so tests never touch a developer's real
 * `~/.autonomy-studio/secrets/master.key` and never collide with another
 * test file's DB. `dbPath`/`masterKeyFile` are passed straight to
 * `buildApp()` as call-time options rather than via `process.env` —
 * `process.env` is process-global and shared across concurrently-running
 * test files in the same vitest worker, so mutating it here would let two
 * test files stomp each other's DB path (the FK-constraint flake this
 * pattern replaced). Each call to this function is independent of every
 * other, in-flight or not.
 *
 * Not itself a `.test.ts` file (so vitest never runs it as a suite), but
 * still excluded from `pnpm build`'s output by
 * `tsconfig.build.json`'s `src/**\/__tests__/**` exclude pattern.
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'autonomy-studio-server-test-'));
  const app = await buildApp({
    dbPath: join(tmpDir, 'test.sqlite'),
    masterKeyFile: join(tmpDir, 'master.key'),
  });
  await app.ready();
  return app;
}
