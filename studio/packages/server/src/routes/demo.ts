import type { FastifyPluginAsync } from 'fastify';
import type { DemoRemoveResponse, DemoSeedResponse, DemoStatus } from '@autonomy-studio/shared';
import { demoStatus, removeDemo, seedDemo } from '../demo/demo-etl.js';

export interface DemoRoutesOptions {
  /** Where every owner's demo lives (`<demoRoot>/<ownerId>`); boot-resolved in `buildApp`. */
  demoRoot: string;
}

/**
 * #1481 OR32 — `POST /api/demo/seed` loads the demo ETL pack for the caller:
 * sample files and a SQLite warehouse under their own demo directory, the
 * connections (rooted there and nowhere wider), datasets, the five "Demo"
 * pipelines and their triggers. Idempotent and create-if-missing — see
 * `demo/demo-etl.ts`. No body: nothing about the demo is caller-chosen, so
 * nothing here is user input to validate beyond the principal.
 *
 * 201 when it created anything, 200 when every resource already existed.
 */
export const demoRoutes: FastifyPluginAsync<DemoRoutesOptions> = async (fastify, opts) => {
  const { db } = fastify;

  fastify.post('/api/demo/seed', async (request, reply) => {
    const result = seedDemo({ db, ownerId: request.principal.ownerId, demoRoot: opts.demoRoot });
    // A re-seed may recreate a deleted manual trigger; reconcile the
    // scheduler's rows exactly as `POST /api/triggers` does.
    fastify.scheduler.sync();
    reply.status(result.created > 0 ? 201 : 200).send(result satisfies DemoSeedResponse);
  });

  /** Whether any demo resource exists for the caller — the web's Load vs Remove. */
  fastify.get('/api/demo', async (request) => {
    return demoStatus(db, request.principal.ownerId) satisfies DemoStatus;
  });

  /**
   * Removes the caller's demo — rows, run history and files; see `removeDemo`
   * for what it refuses. 200 with the counts, also when nothing was loaded.
   */
  fastify.delete('/api/demo', async (request) => {
    try {
      return removeDemo({
        db,
        ownerId: request.principal.ownerId,
        demoRoot: opts.demoRoot,
      }) satisfies DemoRemoveResponse;
    } finally {
      // Also when the file step throws: by then the rows, triggers included,
      // are gone, and their schedule rows must go with them.
      fastify.scheduler.sync();
    }
  });
};
