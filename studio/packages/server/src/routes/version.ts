import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { resolveBuildInfo } from '../build-info.js';

/**
 * `manifest.json` sits NEXT TO the server build, i.e. `app/manifest.json` with
 * the code in `app/dist/`. Resolved from this module's own URL rather than
 * `process.cwd()`, because the launchd service's working directory is not
 * guaranteed to be the install root.
 */
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json');

/** Read ONCE at registration: the artifact cannot change under a running process. */
export function versionRoutes(fastify: FastifyInstance): void {
  const info = resolveBuildInfo(MANIFEST_PATH);
  fastify.get('/api/version', () => info);
}
