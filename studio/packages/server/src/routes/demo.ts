import type { FastifyPluginAsync } from 'fastify';
import { DemoSeedResponseSchema } from '@autonomy-studio/shared';
import { seedDemo } from '../demo/demo-etl.js';

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
    reply.status(result.created > 0 ? 201 : 200).send(DemoSeedResponseSchema.parse(result));
  });
};
