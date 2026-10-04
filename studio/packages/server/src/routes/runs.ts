import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import {
  computeRunCost,
  RunsPaginationQuerySchema,
  RUNS_EXPORT_TRUNCATED_HEADER,
  RUNS_MAX_PAGE_SIZE,
  CompleteExternalWaitBodySchema,
  RUN_SINCE_MS,
  RunAnnotationFilterSchema,
  RunEpochBoundSchema,
  RunSearchSchema,
  RunSortDirSchema,
  RunSortKeySchema,
  RunTriggeredByKindListSchema,
  type RunAnnotationsResponse,
  RunSinceSchema,
  RunStatusSchema,
  type CompleteExternalWaitBody,
  type PendingExternalWait,
  type RerunAccepted,
  type RunCancelAccepted,
  type ApiErrorBody,
  type RunDetail,
  type ActivityRunChild,
  type ActivityRunsResponse,
} from '@autonomy-studio/shared';
import {
  getPipeline,
  getRun,
  isDebugVersion,
  getTrigger,
  listRunAnnotations,
  listRunDiagnostics,
  listRunEvents,
  listRuns,
  listRunSummariesPage,
} from '../repo/index.js';
import { getExternalWaitByAttempt, listPendingExternalWaitsByRun } from '../repo/external-waits.js';
import { deriveExternalWaitToken } from '../webhooks/external-wait-token.js';
import { makeRunActivityFold } from '../run/activity-counts.js';
import { buildEngine, makeDocResolver } from '../run/driver.js';
import { projectActivityRuns } from '../run/activity-runs.js';
import { loadEngineLog } from '../run/events.js';
import { BadRequestError, BusyError, NotFoundError } from '../errors.js';
import {
  ExternalWaitPayloadError,
  ExternalWaitSettledError,
} from '../run/external-wait-service.js';
import { noStore, requireOwned } from './util.js';
import { decodeRunCursor, resolveRunSort, type RunCursor, type RunSort } from '../repo/run-sort.js';
import type { ListRunSummariesFilter, RunPageArgs } from '../repo/runs.js';
import { RUNS_EXPORT_MAX_ROWS } from '../limits.js';
import { collectRunsForExport, RUNS_EXPORT_COLUMNS, runExportRow } from '../run/runs-export.js';
import { toCsv } from '../util/csv.js';
import { KeyedSlots } from '../util/keyed-slots.js';

/**
 * `pipelineVersionId`/`triggerId`/`parentRunId` are opaque ids, not
 * fielded/typed values — validated only for shape (non-empty strings) before
 * they reach the repo layer, same discipline every request-body route
 * already applies via a Zod schema.
 */
const ListRunsQuerystringSchema = z.object({
  pipelineVersionId: z.string().min(1).optional(),
  triggerId: z.string().min(1).optional(),
  parentRunId: z.string().min(1).optional(),
  // RS6 — the rerun-history grouping filter: `?rerunOf=R1` lists R1's reruns.
  rerunOf: z.string().min(1).optional(),
  // U26 — the Monitor filter pane. `status` and `since` are FIELDED, so they
  // parse through their own shared vocabularies and a junk value is a 400 rather
  // than a filter that silently matches nothing. `pipelineId` is an opaque id
  // like the four above it, shape-checked only.
  status: RunStatusSchema.optional(),
  pipelineId: z.string().min(1).optional(),
  /**
   * A RELATIVE window (`1h`/`24h`/`7d`/`30d`), resolved to an epoch lower bound
   * HERE rather than by the caller. Two reasons, both correctness:
   *
   *  - the bound is compared against `runs.started_at`, which THIS process
   *    stamps (`createRun`), so resolving it here measures the window against
   *    the same clock that wrote the column — a browser resolving it would widen
   *    or narrow the window by its own skew, silently.
   *  - a relative window keeps a shared/bookmarked URL honest: `?since=24h`
   *    still means "the last day" tomorrow, where a baked-in epoch would quietly
   *    become "the day before yesterday".
   *
   * A closed enum also means there is no numeric query param to coerce, which is
   * how the empty string (`?startedAfter=`, which `z.coerce.number()` accepts as
   * `0`) would otherwise have become an always-empty upper bound with no error.
   */
  since: RunSinceSchema.optional(),
  // U26 — exact match against the bound version's annotations. Shape-checked
  // by the ONE schema the web also reads the URL with (see its docblock).
  annotation: RunAnnotationFilterSchema.optional(),
  /**
   * #1484 OR35 M1 — the one-row filter bar's axes. `kind` is a comma list of
   * `RUN_TRIGGERED_BY_KINDS`, canonicalised; `q` is the search box; `from`/`to`
   * are the day picker's ABSOLUTE bounds (epoch ms, `from` inclusive, `to`
   * exclusive). Unlike `since`, a picked DAY is the viewer's calendar day, so
   * the browser resolves it; the server's clock has no say in where it starts.
   * `since` and `from` may both arrive, and both are lower bounds: ANDed, they
   * only narrow.
   */
  kind: RunTriggeredByKindListSchema.optional(),
  q: RunSearchSchema.optional(),
  from: RunEpochBoundSchema.optional(),
  to: RunEpochBoundSchema.optional(),
  /**
   * #1484 OR35 M1 — the grid's sort (`repo/run-sort.ts`). Closed enums, so a
   * junk value is a 400. An absent `dir` is the column's natural direction
   * (`RUN_SORT_NATURAL_DIR`), the same reading the browser makes of its URL.
   */
  sort: RunSortKeySchema.optional(),
  dir: RunSortDirSchema.optional(),
  /**
   * #1484 OR35 M1 — also return the page's `descendants` (the runs its runs
   * called), for the grid's "Include child runs". A display mode, not a filter:
   * the page and its cursor are the same either way. `pipelines.ts`'s `archived`
   * convention, so a junk value is a 400.
   */
  includeChildren: z.enum(['true', 'false']).optional(),
});

/**
 * `pageArgsFromQuery` for the runs list, whose cursor names the sort that minted
 * it (`decodeRunCursor`). A cursor that is unreadable, OR was minted under a
 * different sort or direction than this request asks for, is a 400: resuming it
 * would answer a coherent but different slice, and nothing downstream could tell.
 */
function runPageArgsFromQuery(query: unknown, sort: RunSort): RunPageArgs {
  const { limit, cursor } = RunsPaginationQuerySchema.parse(query);
  if (cursor === undefined) return { limit, sort };
  const decoded = decodeRunCursor(cursor, sort);
  if (!decoded) throw new BadRequestError('invalid cursor, or one minted under another sort');
  return { limit, sort, cursor: decoded };
}

/**
 * The list's filter axes from its query, with the caller's `ownerId` ANDed in.
 * One mapping for `GET /api/runs` and its CSV export, so the two can never
 * match different runs for the same query string.
 */
function runFilterFromQuery(
  query: z.infer<typeof ListRunsQuerystringSchema>,
  ownerId: string,
): ListRunSummariesFilter {
  const { since, from, to, kind, q } = query;
  const sinceBound = since === undefined ? undefined : Date.now() - RUN_SINCE_MS[since];
  return {
    pipelineVersionId: query.pipelineVersionId,
    triggerId: query.triggerId,
    parentRunId: query.parentRunId,
    rerunOf: query.rerunOf,
    status: query.status,
    pipelineId: query.pipelineId,
    annotation: query.annotation,
    kinds: kind,
    search: q,
    // The later of two lower bounds is the one that narrows.
    startedAfter:
      sinceBound === undefined
        ? from
        : from === undefined
          ? sinceBound
          : Math.max(from, sinceBound),
    startedBefore: to,
    ownerId,
  };
}

/** A cursor the export's own walk minted, decoded under the walk's sort. */
function decodeExportCursor(raw: string, sort: RunSort): RunCursor {
  const decoded = decodeRunCursor(raw, sort);
  if (!decoded) throw new Error('runs export: the walk minted a cursor it cannot read back');
  return decoded;
}

/**
 * Runs are created by the engine/scheduler (P2-P4), so there is deliberately no
 * `POST /api/runs` create route. TWO state-mutating actions live here, both of
 * them resuming an existing run rather than starting one: RS2's
 * `POST /api/runs/:id/rerun-from-failed` (a new run resuming a FAILED one) and
 * #901's `POST /api/runs/:id/external-waits/complete` (settle a parked wait on
 * THIS run). Every other route is read-only. Both mutators are owner-scoped
 * through the run and answer before their downstream drive finishes.
 */
export const runsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;
  const resolveDoc = makeDocResolver(db);
  // #1484 — one per app, so its memo of settled runs' counts outlives a request.
  const foldActivities = makeRunActivityFold(resolveDoc, {
    onUnreadable: (runId, err) =>
      fastify.log.warn({ err, runId }, 'runs list: cannot count the activities of this run'),
  });
  // #1484 — the CSV export's, memo-less (see the export route).
  const exportActivities = makeRunActivityFold(resolveDoc, {
    memoLimit: 0,
    onUnreadable: (runId, err) =>
      fastify.log.warn({ err, runId }, 'runs export: cannot count the activities of this run'),
  });
  // #1534 — one export per owner at a time (see the export route).
  const exportingOwners = new KeyedSlots();

  /**
   * R2 — the Monitor's list read-model. Each item is a `RunSummary`: every field
   * of the `Run` row PLUS the pipeline's name + version number and the trigger's
   * name, joined server-side so U10's list needn't N+1 its way to a human label.
   *
   * KEYSET-PAGINATED since #1083 (`{ items, nextCursor }`, the #534 envelope),
   * and this was the LAST list route emitting an unbounded body. It is also the
   * one that most needed bounding: runs have no retention policy, so the
   * response grew for the life of the workspace and never fell, and every
   * element carries a joined summary plus an aggregated cost.
   *
   * NEWEST-FIRST BY DEFAULT. This route once refused an `?order=` param because
   * it had one reader with one meaning; #1484's runs grid is a second reader that
   * sorts by column, so `?sort=`/`?dir=` now exist (`repo/run-sort.ts`). Unlike
   * the audit log's `order`, the cursor here NAMES its sort, and a cursor
   * replayed under another one is a 400 (`runPageArgsFromQuery`).
   *
   * The response shape widened from `Run[]` to `RunSummary[]`, which is safe
   * because `RunSummarySchema` is strictly ADDITIVE over `RunSchema` — it adds
   * keys and changes none.
   * Any reader still parsing an element through `RunSchema` keeps working (zod
   * strips the extra keys); nothing about the existing fields moved or changed
   * meaning. The per-run route (`GET /api/runs/:id`) deliberately keeps
   * returning a bare `Run`: it has no list to de-N+1, and the detail page
   * already resolves the version doc itself via `/detail`.
   *
   * Rows come back newest-first with a total, deterministic tie-break; the
   * previous route promised an order the query never actually imposed.
   *
   * SECURITY — U26's filter axes are ADDITIVE. `ownerId` is not one of them: it
   * comes from `request.principal` and is ANDed in unconditionally by
   * `listRunsConditions`, so every axis a caller supplies can only ever NARROW
   * their own runs. There is no shape of query string that widens past it.
   *
   * `pipelineId`/`triggerId` are deliberately NOT ownership-validated here, and
   * that is the safer choice rather than a gap: running them through
   * `requireOwned` would 404 a pipeline belonging to someone else while an id
   * that exists nowhere returned an empty 200 — an existence oracle for other
   * owners' ids. ANDing them with the owner scope instead never looks the
   * pipeline up at all, so a foreign id and a nonexistent one are
   * indistinguishable: both match none of the caller's runs.
   */
  fastify.get('/api/runs', async (request) => {
    const query = ListRunsQuerystringSchema.parse(request.query);
    const page = listRunSummariesPage(
      db,
      runFilterFromQuery(query, request.principal.ownerId),
      {
        ...runPageArgsFromQuery(request.query, resolveRunSort(query.sort, query.dir)),
        includeChildren: query.includeChildren === 'true',
      },
      foldActivities,
    );
    return page;
  });

  /**
   * #1484 OR35 M1 — the runs grid's "CSV export of the filtered set": every run
   * the SAME filters and sort match, as `text/csv`, up to `RUNS_EXPORT_MAX_ROWS`.
   *
   * It walks `GET /api/runs`'s own pages server-side (`collectRunsForExport`)
   * rather than having the browser do it: one request instead of fifty, and one
   * query, so the file and the grid cannot disagree about which runs match.
   * Exactly the filtered set — `includeChildren` is the grid's display mode, not
   * a filter, and each row's `parent_run_id` already says what called it.
   * `limit`/`cursor` are not read: an export starts at the top.
   *
   * SECURITY — the list's: `ownerId` comes from the principal and is ANDed in by
   * `runFilterFromQuery`, so no query string widens past the caller's runs, and
   * the columns are the grid's, never `params` (`RUNS_EXPORT_COLUMNS`).
   *
   * Its OWN activity fold, with no memo. The list's fold remembers the last
   * `ACTIVITY_FOLD_MEMO_LIMIT` runs it was asked about; walking ten thousand
   * through it would evict every run the live grid is polling, and each poll
   * would then replay those logs from cold.
   *
   * A static path, so it wins over `/api/runs/:id` for this exact URL. The whole
   * walk completes before the reply, so a failure part-way is a clean error and
   * never a file that stops mid-list.
   *
   * #1534 — ONE export per owner at a time: a second while the first is walking
   * is a 429 `busy`, not queued. The row cap bounds one export; this bounds how
   * many replay their runs' logs at once. The slot is held until the walk ends,
   * even if the browser has gone, because the walk is the work being bounded.
   */
  fastify.get('/api/runs/export.csv', async (request, reply) => {
    const query = ListRunsQuerystringSchema.parse(request.query);
    const sort = resolveRunSort(query.sort, query.dir);
    // Resolved ONCE, so a relative window does not slide between pages.
    const filter = runFilterFromQuery(query, request.principal.ownerId);
    const release = exportingOwners.tryAcquire(request.principal.ownerId);
    if (!release) {
      throw new BusyError(
        'A CSV export of your runs is already running. Try again when it finishes.',
      );
    }
    let exported: Awaited<ReturnType<typeof collectRunsForExport>>;
    try {
      exported = await collectRunsForExport(
        (limit, cursor) =>
          listRunSummariesPage(
            db,
            filter,
            {
              limit,
              sort,
              // Minted by the walk's previous page under this same sort, so a
              // refusal here is a bug in the walk, not a caller's 400.
              ...(cursor === undefined ? {} : { cursor: decodeExportCursor(cursor, sort) }),
            },
            exportActivities,
          ),
        RUNS_MAX_PAGE_SIZE,
        RUNS_EXPORT_MAX_ROWS,
      );
    } finally {
      release();
    }
    const { runs: rows, truncated } = exported;
    noStore(reply);
    reply.type('text/csv; charset=utf-8');
    if (truncated) reply.header(RUNS_EXPORT_TRUNCATED_HEADER, String(RUNS_EXPORT_MAX_ROWS));
    return toCsv(
      RUNS_EXPORT_COLUMNS.map((c) => c.header),
      rows.map(runExportRow),
    );
  });

  // U26 — the annotation filter's options, scoped by `runs.owner_id` like the
  // list itself (`listRunAnnotations` has the why). A static route, so it wins
  // over `/api/runs/:id` for this exact path.
  fastify.get('/api/runs/annotations', async (request): Promise<RunAnnotationsResponse> => {
    return { items: listRunAnnotations(db, request.principal.ownerId) };
  });

  fastify.get<{ Params: { id: string } }>('/api/runs/:id', async (request) => {
    return requireOwned(getRun(db, request.params.id), request.principal, 'run', request.params.id);
  });

  /**
   * R1 — the run-detail read-model: the run PLUS the immutable version doc it is
   * bound to, resolved server-side in one call (`RunDetailSchema`).
   *
   * U11's node-state overlay folds `createEngine(doc).projectRunState(events)`,
   * which needs `nodes`/`edges`/`containers`. A `Run` carries only
   * `pipelineVersionId`, and every version route is pipeline-SCOPED, so the page
   * had no way to reach the doc at all.
   *
   * SECURITY — the ownership proof is the RUN's. This route establishes two of
   * the three links itself: a version is reachable here ONLY via a run that
   * `requireOwned` has already cleared, and `runs.pipelineVersionId` is a
   * foreign key, so the version returned is necessarily the one that run is
   * bound to. The third link — that the run's owner owns the version's PIPELINE
   * — is upheld OUTSIDE this file: a run is created only from a trigger whose
   * `pipelineVersionId` passed `requireOwnedPipelineVersion` at create time
   * (`routes/triggers.ts`) and is immutable thereafter, or by copying an owned
   * run's binding (`run/reseed.ts`). Stated rather than assumed because the
   * version row itself carries NO `ownerId` — owner scoping rides the pipeline
   * FK — and `resolveDoc` therefore applies no owner filter of its own. Which is
   * exactly why this route must never accept a version id from the caller, and
   * the second reason R1 is a run-detail read-model rather than the
   * `GET /api/pipeline-versions/:id` the ticket first sketched.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/detail', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    // `makeDocResolver` is the ONE production classifier of "gone" vs "present
    // but does not parse" (#508/#515), and the global handler already maps both
    // to a 409. Reaching it is a violated invariant either way —
    // `runs.pipelineVersionId` is `onDelete: 'restrict'` with `PRAGMA
    // foreign_keys` on, so a surviving run pins its version row — but the
    // classification is not this route's to re-derive, and a hand-rolled throw
    // got it wrong in both directions: a bare `Error` for the missing case, and
    // an escaping `ZodError` for the unparseable one, which the handler turns
    // into a 400 `validation_error` on a GET with no request body.
    const pipelineVersion = resolveDoc(run.pipelineVersionId);
    // #1392 — the names. The pipeline is the version's and the trigger is the
    // one the run was created from, so by the argument above both are the
    // run owner's already; the owner check is repeated per row anyway, because
    // a name is the one thing here that is cheap to withhold and a leak of it
    // would be silent. A name that fails it, or a row that is gone, is `null`
    // — never an id dressed as a name.
    const nameFor = (row: { ownerId: string | null; name: string } | null) =>
      row && row.ownerId === run.ownerId ? row.name : null;
    const pipelineName = nameFor(getPipeline(db, pipelineVersion.pipelineId));
    const triggerName = run.triggerId ? nameFor(getTrigger(db, run.triggerId)) : null;
    const debug = isDebugVersion(db, run.pipelineVersionId) === true;
    return { run, pipelineVersion, debug, pipelineName, triggerName } satisfies RunDetail;
  });

  /**
   * #1484 OR35 M2/M3 — the run's activity runs: one row per attempt of each
   * activity, per iteration (`run/activity-runs.ts` owns the projection).
   *
   * SECURITY — the same proof as `/detail`: the run is `requireOwned`, the version
   * is the one the run is bound to, never a caller-supplied id. Child runs are
   * read with `ownerId` AND `parentRunId` in the query, so a link to a run this
   * caller does not own is never resolved; such a child keeps only the id the
   * parent's own log records. A child's pipeline name passes the owner check per
   * row, as `/detail`'s names do.
   *
   * A version that will not resolve is a 409 through the global handler, as on
   * `/detail`. A log that will not parse is a 500: `RunLogUnparseableError` is a
   * server fault, and the page keeps its other sections.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/runs/:id/activity-runs',
    async (request): Promise<ActivityRunsResponse> => {
      const run = requireOwned(
        getRun(db, request.params.id),
        request.principal,
        'run',
        request.params.id,
      );
      const doc = resolveDoc(run.pipelineVersionId);
      const rows = projectActivityRuns(doc, buildEngine(doc), loadEngineLog(db, run.id));
      const children =
        run.ownerId === null
          ? new Map()
          : new Map(
              listRuns(db, { parentRunId: run.id, ownerId: run.ownerId }).map((r) => [r.id, r]),
            );
      const names = new Map<string, string | null>();
      const pipelineNameOf = (versionId: string): string | null => {
        if (!names.has(versionId)) {
          let name: string | null = null;
          try {
            const pipeline = getPipeline(db, resolveDoc(versionId).pipelineId);
            name = pipeline !== null && pipeline.ownerId === run.ownerId ? pipeline.name : null;
          } catch {
            // A child whose version is gone or unparseable still has a run to
            // link to; it just has no name to show.
          }
          names.set(versionId, name);
        }
        return names.get(versionId) ?? null;
      };
      return {
        runId: run.id,
        rows: rows.map((row) => {
          const child = row.childRunId === null ? undefined : children.get(row.childRunId);
          const childRun: ActivityRunChild | null =
            child === undefined
              ? null
              : {
                  id: child.id,
                  pipelineName: pipelineNameOf(child.pipelineVersionId),
                  status: child.status,
                };
          return { ...row, childRun };
        }),
      };
    },
  );

  fastify.get<{ Params: { id: string } }>('/api/runs/:id/events', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return listRunEvents(db, run.id);
  });

  /**
   * #2 L6 — the run-cost projection: SUMS the `costEstimate` stamped on this
   * run's `activity.metered` events (`computeRunCost`, the shared SSOT). Read
   * off the durable event log, deterministic, fail-closed — a genuine cost gap
   * (an unpriced MODEL, or `meteringStatus:'unknown'` usage) leaves `complete:false`
   * and its cost OUT of the total (never a manufactured 0). #2 L14: a subscription
   * `meteringStatus:'unpriced'` response is NOT a gap — it is counted separately
   * (`unpricedResponseCount`) and does NOT flip `complete`. Owner-scoped THROUGH
   * the run, exactly as `/events` is.
   *
   * #932 — SCOPE BOUNDARY, and it is not a gap this route can close. A
   * `call_pipeline` child runs under its own run id, so its `activity.metered`
   * events are in the CHILD's log; this run's log holds only `call.started` /
   * `call.returned`. This figure is therefore what THIS run spent, excluding
   * every descendant run — which `complete` does NOT report, because nothing here
   * is missing or unpriced: the child's spend is a complete answer to a different
   * question. Callers wanting the subtree walk `?parentRunId=` (the list route
   * above) and sum, bounded by `MAX_CALL_DEPTH` — and since #1083 that walk is
   * PAGED, so it means following `nextCursor` to the end, not reading one
   * response. A caller that sums a single page silently under-reports the
   * subtree the moment a parent has more children than a page holds, which is
   * precisely the shape of error this docblock exists to prevent.
   * Rolling descendants in HERE
   * would silently diverge from `aggregateRunCosts`, the bounded-SQL twin that
   * backs the run list and cannot do that walk in SQL — one surface right and one
   * wrong is worse than both honestly per-run. The run monitor renders the
   * exclusion and links the children (`RunCostSummary`).
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/cost', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return computeRunCost(listRunEvents(db, run.id));
  });

  /**
   * #497 — the reducer's EXPLANATIONS for this run: why an edge was ignored, a
   * container child neutralized, or which entities stalled it. Its DECISIONS are
   * `/events` (the durable log); these say why.
   *
   * Owner-scoped through the RUN, exactly as `/events` is: `run_diagnostics`
   * rows carry no `owner_id` of their own, so authorization is checked on the
   * resource that has one. Authentication is not authorization — `request.principal`
   * proves who is asking, `requireOwned` proves they may.
   */
  fastify.get<{ Params: { id: string } }>('/api/runs/:id/diagnostics', async (request) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    return listRunDiagnostics(db, run.id);
  });

  /**
   * #4 A13 — the OWNER-scoped retrieval of a run's pending `webhook` external-wait
   * callback URLs. Until A16 injects the URL into an outbound trigger, this is how
   * the operator/an integration obtains the callback URL to hand to the external
   * system awaiting a human/callback decision.
   *
   * Owner-scoped THROUGH the run (`requireOwned`) — authentication is not
   * authorization: `request.principal` proves who is asking, `requireOwned` proves
   * they own the run whose parked nodes' capability tokens this returns. The token
   * is RE-DERIVED here (`HMAC(masterKey, ...)`, never read from a log or the row's
   * hash), so a live bearer credential is only ever handed to the run's OWNER, on
   * demand — never persisted in plaintext, never in the raw event feed.
   *
   * #900 — the response is `satisfies PendingExternalWait[]`, so the shared schema
   * the web client parses this through is a real CONTRACT rather than a client-side
   * assertion about a shape nothing on this side is held to. `api/runs.ts` names
   * that distinction on the sibling rerun route (#899, still open) and asks each to
   * be fixed as its route is opened; this is that route's turn. Projection only —
   * the row's stored token hash and `status` deliberately do not cross the wire.
   */
  fastify.get<{ Params: { id: string } }>(
    '/api/runs/:id/external-waits',
    async (request, reply) => {
      const run = requireOwned(
        getRun(db, request.params.id),
        request.principal,
        'run',
        request.params.id,
      );
      // #925 — every `callbackPath` below embeds a live capability token.
      noStore(reply);
      return listPendingExternalWaitsByRun(db, run.id).map(
        (wait) =>
          ({
            nodeId: wait.nodeId,
            attemptId: wait.attemptId,
            expiresAt: wait.expiresAt,
            callbackPath: `/api/external-wait/${deriveExternalWaitToken(fastify.masterKey, {
              runId: wait.runId,
              nodeId: wait.nodeId,
              attemptId: wait.attemptId,
            })}`,
          }) satisfies PendingExternalWait,
      );
    },
  );

  /**
   * #901 — the OWNER completes one of their own run's parked external waits, from
   * inside the app: `POST /api/runs/:id/external-waits/complete`.
   *
   * The act the GET above only pointed at. #900 revealed the callback URL and left
   * the operator to leave the app and POST it by hand; this closes that path. It is
   * a SECOND DOOR onto the anonymous seam's settle, never a second settle: the
   * token is re-derived here (`HMAC(masterKey, …)`, exactly as the GET does) and
   * handed to the SAME `externalWaitCompleter`, so what completing a wait MEANS
   * cannot drift between the two.
   *
   * SECURITY — the two doors differ in disclosure, not in power, and each is right
   * for its caller:
   *   - AUTHZ: owner-scoped THROUGH the run (`requireOwned`), checked at the
   *     boundary before any lookup or producer work. Authentication is not
   *     authorization — `request.principal` proves who asks, `requireOwned` proves
   *     they own this run. A missing run and a run owned by someone else are the
   *     same 404.
   *   - THE TOKEN NEVER REACHES THE BROWSER. That is this route's reason to exist
   *     over the SPA calling `/api/external-wait/:token`: the capability stays
   *     server-side, so completing a wait from the app no longer requires shipping
   *     a live bearer credential through the client (and into any log, extension or
   *     screen-share that sees it). Neither the request nor the response carries a
   *     token or a `callbackPath`, and a test pins that.
   *   - DISCLOSURE: an owner is not a prober, so this route names the state —
   *     `already completed` (409), `expired` (410), a payload defect (422). The
   *     anonymous seam must keep collapsing every one of those to an identical 404;
   *     that no-oracle property protects an UNAUTHENTICATED token holder and is
   *     untouched here (`routes/external-wait.ts` states the same split).
   *
   * CAS ON `attemptId`, which is why the body carries it: a webhook that expires
   * re-parks under a NEW attempt, so addressing "the pending wait of node X" could
   * complete a different attempt than the one the operator composed a body for. The
   * lookup is the exact `(runId, nodeId, attemptId)` triple; a settled or unknown
   * row is refused rather than redirected onto its successor. Same shape #904
   * settled for a stale version write.
   *
   * `204`, NOT after the run finishes. The resumed run drives in the BACKGROUND
   * (`void drive`, the rerun route's convention two handlers down): the wait is
   * durably settled the moment the completer returns, while the run it unblocks may
   * bill LLM calls for minutes, and this server sets no `requestTimeout`. The
   * operator watches the resumption in the live run view.
   */
  fastify.post<{ Params: { id: string }; Body: CompleteExternalWaitBody }>(
    '/api/runs/:id/external-waits/complete',
    async (request, reply) => {
      const run = requireOwned(
        getRun(db, request.params.id),
        request.principal,
        'run',
        request.params.id,
      );
      const { nodeId, attemptId, payload } = CompleteExternalWaitBodySchema.parse(request.body);

      const row = getExternalWaitByAttempt(db, run.id, nodeId, attemptId);
      // An unknown triple is a 404 like any other missing resource — it names no
      // OTHER attempt's existence, so it is not the oracle the anonymous seam guards
      // against; the caller already owns the run.
      if (row === null) {
        // Named by the RUN, which `requireOwned` has resolved and owner-checked —
        // never by the caller's own `nodeId`/`attemptId`. `errors.ts` allows only
        // `invalid_pipeline_doc` to echo request input, and this is exactly the
        // branch where those two fields resolved to nothing, so echoing them would
        // reflect up to a bodyLimit of unvalidated caller text back out.
        throw new NotFoundError('external wait', run.id);
      }
      if (row.status === 'completed') {
        throw new ExternalWaitSettledError(
          `this wait was already completed (node '${nodeId}')`,
          409,
        );
      }
      if (row.status === 'expired') {
        throw new ExternalWaitSettledError(`this wait expired (node '${nodeId}')`, 410);
      }

      // Re-derived, never read from the row (which stores only a HASH) and never
      // served — the same derivation the GET performs, from the same master key.
      //
      // Which is also this door's one honest limitation, stated because it is
      // invisible from the outside: the derivation is keyed on the MASTER KEY, so a
      // key rotation orphans every in-flight wait. The re-derived token no longer
      // hashes to the stored hash, the completer finds no row, and a genuinely
      // pending wait answers "no longer completable". The anonymous seam fares
      // worse (an already-issued URL simply stops working, with no owner-visible
      // explanation at all), so this is not a regression — but rotation is not a
      // supported operation today, and if it becomes one, in-flight external waits
      // need a re-key or drain step.
      const token = deriveExternalWaitToken(fastify.masterKey, {
        runId: run.id,
        nodeId,
        attemptId,
      });
      // `Buffer.from(JSON.stringify(...))` rather than a second completer entry
      // point: the completer's `parseCallbackBody` is the ONE place a callback body
      // is normalised (a non-object collapses to `{}`), and routing through it keeps
      // both doors on that single policy. Round-tripping an already-parsed JSON
      // value through stringify/parse is identity.
      const { outcome, reason, drive } = await fastify.externalWaitCompleter.complete(
        token,
        Buffer.from(JSON.stringify(payload)),
      );

      if (outcome === 'invalid_payload') {
        // The node is still PARKED — nothing was appended — so the operator can fix
        // the body and send it again. `reason` is absent when the defect is the
        // node's own `config.outputs` rather than the payload (the completer logs
        // that server-side instead of leaking config text), hence the fallback.
        throw new ExternalWaitPayloadError(
          reason ?? 'the callback body does not match this node’s declared outputs',
        );
      }
      if (outcome === 'not_completable') {
        // STATE-NEUTRAL wording on purpose. The row was `pending` a moment ago, so
        // this is NOT simply "a race": the completer also returns it when the node
        // is no longer parked at that attempt (a back-edge reset or a new attempt),
        // when the run has already recorded a terminal fact, and when the pinned
        // pipeline version no longer resolves. Naming any one of those would be a
        // confident claim about which — the honest sentence covers the set.
        throw new ExternalWaitSettledError(
          `this wait is no longer completable — the run or the node has moved on (node '${nodeId}')`,
          409,
        );
      }
      // Fire-and-forget, like the rerun below. `driveRun` owns its own faults
      // (`terminalizeInterrupted`), so this practically never settles rejected —
      // but "practically never" is not "never": that terminalization itself writes
      // to the db outside any catch, so a DB-level fault there would escape. An
      // unhandled rejection is a process exit under Node's default, which is far
      // too sharp an edge for a discarded promise, so the discard is explicit and
      // logged rather than resting on the guarantee.
      // `drive?` because the type is `drive?: Promise<void>` — the completer sets it
      // only on `'completed'`, and both other outcomes have already thrown above, so
      // this is unreachable-by-construction rather than a real absence. Optional
      // chaining instead of a `!`: if that ever stops being true, a wait that was
      // durably settled without being driven is a run that silently stops, and the
      // honest shape for that is "no drive to discard", not a crash here.
      void drive?.catch((err: unknown) => {
        request.log.error({ err, runId: run.id }, 'external wait: resumed drive faulted');
      });
      return reply.status(204).send();
    },
  );

  /**
   * RS2 — start a RERUN-FROM-FAILED of a terminal FAILED run: a new run R2 that
   * copies R1's successful prefix (frontier) and resumes from the failure. Returns
   * `202 { runId }` with R2's id; R2 drives in the background (like a manual fire).
   *
   * Owner-scoped THROUGH the source run (`requireOwned`) — authentication is not
   * authorization: `request.principal` proves who asks, `requireOwned` proves they
   * own the run being reran. Authz is checked HERE, at the boundary, before the
   * producer runs. A non-existent OR not-owned run is the same `404` (no oracle).
   *
   * The producer's eligibility + version-resolution verdicts surface through the
   * global error handler: `RerunNotEligibleError` (no log / not terminated / it
   * succeeded / #896 — a rerun of it is already in flight) → 409,
   * `DocUnresolvableError` (the pinned version is gone) → 409.
   * R2 reuses R1's params + version EXACTLY (no override body — param override is a
   * simple-rerun concern, not rerun-from-failed).
   */
  fastify.post<{ Params: { id: string } }>(
    '/api/runs/:id/rerun-from-failed',
    async (request, reply) => {
      const run = requireOwned(
        getRun(db, request.params.id),
        request.principal,
        'run',
        request.params.id,
      );
      // `202` the moment R2 is durably created + its reseed pair committed; R2
      // drives in the BACKGROUND (like a manual fire), so a long rerun never holds
      // the request open. `drive` is intentionally not awaited (it owns its own
      // faults; a crash before it runs recovers via the boot reconciler).
      const { runId, drive } = await fastify.reseedService.rerunFromFailed(run.id);
      void drive;
      // #899 — typed by the SHARED schema the web client parses with, so the two
      // ends of this contract drift into a typecheck failure rather than a runtime
      // Zod error in the browser (the `FireResultSchema` arrangement on the sibling
      // fire route).
      return reply.status(202).send({ runId } satisfies RerunAccepted);
    },
  );

  /**
   * CX2 (#1320) — `POST /api/runs/:id/cancel`: stop a run (spec D5/D6). No body:
   * the cancel's source is set by the server, never typed by the operator, so no
   * stored-content surface is added to the log (spec D2 + Security model).
   *
   * `202` answers "requested" (or "cancelled" for a still-`queued` run, which a
   * row patch ends at once) — never "done": in-flight work stops cooperatively,
   * and a run whose last node completes first finishes `success` (D3). Repeating
   * the request is `202` and records nothing. `409 conflict` for a run that has
   * already ended, `409 log_unreadable` for a run whose log cannot be folded.
   * Another owner's run and a missing run are both `404` (`requireOwned`).
   */
  fastify.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request, reply) => {
    const run = requireOwned(
      getRun(db, request.params.id),
      request.principal,
      'run',
      request.params.id,
    );
    const verdict = fastify.runCanceller.cancel(run.id);
    switch (verdict.kind) {
      case 'accepted':
        return reply
          .status(202)
          .send({ runId: run.id, state: verdict.state } satisfies RunCancelAccepted);
      case 'terminal':
        return reply.status(409).send({
          error: 'conflict',
          message: `run '${run.id}' has already ended (${verdict.status})`,
        } satisfies ApiErrorBody);
      case 'log_unreadable':
        return reply.status(409).send({
          error: 'log_unreadable',
          message: `run '${run.id}' has an unreadable event log and cannot be cancelled; it needs repair`,
        } satisfies ApiErrorBody);
      case 'not_found':
        // The row vanished after `requireOwned` found it: the same 404, in the
        // same shape, as a run that never existed.
        throw new NotFoundError('run', run.id);
    }
  });
};
