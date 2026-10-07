import { z } from 'zod';
import {
  ActivePipelineVersionResponseSchema,
  CreatePipelineVersionBodySchema,
  NewPipelineSchema,
  PipelineCostRollupSchema,
  PipelineSchema,
  PipelineVersionSchema,
  PipelineSummariesResponseSchema,
  PipelineVersionStatesResponseSchema,
  PublishPipelineBodySchema,
  PublishPipelineResultSchema,
  paginatedResponseSchema,
  type ActivePipelineVersion,
  type Pipeline,
  type PipelineCostRollup,
  type PipelineVersion,
  type PublishPipelineBody,
  type PublishPipelineResult,
  DebugRunRequestSchema,
  PipelineValidationSchema,
  PipelineDraftBodySchema,
  DebugRunResultSchema,
  FireResultSchema,
  ManualRunRequestSchema,
  type DebugRunRequest,
  type PipelineValidation,
  type PipelineDraftBody,
  type DebugRunResult,
  type FireResult,
  type ManualRunRequest,
  PipelineDependentsResponseSchema,
  type PipelineSummary,
  type PipelineVersionState,
  type PipelineDependentsResponse,
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

/** #1380 — the folder-move body, `pick`ed for the same reason as the rename. */
const PipelineFolderBodySchema = PipelineWriteSchema.pick({ folder: true });

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
 * The LIFETIME cost rollup of one pipeline (`GET /api/pipelines/:id/cost`).
 *
 * #931 / U27 — the route has existed since #599 and until now had no web caller
 * at all; this is that caller. The server answers with a BOUNDED SQL aggregation
 * over every run of the pipeline (all versions), so this is one small request
 * rather than a walk of runs × metered events — which is exactly why the figure
 * belongs to a single pipeline in view and not to a column on the pipelines list
 * (that would be one request per row, the #720 waterfall).
 *
 * A pipeline id that is not this owner's is a 404 from `requireOwned`, the same
 * as `getPipeline`. The caller decides what a 404 means for its surface.
 */
export function getPipelineCost(id: string, signal?: AbortSignal): Promise<PipelineCostRollup> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}/cost`, {
    schema: PipelineCostRollupSchema,
    signal,
  });
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

/**
 * One row per (pipeline, version) across the whole workspace, flattened.
 *
 * N+1 requests (one per pipeline), which is acceptable at MVP scale. Loading
 * them ALL up front rather than fetching a pipeline's versions when it is
 * chosen is what lets a caller answer "is this stored id a known version?" in
 * one shot, with no second in-flight window in which the answer changes.
 *
 * Lives HERE rather than in either caller because there are two: the Triggers
 * page's binding dropdown and the canvas's call-node target picker (#425) ask
 * the same question of the same two endpoints, and two independent copies of
 * "load every pipeline and every version" would drift.
 */
export async function listAllPipelineVersions(
  signal?: AbortSignal,
): Promise<{ pipeline: Pipeline; version: PipelineVersion }[]> {
  const pipelines = await listPipelines(signal);
  const perPipeline = await Promise.all(
    pipelines.map(async (pipeline) => {
      const versions = await listPipelineVersions(pipeline.id, signal);
      return versions.map((version) => ({ pipeline, version }));
    }),
  );
  return perPipeline.flat();
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
 * #1397 OR6 — what deleting the pipeline would take with it (`GET
 * /api/pipelines/:id/dependents`): whether runs refuse the delete, the triggers
 * the cascade removes, and the `call_pipeline` nodes elsewhere that would break.
 * Read before the confirmation so it can name them.
 */
export function listPipelineDependents(
  id: string,
  signal?: AbortSignal,
): Promise<PipelineDependentsResponse> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}/dependents`, {
    schema: PipelineDependentsResponseSchema,
    signal,
  });
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
 * #1058 — ARCHIVE a pipeline (`POST /api/pipelines/:id/archive`, 200). The
 * soft-delete counterpart to `deletePipeline`, and the only way to retire a
 * pipeline that has ever run: `DELETE` is refused with a 409 the moment run
 * history exists, because `pipeline_versions → runs` is `ON DELETE RESTRICT`.
 * Idempotent — archiving an archived pipeline answers 200 with the same shape.
 *
 * The route also returns which triggers it disabled; that is discarded at the
 * HTTP boundary (`return result.pipeline`), so a caller CANNOT report a count
 * afterwards. The disclosure therefore belongs in the pre-act confirmation —
 * see `archiveConfirmMessage`.
 */
export function archivePipeline(id: string): Promise<Pipeline> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    schema: PipelineSchema,
  });
}

/**
 * The owner's ARCHIVED pipelines (`GET /api/pipelines?archived=true`), page-walked
 * like `listPipelines`.
 *
 * A SEPARATE function rather than a parameter on `listPipelines`, deliberately:
 * `listPipelines` is the injected `fetchList` seam of `pipelinesStore`, so
 * widening its signature would change the store's contract for a list the store
 * must never hold. The store is the LIVE list and is shared with the
 * simultaneously-mounted Factory Resources pane; archived rows appearing in it
 * would leak into that pane's tree.
 */
export function listArchivedPipelines(signal?: AbortSignal): Promise<Pipeline[]> {
  return fetchAllPages((cursor) =>
    apiFetch(`/api/pipelines${pageQuery(cursor, { archived: 'true' })}`, {
      schema: PipelinePageSchema,
      signal,
    }),
  );
}

/**
 * The one thing about archive a reader would otherwise assume WRONGLY:
 * unarchiving does not re-arm what archiving switched off (`restorePipeline`'s
 * settled contract — a restore that silently re-armed a nightly schedule would
 * fire a pipeline the operator had said they were done with).
 *
 * A shared constant because TWO surfaces state it — the canvas banner
 * (`pages/pipeline/PipelineCanvas.tsx`) and this module's archive confirmation
 * — and two hand-written copies of one contract is exactly the drift
 * `describeDeleteFailure` exists to prevent. `e2e/archived-pipeline.spec.ts`
 * asserts on this literal.
 */
export const TRIGGERS_STAY_DISABLED_NOTE = 'its triggers stay disabled either way';

/**
 * What the next Commit does once a pipeline leaves the serialized set — by an
 * archive (#666) or a delete. One clause, because both confirmations state it.
 */
export const GIT_COMMIT_DELETES_FILES_NOTE =
  "your next Commit will delete its file — and its triggers' files — from the branch";

/**
 * What archiving "{name}" actually does, as the operator's confirmation.
 *
 * Extracted and exported (the `restoreConfirmMessage` shape) because the SAME
 * contract is already stated on the canvas banner — "its triggers stay disabled
 * either way" (`pages/pipeline/PipelineCanvas.tsx`) — and a second hand-written
 * copy is exactly the drift `describeDeleteFailure` exists to prevent.
 *
 * It names four consequences, and the fourth is the one an operator would not
 * predict: on a git-connected workspace an archived pipeline (and every trigger
 * bound to its versions) is OMITTED from the serialized set (#666), so the next
 * Commit stages the DELETION of those files from the branch. Naming a
 * consequence before the act is the whole difference between an archive and a
 * surprise — the standard `WorkspaceGitPage` already holds itself to.
 *
 * That last clause is phrased CONDITIONALLY ("if this workspace is connected to
 * git") rather than gated on the real connection state. Reading the state would
 * mean a workspace-git fetch on a page that otherwise needs none — a request and
 * a failure mode added to the pipelines list purely to choose between two
 * wordings. A conditional sentence is honest either way; a page that cannot
 * answer a question should not pretend to, and it must not stay SILENT on the
 * consequence just because it cannot cheaply confirm it applies.
 */
export function archiveConfirmMessage(name: string): string {
  return (
    `Archive pipeline "${name}"?\n\n` +
    'Its versions and run history are KEPT — this is not a delete. It disappears ' +
    'from the pipelines list, stops being dispatchable, and every trigger bound ' +
    'to it is disabled.\n\n' +
    `You can unarchive it from Show archived, but ${TRIGGERS_STAY_DISABLED_NOTE} — ` +
    'unarchiving brings the pipeline back editable, not running.\n\n' +
    'If this workspace is connected to git, an archived pipeline is left out of ' +
    `the committed set, so ${GIT_COMMIT_DELETES_FILES_NOTE}.`
  );
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
 * #1380 — file a pipeline under a folder, or back at the top level with `null`
 * (`PATCH /api/pipelines/:id`). A blank or all-space folder is `null` here, for
 * the reason `renamePipeline` trims: the field is free text, and "no folder" is
 * what an emptied field means.
 *
 * Its own `pick`, like the rename body, so the PATCH carries `folder` alone and
 * the write shape's defaults never reach the other fields.
 */
export async function movePipelineToFolder(id: string, folder: string | null): Promise<Pipeline> {
  const trimmed = folder?.trim() ?? '';
  return apiFetch(`/api/pipelines/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: PipelineFolderBodySchema.parse({ folder: trimmed === '' ? null : trimmed }),
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
export function latestVersion(versions: readonly PipelineVersion[]): PipelineVersion | null {
  return versions.reduce<PipelineVersion | null>(
    (best, v) => (best === null || v.version > best.version ? v : best),
    null,
  );
}

/**
 * Create a pipeline and write its first version, as ONE act to the caller.
 *
 * `firstVersion` is asked AFTER the create, with the new pipeline, and may
 * answer `null` for "no version" — Duplicate only learns whether its source has
 * one by reading it. The body's CAS basis is supplied here: the pipeline was
 * minted moments ago and has no versions, so `null` ("I expect none yet") is
 * the literal truth rather than an opt-out. A 409 would mean something else
 * wrote to a pipeline this call had just minted.
 *
 * NOT ATOMIC — there is no transaction across two HTTP requests. So the failure
 * path ROLLS BACK: a pipeline whose version write fails is deleted again (it is
 * seconds old and has no run history, so `DELETE` cannot 409 on it) and the
 * ORIGINAL error is what the caller sees. Leaving the empty husk behind would be
 * an unexplained pipeline appearing in the tree at the exact moment the user was
 * told the operation failed. If the rollback itself fails, the original error
 * still wins — a rollback error names the wrong problem.
 */
async function createPipelineWithFirstVersion(
  body: PipelineWrite,
  firstVersion: () => Promise<Omit<PipelineVersionWrite, 'basedOnVersionId'> | null>,
): Promise<Pipeline> {
  let created: Pipeline | undefined;
  try {
    /* Inside the `try`, not before it. The POST can COMMIT (201) and still
       throw here if its response body fails `PipelineSchema` — and a pipeline
       created outside the try would then never be rolled back, which is
       precisely the husk this function exists to avoid. `created` is only
       bound after a successful parse, so the rollback below is a no-op in the
       case where nothing was created. */
    created = await createPipeline(body);
    const version = await firstVersion();
    if (version) await createPipelineVersion(created.id, { ...version, basedOnVersionId: null });
    return created;
  } catch (err) {
    if (created) await deletePipeline(created.id).catch(() => undefined);
    throw err;
  }
}

/**
 * #1569 OR37 — the toolbar's New pipeline. A description lives on the VERSION
 * (#1 F8a, so a change to it is an edit like any other), so a pipeline created
 * with one is created with a first version: an empty graph carrying it. Without
 * one nothing is written but the pipeline, as before. A description of only
 * spaces is no description, and writes no version.
 */
export function newPipeline(body: PipelineWrite, description: string): Promise<Pipeline> {
  return createPipelineWithFirstVersion(body, () =>
    Promise.resolve(
      description.trim() === ''
        ? null
        : {
            params: [],
            outputs: [],
            nodes: [],
            edges: [],
            containers: [],
            variables: [],
            description,
            annotations: [],
          },
    ),
  );
}

/**
 * Duplicate a pipeline under a new name (U4).
 *
 * COMPOSED from existing endpoints — create, read the source's latest version,
 * write it as the copy's first version — rather than added as a server route,
 * because the UI epic's stated non-goal is that its ONLY backend work is
 * read-only read-models. A source that has never been saved has no version to
 * copy, and the result is simply an empty pipeline. A failed copy rolls back
 * (`createPipelineWithFirstVersion`).
 *
 * The copy carries the SOURCE's `catalogVersion` rather than defaulting to
 * today's. Duplicating is a copy, not a re-authoring: the graph is byte-identical
 * to one that was validated against that catalog, so stamping it with a newer
 * one would assert a compatibility nobody checked.
 */
export function duplicatePipeline(source: Pipeline, name: string): Promise<Pipeline> {
  return createPipelineWithFirstVersion(
    {
      name: name.trim(),
      // A copy, not a re-authoring: `concurrency` and `folder` (#1380) are the
      // other user-settable fields on a pipeline, and letting the write
      // schema's `.default(null)` silently uncap the copy, or file it at the top
      // level away from its source, would be the same class of
      // manufactured-absence the project bans elsewhere (#473).
      concurrency: source.concurrency,
      folder: source.folder,
    },
    async () => {
      const latest = latestVersion(await listPipelineVersions(source.id));
      return latest
        ? {
            params: latest.params,
            outputs: latest.outputs,
            nodes: latest.nodes,
            edges: latest.edges,
            containers: latest.containers,
            // #844 V1 — hand-listed like every field here, so a forgotten one is
            // silently defaulted away by the write schema.
            variables: latest.variables,
            description: latest.description,
            annotations: latest.annotations,
            catalogVersion: latest.catalogVersion,
          }
        : null;
    },
  );
}

/**
 * #979 (#3 G6c-1) — the pipeline's ACTIVE published version, or `null` if it has
 * never been published.
 *
 * Not git-gated: a DB-only workspace answers `{active: null}` rather than 404,
 * so this is safe to call for any pipeline. The caller must keep "unread" and
 * `null` apart — see `ActiveVersionState` in `pages/pipeline/versionHistory.ts`
 * for why that distinction is load-bearing rather than tidy.
 */
export function getActivePipelineVersion(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<ActivePipelineVersion | null> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/active`, {
    schema: ActivePipelineVersionResponseSchema,
    signal,
  }).then((res) => res.active);
}

/**
 * #1476 OR28 — every live pipeline's saved head and active version
 * (`GET /api/pipelines/version-states`), one read for the pipelines list's
 * state column. Not git-gated: a DB-only workspace answers `active: null`.
 */
export function listPipelineVersionStates(signal?: AbortSignal): Promise<PipelineVersionState[]> {
  return apiFetch('/api/pipelines/version-states', {
    schema: PipelineVersionStatesResponseSchema,
    signal,
  }).then((res) => res.items);
}

/**
 * #1569 OR37 — every live pipeline's row facts for the pipelines grid (last
 * run, the run window, triggers, next fire), one batched read.
 */
export function listPipelineSummaries(signal?: AbortSignal): Promise<PipelineSummary[]> {
  return apiFetch('/api/pipelines/summaries', {
    schema: PipelineSummariesResponseSchema,
    signal,
  }).then((res) => res.items);
}

/**
 * #979 (#3 G6c) — make `toVersionId` the active published version.
 *
 * The body goes through the SAME shared schema the route parses, the convention
 * the rest of this file follows: `expectedActiveVersionId` is required and
 * undefaulted on purpose (a missing expectation would be a fail-open CAS), so a
 * client that has not read the pointer cannot accidentally omit it here — it has
 * to state `null`, which is the positive claim "expected never-published".
 *
 * A business-rule refusal (no repo / archived / no git provenance / stale CAS)
 * arrives as one undifferentiated 409 `conflict`; `isPublishRefused` in
 * `versionHistory.ts` is the predicate for it.
 */
export function publishPipeline(
  pipelineId: string,
  body: PublishPipelineBody,
): Promise<PublishPipelineResult> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/publish`, {
    method: 'POST',
    body: PublishPipelineBodySchema.parse(body),
    schema: PublishPipelineResultSchema,
  });
}

/**
 * #1395 OR4 — run one saved version of the pipeline now, with no trigger
 * (`POST /api/pipelines/:id/runs`, the editor's Run). `started` carries the
 * `runId`; `skipped` carries the `reason` (the pipeline is at its concurrency
 * cap, or the server is stopping). A param the version cannot take is a 400
 * naming it, raised as an `ApiError` before any run exists.
 */
export function runPipelineVersion(
  pipelineId: string,
  body: ManualRunRequest,
): Promise<FireResult> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/runs`, {
    method: 'POST',
    body: ManualRunRequestSchema.parse(body),
    schema: FireResultSchema,
  });
}

/**
 * #1395 OR4 — run the editor's UNSAVED draft now (`POST
 * /api/pipelines/:id/debug-runs`, the editor's Debug). The server mints it as a
 * hidden debug version — no version list, head or trigger ever sees it — and
 * returns that version with the run, so the canvas can overlay the run on it. A
 * draft the save gate refuses, or a param it cannot take, is a 400 raised as an
 * `ApiError` before any version or run exists.
 */
export function debugPipelineDraft(
  pipelineId: string,
  body: DebugRunRequest,
): Promise<DebugRunResult> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/debug-runs`, {
    method: 'POST',
    body: DebugRunRequestSchema.parse(body),
    schema: DebugRunResultSchema,
  });
}

/**
 * #1476 OR28 — the editor's Validate (`POST /api/pipelines/:id/validate`): the
 * server's save gate run over the draft as a dry run. Resolves with the issues
 * a save would be refused with (`issues: []` = a save would pass); writes
 * nothing. A body the write schema refuses is a 400 `ApiError`, as on save.
 */
export function validatePipelineDraft(
  pipelineId: string,
  body: PipelineDraftBody,
): Promise<PipelineValidation> {
  return apiFetch(`/api/pipelines/${encodeURIComponent(pipelineId)}/validate`, {
    method: 'POST',
    body: PipelineDraftBodySchema.parse(body),
    schema: PipelineValidationSchema,
  });
}

/**
 * The refusal a pipeline with run history gets, before the confirmation
 * (`pipelineDeletePlan`) or after a 409 from a delete that raced a new run.
 * Runs are immutable audit history (`runs.pipeline_version_id` is FK-restrict),
 * so the way out is an archive — named by WHERE, because the Factory Resources
 * pane that also shows this has no Archive of its own.
 */
export function pipelineHasRunsMessage(name: string): string {
  return `Cannot delete “${name}”: it has run history. ${ARCHIVE_INSTEAD}`;
}

/** Where a pipeline's Archive is, for every refusal that points at it. */
export const ARCHIVE_WHERE = "from the Pipelines list or the editor's ⋯ menu";

/** The way out of a refused pipeline delete. */
export const ARCHIVE_INSTEAD = `Archive it instead, ${ARCHIVE_WHERE} — archiving keeps every version and run.`;

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
  if (err instanceof ApiError && err.status === 409) return pipelineHasRunsMessage(name);
  return `Could not delete “${name}”: ${messageOf(err)}`;
}
