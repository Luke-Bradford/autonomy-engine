import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { resolveBuildInfo } from '../build-info.js';
import { checkForUpdate } from '../update/check.js';

/**
 * This module compiles to `dist/routes/version.js`, so TWO levels up from its
 * own URL is the package root — `packages/server/manifest.json` in a dev
 * checkout, and the app root (`app/manifest.json`, beside `app/dist/`) in a
 * packaged install, per the Dockerfile's `WORKDIR /app` copying the build to
 * `/app/dist`. That is where the build step (`scripts/write-manifest.mjs`)
 * writes it. Resolved from this module's own URL rather than `process.cwd()`,
 * because the launchd service's working directory is not guaranteed to be the
 * install root.
 */
export const MANIFEST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'manifest.json',
);

/** Read ONCE at registration: the artifact cannot change under a running process. */
export function versionRoutes(fastify: FastifyInstance): void {
  const info = resolveBuildInfo(MANIFEST_PATH);
  fastify.get('/api/version', () => info);
  fastify.get('/api/update/available', () => checkForUpdate(info));
}
