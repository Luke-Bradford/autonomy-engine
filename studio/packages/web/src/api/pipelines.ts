import { z } from 'zod';
import {
  NewPipelineSchema,
  NewPipelineVersionSchema,
  PipelineSchema,
  PipelineVersionSchema,
  paginatedResponseSchema,
  type Pipeline,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { apiFetch } from './client';
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

export const PipelineVersionWriteSchema = NewPipelineVersionSchema.omit({ pipelineId: true });
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
    body,
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
export async function duplicatePipeline(sourceId: string, name: string): Promise<Pipeline> {
  const copy = await createPipeline({ name: name.trim() });
  try {
    const source = latestVersion(await listPipelineVersions(sourceId));
    if (source) {
      await createPipelineVersion(copy.id, {
        params: source.params,
        outputs: source.outputs,
        nodes: source.nodes,
        edges: source.edges,
        containers: source.containers,
        catalogVersion: source.catalogVersion,
      });
    }
    return copy;
  } catch (err) {
    await deletePipeline(copy.id).catch(() => undefined);
    throw err;
  }
}
