import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { NewDatasetSchema } from '@autonomy-studio/shared';
import {
  createDataset,
  deleteDataset,
  getConnection,
  getDataset,
  listDatasetsPage,
  updateDataset,
} from '../repo/index.js';
import { BadRequestError, NotFoundError } from '../errors.js';
import { pageArgsFromQuery, requireOwned } from './util.js';
import type { Db } from '../repo/types.js';
import type { Principal } from '../auth/principal.js';

/**
 * #1114 (M2, data-movement spec §2) — the `datasets` REST surface, mirroring
 * `routes/connections.ts`.
 *
 * There is NO public projection here and no `toPublic`: a dataset carries no
 * secret and no internal FK to hide. Its store credential lives on the
 * connection it names (§2.6), and `config` is declared non-secret, so the stored
 * row IS the client-facing row.
 *
 * There is also no `/export` route in this slice. A dataset's `connectionId` is
 * a LOCAL db id that has to be remapped to the connection's stable `resourceId`
 * before it can leave this workspace, and the workspace-git path is what does
 * that. Single-resource dataset export/import is deliberately deferred with the
 * Manage → Datasets page it would belong beside (see the PR body).
 */

/**
 * The client-facing write body: everything `NewDatasetSchema` needs EXCEPT
 * `ownerId`, which is stamped from `request.principal` and never client-supplied.
 */
const DatasetWriteBodySchema = NewDatasetSchema.omit({
  ownerId: true,
  parameters: true,
}).extend({
  /**
   * #2 L13b — re-declared WITHOUT `DatasetSchema`'s `.default([])`, and the
   * difference is load-bearing for exactly the reason it is on Connection: Zod
   * applies a `.default()` even through the PATCH handler's `.partial()`, so
   * inheriting it would turn every patch that omits `parameters` — a rename,
   * say — into a silent reset of the stored allowlist to `[]`. `.optional()`
   * leaves the key ABSENT so `updateDataset`'s spread preserves the stored
   * value; the CREATE path still gets `[]` from `NewDatasetSchema`'s own
   * default inside `createDataset`.
   */
  parameters: z.array(z.string().min(1)).optional(),
});

/**
 * A dataset's `connectionId` names the store it lives in, and it arrives as raw
 * HTTP input — so being logged in is not evidence the caller may bind to it.
 * Authentication is not authorisation, and the check is HERE (the untrusted
 * boundary) rather than in the repo, which the workspace-git apply also calls
 * with an id it has already resolved owner-scoped through `connById`.
 *
 * This is deliberately an OWNERSHIP + existence check at write time, not a
 * standing guarantee — the connection can still be deleted afterwards, which is
 * the dangling case the serializer discloses and a dispatch will refuse (§3.1's
 * "refs to mutable rows are checked at dispatch" holds unchanged). What it stops
 * is a caller pointing a dataset at a store belonging to someone else in the
 * first place.
 *
 * A 400, not a 404: the dataset in the URL (on PATCH) is real and owned, so 404
 * would be a lie about the wrong resource. The message deliberately does not
 * distinguish "no such connection" from "not yours" — that difference is exactly
 * the existence oracle an unauthorised caller would be probing for.
 */
function requireOwnedConnection(db: Db, principal: Principal, connectionId: string): void {
  const connection = getConnection(db, connectionId);
  if (!connection || connection.ownerId !== principal.ownerId) {
    throw new BadRequestError(`no such connection "${connectionId}"`);
  }
}

export const datasetsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/datasets', async (request, reply) => {
    const body = DatasetWriteBodySchema.parse(request.body);
    requireOwnedConnection(db, request.principal, body.connectionId);
    const created = createDataset(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(created);
  });

  fastify.get('/api/datasets', async (request) => {
    // #534 — keyset-paginated envelope `{ items, nextCursor }`.
    const page = listDatasetsPage(db, request.principal.ownerId, pageArgsFromQuery(request.query));
    return { items: page.items, nextCursor: page.nextCursor };
  });

  fastify.get<{ Params: { id: string } }>('/api/datasets/:id', async (request) => {
    return requireOwned(
      getDataset(db, request.params.id),
      request.principal,
      'dataset',
      request.params.id,
    );
  });

  fastify.patch<{ Params: { id: string } }>('/api/datasets/:id', async (request) => {
    const existing = requireOwned(
      getDataset(db, request.params.id),
      request.principal,
      'dataset',
      request.params.id,
    );
    const patch = DatasetWriteBodySchema.partial().parse(request.body);
    // Only when the patch actually re-points the dataset — an omitted key leaves
    // the stored (already-checked) binding alone.
    if (patch.connectionId !== undefined) {
      requireOwnedConnection(db, request.principal, patch.connectionId);
    }
    const updated = updateDataset(db, existing.id, patch);
    if (!updated) throw new NotFoundError('dataset', existing.id);
    return updated;
  });

  fastify.delete<{ Params: { id: string } }>('/api/datasets/:id', async (request, reply) => {
    const existing = requireOwned(
      getDataset(db, request.params.id),
      request.principal,
      'dataset',
      request.params.id,
    );
    // No dependent re-gate, unlike the connection route: nothing binds a dataset
    // yet (node dataset refs are M3), and when they do, a node's ref is checked
    // at DISPATCH like `connectionId` — not by a delete-time scan (§3.1).
    deleteDataset(db, existing.id);
    reply.status(204).send();
  });
};
