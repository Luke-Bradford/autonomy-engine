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
import { datasetReferences } from '../datamove/dataset-references.js';
import { listSheetsForConnection } from '../connectors/xlsx-sheets.js';
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
function requireOwnedConnection(
  db: Db,
  principal: Principal,
  connectionId: string,
): NonNullable<ReturnType<typeof getConnection>> {
  const connection = getConnection(db, connectionId);
  if (!connection || connection.ownerId !== principal.ownerId) {
    throw new BadRequestError(`no such connection "${connectionId}"`);
  }
  // Returns the ROW (#1218) rather than only asserting: the sheet-listing route
  // needs the very config this has just proved the caller owns, and re-fetching
  // it would be a second lookup that could disagree with the one that authorised.
  return connection;
}

/**
 * #1218 — the body of `POST /api/datasets/sheets`.
 *
 * `path` is NOT `.min(1)`: an empty box is the ordinary state of a form the
 * operator has not finished filling in, and the answer to it is a refusal
 * sentence in the panel, not a 400 the form has to special-case.
 */
const DatasetSheetsBodySchema = z.object({
  connectionId: z.string().min(1),
  /**
   * `path` is NOT `.min(1)`: an empty box is the ordinary state of a form the
   * operator has not finished filling in, and the answer to that is a refusal
   * sentence in the panel, not a 400 the form would have to special-case.
   *
   * It IS capped. Nothing downstream would be harmed by a long string — the
   * confinement resolves it and the open fails — but every other size-sensitive
   * input in this tree is bounded by construction (`limits.ts`'s `XLSX_MAX_*`),
   * and an unbounded one here would be the exception that has to be argued
   * rather than the rule that holds. 4096 is `PATH_MAX` on Linux and four times
   * it on macOS, so it cannot refuse a path any filesystem could accept.
   */
  path: z.string().max(4096),
});

export const datasetsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.post('/api/datasets', async (request, reply) => {
    const body = DatasetWriteBodySchema.parse(request.body);
    requireOwnedConnection(db, request.principal, body.connectionId);
    const created = createDataset(db, { ...body, ownerId: request.principal.ownerId });
    reply.status(201).send(created);
  });

  /**
   * #1218 — the worksheet names of a workbook, so an `excel` dataset's `sheet`
   * can be CHOSEN instead of typed blind.
   *
   * THE ONLY ROUTE IN THIS PLUGIN THAT TOUCHES NO DATASET ROW, and it lives here
   * anyway: the caller is the dataset form, `path` is a dataset config field, and
   * the non-disclosing `requireOwnedConnection` above is already the right gate.
   * `routes/connections.ts` would have used `requireOwned`, which 404s and would
   * therefore tell an unauthorised caller which connection ids exist.
   *
   * It is a POST because the workbook path is data the operator is mid-way
   * through typing — a query string would put it in access logs and in browser
   * history. `/sheets` is a static segment and cannot collide with `/:id`;
   * find-my-way prefers the static one regardless.
   *
   * A refusal is a 200 carrying `{ ok: false, error }`, matching
   * `ConnectionProbeResultSchema` and for the same reason: every way this fails
   * is an ordinary authoring condition, so the form renders them all in one
   * place. The 400s that remain are protocol faults — a body that is not a body.
   *
   * SECURITY. Ownership is proved before the path is looked at; the path is then
   * confined against that connection's own `roots` and opened `O_NOFOLLOW`
   * (`confineFsPath` → `openConfinedFd`), so this route can reach nothing the
   * bound connection could not already read. It resolves no secret — an `fs`
   * connection has none — and the read is `xl/workbook.xml` alone.
   */
  fastify.post('/api/datasets/sheets', async (request) => {
    const body = DatasetSheetsBodySchema.parse(request.body);
    const connection = requireOwnedConnection(db, request.principal, body.connectionId);
    return listSheetsForConnection({
      connection: { kind: connection.kind, config: connection.config },
      path: body.path,
    });
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

  /**
   * #996 M9 (#1185) — which of the CALLER's pipelines reference this dataset,
   * and which of their pinned mappings no longer agree with its declared
   * columns (§2.1's second compensating control).
   *
   * Security model: `requireOwned` first, so an unowned or unknown id is a 404
   * before any walk happens — authentication is not authorisation, and the
   * reference list names the caller's own pipelines, which is precisely the
   * thing another owner must not learn. `requireOwned` demands exact owner
   * equality, so a null-owner (shared) dataset 404s here too; the walk is then
   * additionally owner-scoped on its own side, so the two agree rather than one
   * relying on the other.
   *
   * A READ. It gates nothing and it is called from no gate — §7's dispatch gate
   * remains the only refusal, and it compares against the store's ACTUAL
   * columns rather than these declared ones.
   */
  fastify.get<{ Params: { id: string } }>('/api/datasets/:id/references', async (request) => {
    const dataset = requireOwned(
      getDataset(db, request.params.id),
      request.principal,
      'dataset',
      request.params.id,
    );
    return datasetReferences(db, request.principal.ownerId, dataset);
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
    // No dependent re-gate, unlike the connection route. Nodes DO bind datasets
    // now — M3 added `Node.datasetIds` and M5's `copy` consumes it — and the
    // rule is unchanged by that: a node's dataset ref is checked at DISPATCH
    // like `connectionId`, never by a delete-time scan (§3.1). So deleting a
    // bound dataset succeeds and the copy fails when it next runs, which the
    // Manage → Datasets confirm dialog (#1115) now says out loud rather than
    // leaving the operator to find out.
    deleteDataset(db, existing.id);
    reply.status(204).send();
  });
};
