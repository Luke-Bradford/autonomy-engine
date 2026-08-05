import { z } from 'zod';
import {
  CreatePipelineVersionBodySchema,
  NewPipelineSchema,
  PipelineSchema,
  PipelineVersionSchema,
  paginatedResponseSchema,
  type Pipeline,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { ApiError, apiFetch, messageOf } from './client';
import { fetchAllPages, pageQuery } from './pagination';

const PipelinePageSchema = paginatedResponseSchema(PipelineSchema);
const PipelineVersionListSchema = z.array(PipelineVersionSchema);

/**
 * Client write bodies, derived from the SAME shared insert schemas the server
 * routes use (`packages/server/src/routes/pipelines.ts`), so the form's
 * client-side validation is identical to the server's — one source of truth.
 * `ownerId` is stamped server-side from the principal; `pipelineId` comes from
 * the route param, never the body. `PipelineWriteSchema` is a module-local (its
 * only external consumer is the derived `PipelineWrite` type); `createPipeline`
 * parses through it so the same shared shape validates the body client-side
 * before the POST. `PipelineVersionWriteSchema` is exported because the
 * canvas-doc tests parse against it.
 */
const PipelineWriteSchema = NewPipelineSchema.omit({ ownerId: true });
export type PipelineWrite = z.input<typeof PipelineWriteSchema>;

/**
 * The rename body, `pick`ed from the same write shape rather than re-declared,
 * so the name rule (non-empty) is the server's rule.
 *
 * Deliberately NOT the whole write shape `.partial()`: `PipelineWriteSchema`
 * DEFAULTS `concurrency` to `null`, and a `.partial()` over a defaulted field
 * still applies the default — so a rename would ship `concurrency: null` and
 * silently clear the pipeline's cap. The server guards its own PATCH body the
 * same way, for the same reason (`routes/pipelines.ts`).
 */
const PipelineRenameSchema = PipelineWriteSchema.pick({ name: true });

/**
 * #904 — the version-write body is the SHARED `CreatePipelineVersionBodySchema`
 * rather than a second local `NewPipelineVersionSchema.omit({ pipelineId })`.
 * That omit used to be written out here AND in `server/src/routes/pipelines.ts`
 * — two copies of one contract, which is exactly what the CAS basis field must
 * not become. Re-exported under the existing names so the canvas-doc tests and
 * `restoreBodyFrom` keep their import.
 */
export const PipelineVersionWriteSchema = CreatePipelineVersionBodySchema;
export type PipelineVersionWrite = z.input<typeof PipelineVersionWriteSchema>;

/**
 * Owner-scoped list of pipelines (`GET /api/pipelines`). Keyset-paginated
 * (#534); walks every page and returns the full list, so callers keep the same
 * `Promise<T[]>` contract. The `signal` is threaded through every page fetch.
 */
export function listPipelines(signal?: AbortSignal): Promise<Pipeline[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/pipelines${pageQuery(cursor)}`, { schema: PipelinePageSchema, signal }),
  );
}

/**
 * One pipeline by id (`GET /api/pipelines/:id`).
 *
 * Used by the canvas ROUTE (U4), which resolves `:pipelineId` straight from the
 * server rather than looking it up in `pipelinesStore`. A deep link into the
 * canvas must not depend on the list having finished loading — and the list is
 * page-walked, so waiting on it would make a bookmarked pipeline the slowest
 * page in the app. A pipeline id that is not this owner's surfaces as a 404
 * (`requireOwned`), never as someone else's graph.
 */
export function getPipeline(id: string, signal?: AbortSignal): Promise<Pipeline> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}`, { schema: PipelineSchema, signal });
}

/**
 * The immutable versions of one pipeline (`GET /api/pipelines/:id/versions`),
 * newest-or-oldest order as the server returns them. The Triggers page uses
 * these to offer a version-binding dropdown; a run/trigger always binds a
 * specific version id, never "latest".
 */
export function listPipelineVersions(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<PipelineVersion[]> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`, {
    schema: PipelineVersionListSchema,
    signal,
  });
}

/** Create a pipeline (`POST /api/pipelines`). The server assigns the id. */
export function createPipeline(body: PipelineWrite): Promise<Pipeline> {
  return apiFetch('/api/pipelines', {
    method: 'POST',
    body: PipelineWriteSchema.parse(body),
    schema: PipelineSchema,
  });
}

/**
 * Delete a pipeline (`DELETE /api/pipelines/:id`, 204). The server refuses
 * (409 `pipeline_has_runs`) when the pipeline has run history — the caller
 * catches `ApiError.status === 409` for a friendly message.
 */
export function deletePipeline(id: string): Promise<void> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * #907 — bring an ARCHIVED pipeline back to an editable state (`POST
 * /api/pipelines/:id/restore`, 200). Idempotent: restoring a live pipeline
 * answers 200 with the same shape.
 *
 * The API verb is `restore` (it drives `restorePipeline`, which predates this
 * route) but every user-facing string says **unarchive**, deliberately: in the
 * canvas "restore" already means restoring an old VERSION into the working
 * graph (#903), and one screen cannot use one word for two acts.
 *
 * Does NOT re-enable the triggers the archive disabled — the pipeline comes
 * back editable, not running. See the server route's docblock.
 */
export function restorePipeline(id: string): Promise<Pipeline> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    schema: PipelineSchema,
  });
}

/**
 * Save the canvas as a NEW immutable version (`POST /api/pipelines/:id/versions`).
 * A pipeline version is never updated in place — every save is a new row, whose
 * `version` the server auto-increments and whose `catalogVersion` it defaults to
 * the current catalog (the body omits it).
 */
export function createPipelineVersion(
  pipelineId: string,
  body: PipelineVersionWrite,
): Promise<PipelineVersion> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`, {
    method: 'POST',
    // #904 — parsed through the write schema before the POST, the convention
    // this module's docblock states and `createPipeline` already follows. It
    // was the one write here that did not, and the CAS basis is precisely the
    // field worth catching locally: a caller that omits it now fails at the
    // call site instead of as a 400 round-trip that reads like a server fault.
    body: PipelineVersionWriteSchema.parse(body),
    schema: PipelineVersionSchema,
  });
}

/**
 * Rename a pipeline (`PATCH /api/pipelines/:id`).
 *
 * The name is trimmed here rather than at each call site: the pane and the page
 * both take it from a free-text field, and a name of spaces is the same user
 * error in both. An empty result throws BEFORE the request — the server would
 * refuse it anyway (`name: z.string().min(1)`), and a 400 round trip to learn
 * what the shared schema already knows is a worse experience for the same
 * answer.
 *
 * `async` so that refusal is a REJECTED promise rather than a synchronous
 * throw: every caller is in `await`/`.catch()` shape, and a promise-returning
 * function that sometimes throws before returning one needs a `try` around the
 * call as well — a trap that only springs on the invalid input.
 */
export async function renamePipeline(id: string, name: string): Promise<Pipeline> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: PipelineRenameSchema.parse({ name: name.trim() }),
    schema: PipelineSchema,
  });
}

/**
 * The highest-numbered version of a pipeline, or `null` when it has none yet.
 *
 * Highest `version`, NOT the last element: the server's ordering is its own
 * business and a list that arrives oldest-first would silently open the wrong
 * graph. Shared by the canvas (which loads it for editing) and `duplicate`
 * below (which copies it) — one rule, not two that can drift.
 */
export function latestVersion(versions: PipelineVersion[]): PipelineVersion | null {
  return versions.reduce<PipelineVersion | null>(
    (best, v) => (best === null || v.version > best.version ? v : best),
    null,
  );
}

/**
 * Duplicate a pipeline under a new name (U4).
 *
 * COMPOSED from existing endpoints — create, read the source's latest version,
 * write it as the copy's first version — rather than added as a server route,
 * because the UI epic's stated non-goal is that its ONLY backend work is
 * read-only read-models. A source that has never been saved has no version to
 * copy, and the result is simply an empty pipeline.
 *
 * The copy carries the SOURCE's `catalogVersion` rather than defaulting to
 * today's. Duplicating is a copy, not a re-authoring: the graph is byte-identical
 * to one that was validated against that catalog, so stamping it with a newer
 * one would assert a compatibility nobody checked.
 *
 * NOT ATOMIC — there is no transaction across two HTTP requests. So the failure
 * path ROLLS BACK: a copy whose version write fails is deleted again (it is
 * seconds old and has no run history, so `DELETE` cannot 409 on it) and the
 * ORIGINAL error is what the caller sees. Leaving the empty husk behind would be
 * an unexplained pipeline appearing in the tree at the exact moment the user was
 * told the operation failed. If the rollback itself fails, the original error
 * still wins — a rollback error names the wrong problem.
 */
export async function duplicatePipeline(source: Pipeline, name: string): Promise<Pipeline> {
  let copy: Pipeline | undefined;
  try {
    /* Inside the `try`, not before it. The POST can COMMIT (201) and still
       throw here if its response body fails `PipelineSchema` — and a copy
       created outside the try would then never be rolled back, which is
       precisely the husk this function exists to avoid. `copy` is only bound
       after a successful parse, so the rollback below is a no-op in the case
       where nothing was created. */
    copy = await createPipeline({
      name: name.trim(),
      // A copy, not a re-authoring: `concurrency` is the only other
      // user-settable field on a pipeline, and letting the write schema's
      // `.default(null)` silently uncap the copy would be the same class of
      // manufactured-absence the project bans elsewhere (#473).
      concurrency: source.concurrency,
    });
    const latest = latestVersion(await listPipelineVersions(source.id));
    if (latest) {
      await createPipelineVersion(copy.id, {
        params: latest.params,
        outputs: latest.outputs,
        nodes: latest.nodes,
        edges: latest.edges,
        containers: latest.containers,
        catalogVersion: latest.catalogVersion,
        // #904 — the CAS basis. The copy was created moments ago by the line
        // above and has no versions, so `null` ("I expect none yet") is the
        // literal truth rather than an opt-out. A 409 here would mean something
        // else wrote to a pipeline this call had just minted; it lands inside
        // the `try`, so the husk rollback below still fires.
        basedOnVersionId: null,
      });
    }
    return copy;
  } catch (err) {
    if (copy) await deletePipeline(copy.id).catch(() => undefined);
    throw err;
  }
}

/**
 * What to tell the user about a failed pipeline delete.
 *
 * The 409 (`pipeline_has_runs`) is a real, explainable REFUSAL rather than a
 * fault, so it gets its own sentence. Shared because both delete surfaces — the
 * Factory Resources row menu and the pipelines page — face the same refusal,
 * and two hand-written copies of the sentence had already drifted apart
 * typographically before this was extracted.
 */
export function describeDeleteFailure(name: string, err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return `Cannot delete “${name}”: it has run history.`;
  }
  return `Could not delete “${name}”: ${messageOf(err)}`;
}
