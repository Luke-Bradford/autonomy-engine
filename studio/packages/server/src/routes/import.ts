import type { FastifyPluginAsync } from 'fastify';
import { importEnvelope } from '../portability/index.js';

/**
 * The one import entry point for every version-stamped export envelope
 * (pipeline/connection/trigger — see `../portability/import.ts`). The body
 * IS the envelope (not wrapped in anything else); `importEnvelope` validates
 * + upgrades it and throws a typed `ImportError` (mapped to a structured 400
 * by the global error handler in `../errors.ts`) for anything malformed,
 * incompatible, or too new for this build.
 */
export const importRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/import', async (request, reply) => {
    const result = importEnvelope(db, request.principal.ownerId, request.body);
    reply.status(201).send(result);
  });
};
