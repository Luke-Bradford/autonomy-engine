import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { importEnvelope } from '../portability/index.js';
import { requireOwnedConnection } from './util.js';

/**
 * #1143 — the one thing a caller may decide for the file: which of ITS
 * connections a dataset lands in. A query parameter rather than a body wrapper,
 * so the body stays the bare envelope every other kind already sends. A
 * repeated `connectionId` arrives as an array and is a 400, never a pick.
 */
const ImportQuerySchema = z.object({ connectionId: z.string().min(1).optional() });

/**
 * The one import entry point for every version-stamped export envelope
 * (pipeline/connection/trigger/dataset — see `../portability/import.ts`). The
 * body IS the envelope (not wrapped in anything else); `importEnvelope`
 * validates + upgrades it and throws a typed `ImportError` (mapped to a
 * structured 400 by the global error handler in `../errors.ts`) for anything
 * malformed, incompatible, or too new for this build.
 *
 * `?connectionId=` names the store for a DATASET file. It is raw HTTP input, so
 * it is owner-checked here (authentication is not authorisation) with the exact
 * check `POST /api/datasets` runs, before the importer ever sees it.
 */
export const importRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/import', async (request, reply) => {
    const { connectionId } = ImportQuerySchema.parse(request.query);
    const result = importEnvelope(
      db,
      request.principal.ownerId,
      request.body,
      connectionId === undefined
        ? {}
        : { resolveStore: () => requireOwnedConnection(db, request.principal, connectionId) },
    );
    reply.status(201).send(result);
  });
};
