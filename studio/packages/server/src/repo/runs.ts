import {
  and,
  asc,
  count,
  eq,
  exists,
  gte,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  computeRunCost,
  MAX_CALL_DEPTH,
  NewRunSchema,
  RUN_DESCENDANTS_MAX,
  RunLifecyclePatchSchema,
  RunSchema,
  RunSummarySchema,
  type NewRun,
  type Run,
  type RunSummary,
  type RunLifecyclePatch,
  type RunStatus,
  type RunTriggeredByKind,
  type EngineEvent,
  type Paginated,
} from '@autonomy-studio/shared';
export { RUN_DESCENDANTS_MAX } from '@autonomy-studio/shared';
import { pipelines, pipelineVersions, runEvents, runs, triggers } from '../db/schema.js';
import { newId } from './ids.js';
import {
  afterRunCursor,
  encodeRunCursor,
  RUN_SORT_DEFAULT,
  runSortOrderBy,
  runSortValuesJson,
  type RunCursor,
  type RunSort,
} from './run-sort.js';
import { isDeterministicRowCorruption } from './row-corruption.js';
import type { RunActivityFold } from '../run/activity-counts.js';
import { aggregateRunCosts, listRunLastSeqs, RUN_ID_BIND_CHUNK } from './run-events.js';
import { RUN_TRIGGERED_BY_SQL } from './run-triggered-by.js';
import type { Db } from './types.js';

/** #1484 — a listed run's parent, and that parent's version and pipeline. */
const parentRuns = alias(runs, 'parent_runs');
const parentVersions = alias(pipelineVersions, 'parent_versions');
const parentPipelines = alias(pipelines, 'parent_pipelines');

/**
 * #796 (P3b) — `id` is a SEPARATE argument rather than a field on `NewRun`, and
 * deliberately so. A `call_pipeline` child's row id must be the reducer's
 * DETERMINISTIC `childRunId` (a pure hash of parent run + call node + attempt),
 * because that identity is the whole idempotency story: a crash-replay re-emits
 * the same `startChild`, and `getRun(childRunId)` is then the crash-safe
 * "already spawned?" test — no new column, no new index, no lookup key that
 * could disagree with the one the reducer checks on `call.returned`.
 *
 * Keeping it OFF `NewRunSchema` keeps the wire shape closed: that schema is a
 * parsed input type, so an optional `id` on it would make a caller-chosen run id
 * structurally acceptable the day anything parses a request body into a
 * `NewRun`. Only in-process callers holding a derived id can pass one here.
 */
export function createRun(db: Db, input: NewRun, id?: string): Run {
  const parsed = NewRunSchema.parse(input);
  const row: Run = {
    id: id ?? newId('run'),
    ...parsed,
    leaseUntil: null,
    heartbeatAt: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  db.insert(runs).values(row).run();
  return RunSchema.parse(row);
}

export function getRun(db: Db, id: string): Run | null {
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  return row ? RunSchema.parse(row) : null;
}

export interface ListRunsFilter {
  pipelineVersionId?: string;
  triggerId?: string;
  parentRunId?: string;
  /** RS6 — the rerun-history grouping scan: "reruns of R1" (backed by
   * `runs_rerun_of_idx`). Filtered in SQL, never loaded-then-filtered. */
  rerunOf?: string;
  /** Filters in SQL, like `listConnections`/`listPipelines` — never loaded
   * then filtered in the route. */
  ownerId?: string;
  /** The boot reconciler's "find all `running` rows" scan (backed by
   * `runs_status_idx`) — filtered in SQL, never loaded-then-filtered. */
  status?: RunStatus;
  /**
   * U26 — the Monitor filter pane's time axis, as an INCLUSIVE epoch-ms lower
   * bound on `started_at` (backed by `runs_started_at_idx`). Inclusive so a
   * window computed as `now - 1h` still contains a run stamped exactly an hour
   * ago, rather than dropping the boundary run on a millisecond.
   *
   * The epoch is the primitive; the WINDOW (`?since=24h`) is the wire/UI
   * vocabulary that resolves to one, and it resolves server-side
   * (`RUN_SINCE_MS`). #1484 adds an ABSOLUTE form beside it: the day picker's
   * `?from=` lands here too, and `startedBefore` below is its upper bound.
   *
   * STATED, not discovered later: `admitQueuedRun` RE-STAMPS `started_at` when a
   * durably-queued fire is admitted, so a `queued` run enters this window when
   * it is admitted rather than when it was enqueued. That is the same fact
   * `formatRunDuration` already refuses to measure a queued row against;
   * `queued_at` is the column that records the enqueue, and it is not this axis.
   */
  startedAfter?: number;
  /**
   * #1484 OR35 M1 — the day picker's EXCLUSIVE upper bound on `started_at`
   * (`?to=`, the next day's midnight in the viewer's zone). Exclusive so two
   * adjacent days never both hold the run stamped on the midnight between them.
   * The `admitQueuedRun` re-stamp caveat above applies to it equally.
   */
  startedBefore?: number;
}

/**
 * `listRunSummaries` only. The PIPELINE axis needs the `runs ⋈ pipeline_versions`
 * hop that the summary read-model already makes — a run row carries only its
 * immutable `pipelineVersionId`, and pipeline identity lives on the version row.
 *
 * It is a SEPARATE interface rather than a field on `ListRunsFilter` for a
 * fail-closed reason: `listRuns` and `listParsedRuns` share `listRunsConditions`
 * and have no join, so a `pipelineId` there would be a narrowing they ACCEPT and
 * silently do not apply. A filter that ignores a constraint is the same shape as
 * a gate that fails open. The type system refuses it instead.
 */
export interface ListRunSummariesFilter extends ListRunsFilter {
  /** Every run of every version of this pipeline (`countActiveRunsForPipeline`'s
   * join, reused). */
  pipelineId?: string;
  /** U26 — runs whose BOUND version carries this annotation, matched exactly
   * (case-sensitive, like the version doc stores it). */
  annotation?: string;
  /**
   * #1484 OR35 M1 — runs whose `triggeredByKind` is one of these. Judged by
   * `RUN_TRIGGERED_BY_SQL` itself, in the `WHERE`, so the filter and the column
   * the grid draws are one classifier and cannot disagree about a run. An empty
   * array is not "no filter"; the route never sends one (`commaListSchema` is
   * `min(1)`), and this would match nothing.
   */
  kinds?: readonly RunTriggeredByKind[];
  /**
   * #1484 OR35 M1 — the search box: a run whose id CONTAINS the text (the grid
   * draws the id's tail, and every id begins `run_`, so a prefix match would
   * find nothing the operator can see), or whose pipeline name, trigger name,
   * failure error or finishing reason contains it case-insensitively.
   */
  search?: string;
}

/** #1484 — one page of the runs list: how many rows, in which order, and the
 * cursor (minted under that same order) to resume after. */
export interface RunPageArgs {
  limit: number;
  /** Absent means `RUN_SORT_DEFAULT`, newest first. */
  sort?: RunSort;
  cursor?: RunCursor;
  /**
   * #1484 OR35 M1 — also return `descendants`: the runs this page's runs called,
   * and so on down, that are not on the page. Not a filter — which runs MATCH,
   * and therefore the cursor, is the same either way.
   */
  includeChildren?: boolean;
}

/**
 * The event types whose text the search reads, and the payload field each keeps
 * it in. Typed against the event union so a renamed event or field is a compile
 * error here rather than a search that silently stops finding failures.
 */
const SEARCHED_EVENT_TEXT: {
  [T in 'node.failed' | 'run.finished']: keyof Extract<EngineEvent, { type: T }>;
} = {
  'node.failed': 'error',
  'run.finished': 'reason',
};

/**
 * The search predicate. `instr`, not `LIKE`: every value is a bound parameter
 * and `instr` has no wildcards, so a `%` or `_` the operator types is literal
 * text with no escaping to get wrong. `lower()` folds ASCII only, which is
 * SQLite's own limit and is stated rather than worked around: a non-ASCII name
 * matches only in the case it was typed. The run id is
 * matched AS TYPED, because ids are case-sensitive.
 *
 * The error arm is a correlated `EXISTS` over that run's events, through
 * `run_events_run_id_idx`, reading only the two event types above. Error text is
 * withheld from the log at EMIT time for a secure node (`engine.redact`), and the
 * owner can already read every event through `GET /api/runs/:id/events`, so the
 * search finds nothing the caller could not open.
 */
function runSearchCondition(text: string): SQL {
  // Folded by SQLite on BOTH sides, so needle and haystack go through one
  // `lower()` (a JS `toLowerCase()` would fold non-ASCII the column never is).
  const contains = (column: SQLWrapper) => sql`instr(lower(${column}), lower(${text})) > 0`;
  const eventText = sql.join(
    Object.entries(SEARCHED_EVENT_TEXT).map(
      ([type, field]) =>
        sql`(${runEvents.type} = ${type} and ${contains(sql`json_extract(${runEvents.payload}, ${`$.${field}`})`)})`,
    ),
    sql` or `,
  );
  const arms = [
    sql`instr(${runs.id}, ${text}) > 0`,
    contains(pipelines.name),
    contains(triggers.name),
    sql`exists (select 1 from ${runEvents} where ${runEvents.runId} = ${runs.id} and (${eventText}))`,
  ];
  return sql`(${sql.join(arms, sql` or `)})`;
}

function listRunsConditions(filter: ListRunsFilter) {
  const conditions = [];
  if (filter.pipelineVersionId !== undefined) {
    conditions.push(eq(runs.pipelineVersionId, filter.pipelineVersionId));
  }
  if (filter.triggerId !== undefined) {
    conditions.push(eq(runs.triggerId, filter.triggerId));
  }
  if (filter.parentRunId !== undefined) {
    conditions.push(eq(runs.parentRunId, filter.parentRunId));
  }
  if (filter.rerunOf !== undefined) {
    conditions.push(eq(runs.rerunOf, filter.rerunOf));
  }
  if (filter.ownerId !== undefined) {
    conditions.push(eq(runs.ownerId, filter.ownerId));
  }
  if (filter.status !== undefined) {
    conditions.push(eq(runs.status, filter.status));
  }
  if (filter.startedAfter !== undefined) {
    conditions.push(gte(runs.startedAt, filter.startedAfter));
  }
  if (filter.startedBefore !== undefined) {
    conditions.push(lt(runs.startedAt, filter.startedBefore));
  }
  return conditions;
}

/**
 * The strict, UN-joined list primitive. Since R2 moved `GET /api/runs` onto
 * `listRunSummaries`, this has no production caller left — it is kept
 * deliberately, not stranded: it is the plain-`Run` read the repo's own tests
 * assert against throughout, and the base any future caller that wants rows
 * without the name join should use. The lenient boot/sweep scans use
 * `listParsedRuns` instead, for the reason its own docblock gives.
 */
export function listRuns(db: Db, filter: ListRunsFilter = {}): Run[] {
  const conditions = listRunsConditions(filter);
  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(runs)
          .where(and(...conditions))
          .all()
      : db.select().from(runs).all();
  return rows.map((row) => RunSchema.parse(row));
}

/**
 * R2 — `listRuns` as the Monitor's list read-model: every run PLUS the human
 * names U10's columns need, in ONE query instead of an N+1 walk from the client.
 *
 * `runs ⋈ pipeline_versions` is the join `countActiveRunsForPipeline` and
 * `queuedTriggerCandidatesForPipeline` already use — a run row carries only its
 * immutable `pipelineVersionId`, and the pipeline identity lives on the version
 * row. This EXTENDS it with a second hop to `pipelines` for the name. Both hops
 * are INNER: the FKs are `restrict`/`cascade`, so a surviving run necessarily
 * pins both rows.
 *
 * The trigger hop is a LEFT JOIN, and that asymmetry is load-bearing. Two REAL
 * cases have no trigger: a rerun (`run/reseed.ts` sets `triggerId = null`
 * deliberately) and any run whose trigger was later deleted (`onDelete:
 * 'set null'`). An INNER join would drop both from the operator's own list —
 * silently, and indistinguishably from "you have no reruns". A child run will
 * join them once P3b lands the spawn seam (#796); nothing creates one yet.
 *
 * ORDER is a total, deterministic newest-first (`started_at DESC, id DESC`) by
 * default. #1484 made it sortable by column (`repo/run-sort.ts`); every sort
 * still ends in `id`, so the order stays total.
 *
 * THE TIE-BREAK MOVED FROM `rowid` TO `id` (#1083), reversing what this docblock
 * argued before, so the reason is recorded rather than the conclusion swapped.
 * The old argument was sound on its own terms: run ids are random nanoids, so a
 * millisecond tie ordered by id is stable but ARBITRARY, where `rowid` is
 * insertion order and breaks the tie chronologically. What changed is that the
 * order is now also the KEYSET, and a keyset's columns are encoded into an
 * opaque cursor the client holds and replays later.
 *
 * `rowid` cannot go in that cursor, and the disqualifying reason is not that it
 * does not fit the payload — it is that IT IS NOT STABLE. This table has a TEXT
 * primary key, so its rowid is implicit, and SQLite is free to renumber implicit
 * rowids on `VACUUM`. A cursor minted before a vacuum would then name a
 * different row afterwards, and the page walk would silently skip or repeat rows
 * with nothing to detect it. `id` is the primary key: immutable, unique, and
 * meaningful for exactly as long as the row exists.
 *
 * So the property that was lost is narrow and worth stating plainly: two runs
 * stamped in the SAME MILLISECOND now read back in random-but-stable id order
 * rather than creation order. Stability — the thing pagination actually needs,
 * since an unstable tie-break drops and duplicates rows at a page boundary — is
 * preserved exactly. `nextQueuedRunForTrigger` and `findLiveRerunOf` keep their
 * `rowid` tie-break and are NOT inconsistent with this: neither is paginated, so
 * neither mints a cursor, and inside a single query rowid is perfectly stable.
 *
 * MEASURED, not assumed: on the production path (the route always passes
 * `ownerId`) SQLite picks `runs_owner_id_idx` and sorts through a
 * `USE TEMP B-TREE FOR ORDER BY`; `runs_started_at_idx` is used only for an
 * UNFILTERED list, and even then the tie-break needs a temp b-tree for the
 * last term. That cost is accepted at U10's "client-side small-data v1" scale —
 * this is a correctness claim about the ORDER, not a performance claim about the
 * index. RE-MEASURED when U26 added the `status`/`pipelineId`/`startedAfter`
 * axes, rather than left to silently cover a query it was never taken against:
 * the plan is UNCHANGED for owner-only, owner+status, owner+startedAfter,
 * owner+pipeline and all four together — SQLite still drives on
 * `runs_owner_id_idx` with a `USE TEMP B-TREE FOR ORDER BY` (the pipeline filter
 * only re-orders the join so `pipelines` leads). MEASURED again for the
 * `annotation` axis: still `runs_owner_id_idx` + the temp b-tree, plus one
 * correlated `SCAN je EXISTS VIRTUAL TABLE` per joined version row — a scan of
 * that version's own annotations, at most `MAX_ANNOTATIONS`. MEASURED for #1484's
 * three axes: `startedBefore` and `search` keep `runs_owner_id_idx` + the temp
 * b-tree, the search adding one correlated `SEARCH run_events USING INDEX
 * run_events_run_id_idx` per owner row; `kinds` evaluates `RUN_TRIGGERED_BY_SQL`
 * in the `WHERE` as well as the select list, so its two correlated subqueries
 * run twice per owner row, and one of them is the `SCAN webhook_deliveries` the
 * select already paid for (its index is #1410). Accepted at the same scale, and
 * re-measured by OR19. MEASURED for #1484's sorts: every key keeps
 * `runs_owner_id_idx` + the temp b-tree (the default already paid for one), and
 * `triggeredBy` evaluates `RUN_TRIGGERED_BY_SQL`'s correlated subqueries again in
 * the `ORDER BY` and in each branch of the resume predicate. `listRuns` issues no
 * `ORDER BY` at all, yet the page consuming it
 * claimed rows arrived "newest-first as the server returns them" — SQLite's row
 * order is an implementation detail, so that was never a promise anything kept.
 *
 * PAGED (#1083), and the ordering scalar is MUTABLE — the one caveat this walk
 * carries. `admitQueuedRun` re-stamps `started_at` at admission (deliberately;
 * its own docblock has the argument), so unlike every other keyset list here the
 * cursor's ordering column can move under a walk in progress. The consequence is
 * bounded and one-directional, which is why it is acceptable rather than merely
 * tolerated: admission only ever moves `started_at` FORWARD, so under `DESC` an
 * admitted run moves TOWARD THE HEAD — above a cursor that has already been
 * passed. A run can therefore be MISSED by a walk that is already under way (it
 * appears on the next refresh, at the top, which is where a just-admitted run
 * belongs), and can never be DUPLICATED, and can never displace another row.
 * Nothing else writes the column: it is set once at create, and
 * `RunLifecyclePatchSchema` is `.strict()` and omits it precisely so that
 * admission stays the single exception.
 *
 * THAT ARGUMENT IS FOR THE DEFAULT SORT ONLY (#1484). Under `started` ASC an
 * admitted run moves toward the TAIL, past the cursor, and can be seen TWICE;
 * under the other sorts the key itself is mutable — a status settles, a run
 * finishes and gains a duration, a pipeline is renamed, a rerun's source is
 * deleted (`rerun_of` is SET NULL) — so a row can cross the cursor either way and
 * be missed or repeated by a walk already under way. Accepted for a monitoring
 * list: the next refresh is exact, and the browser drops a row it already holds
 * (`usePagedList`'s `keyOf`) so a repeat never renders twice.
 *
 * SECURITY — the ownership proof is the RUN's, exactly as `GET /api/runs/:id/detail`
 * documents. `ownerId` filters the RUNS table; the joined version and pipeline
 * are reachable only from a run that filter already cleared, and a run's binding
 * is established at trigger-create time under `requireOwnedPipelineVersion` and
 * is immutable thereafter, or is copied from an owned run's binding
 * (`run/reseed.ts`) — the same two creation paths the `/detail` docblock names.
 * No owner filter is applied to `pipelines` — a version row carries no `ownerId`
 * (owner scoping rides the pipeline FK), and filtering there could only ever
 * DROP one of the caller's own runs from their list.
 */
export function listRunSummariesPage(
  db: Db,
  filter: ListRunSummariesFilter,
  args: RunPageArgs,
  /** #1484 — the Activities fold (`run/activity-counts.ts`), injected so this
   * repo module does not import the engine-facing `run/` layer. Required: a
   * caller that forgot it must not get every row's activities as `null`. */
  foldActivities: RunActivityFold,
): Paginated<RunSummary> & { descendants?: RunSummary[] } {
  const conditions = listRunsConditions(filter);
  const sort = args.sort ?? RUN_SORT_DEFAULT;
  // A cursor is decoded against the sort of the request carrying it
  // (`decodeRunCursor`), so a mismatch here is a caller bug, not a client's.
  if (args.cursor && (args.cursor.sort.key !== sort.key || args.cursor.sort.dir !== sort.dir)) {
    throw new Error('listRunSummariesPage: the cursor was minted under a different sort');
  }
  // The keyset resume, ANDed with the caller's filters rather than replacing
  // them: a walk stays inside the same filtered set from the first page to the
  // last. `startedAfter` (the `since` axis) narrows the very column the walk
  // orders by, which is coherent by construction — it moves the far end of the
  // range, not the direction of travel.
  if (args.cursor) {
    const resume = afterRunCursor(args.cursor);
    if (resume) conditions.push(resume);
  }
  // U26 — the two axes that cannot live in `listRunsConditions`, because they
  // read JOINED columns: this one and `annotation` below. The pipeline axis is
  // expressed over the join this query already makes, exactly as
  // `countActiveRunsForPipeline` does, rather than as a subquery.
  if (filter.pipelineId !== undefined) {
    conditions.push(eq(pipelineVersions.pipelineId, filter.pipelineId));
  }
  // U26 — the annotation axis reads the JOINED version's `annotations` (a JSON
  // array), so the run is judged by the tags it RAN under, not the pipeline's
  // current ones. The value is a bound parameter compared by `=` on
  // `json_each`'s `value`: BINARY collation, an exact match.
  if (filter.annotation !== undefined) {
    conditions.push(
      sql`exists (select 1 from json_each(${pipelineVersions.annotations}) as je where je.value = ${filter.annotation})`,
    );
  }
  // #1484 — both read JOINED columns too: the kind CASE reads the version and
  // the trigger, and the search reads the pipeline and trigger names.
  if (filter.kinds !== undefined) {
    conditions.push(inArray(RUN_TRIGGERED_BY_SQL, [...filter.kinds]));
  }
  if (filter.search !== undefined) {
    conditions.push(runSearchCondition(filter.search));
  }
  /* #931 — the rows and their costs are read inside ONE transaction, so both come
     from a single consistent SQLite snapshot and a metered event appended between
     the two reads cannot land in a cost whose row predates it. (A nested call would
     drop to a SAVEPOINT and read the OUTER snapshot instead — still self-consistent,
     which is all this claims. There is no such caller today: `listRunSummaries` is
     reached only from `GET /api/runs`.) Read-only, so there is nothing to roll back;
     the transaction is purely for snapshot isolation, exactly as
     `aggregatePipelineCost`'s is. */
  return db.transaction((tx) => {
    const fetched = withSummaryColumns(tx, sort)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(...runSortOrderBy(sort))
      // Fetch one extra to PROBE for a next page, the `toPage` contract — so
      // `nextCursor` is set only when a real next row exists, never a false
      // "more" and never an empty trailing page.
      .limit(args.limit + 1)
      .all();
    /* `toPage` itself is not reusable here, for the same reason
       `listWorkspaceEventsPage` inlined this split: it is `<T extends CursorKey>`
       and mints the cursor from a row's `.createdAt`, while our ordering scalar
       is `startedAt` on a NESTED `row.run`. The one-extra-row split is three
       lines and direction-agnostic; a second generic helper parameterised by key
       accessor would be more machinery than the thing it abstracts. */
    const hasMore = fetched.length > args.limit;
    const rows = hasMore ? fetched.slice(0, args.limit) : fetched;
    const boundary = rows[rows.length - 1];
    const page = {
      items: toRunSummaries(tx, rows, filter.ownerId, foldActivities),
      // The boundary row's own term values, as SQL computed them for the
      // `ORDER BY`, so `afterRunCursor` resumes exactly where this page ended.
      nextCursor:
        hasMore && boundary
          ? encodeRunCursor({
              sort,
              values: JSON.parse(boundary.sortValues) as (string | number)[],
              id: boundary.run.id,
            })
          : null,
    };
    if (args.includeChildren !== true) return page;
    /* #1484 — the page's descendants, built by the SAME select and mapping as the
       page, inside the same snapshot. They are not filtered: a trigger's run
       shows everything it caused, and a child carries no trigger of its own. */
    const order = listRunDescendantIds(
      tx,
      rows.map((row) => row.run.id),
      filter.ownerId,
    );
    const below =
      order.length === 0
        ? []
        : withSummaryColumns(tx, sort)
            .where(inArray(runs.id, order))
            .all();
    const at = new Map(order.map((id, i) => [id, i]));
    below.sort((a, b) => (at.get(a.run.id) ?? 0) - (at.get(b.run.id) ?? 0));
    return { ...page, descendants: toRunSummaries(tx, below, filter.ownerId, foldActivities) };
  });
}

/**
 * The runs list's SELECT: a run plus everything its summary row names, through
 * the joins below. One builder for the page and its descendants, so a child run
 * nested under its parent reads exactly as it would on a page of its own.
 */
function withSummaryColumns(tx: Db, sort: RunSort) {
  return (
    tx
      .select({
        run: runs,
        pipelineId: pipelines.id,
        pipelineName: pipelines.name,
        pipelineVersion: pipelineVersions.version,
        debug: pipelineVersions.debug,
        annotations: pipelineVersions.annotations,
        triggerName: triggers.name,
        triggeredByKind: RUN_TRIGGERED_BY_SQL,
        parentPipelineName: parentPipelines.name,
        sortValues: runSortValuesJson(sort),
      })
      .from(runs)
      .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
      .innerJoin(pipelines, eq(pipelineVersions.pipelineId, pipelines.id))
      .leftJoin(triggers, eq(runs.triggerId, triggers.id))
      /* #1484 — the Parent column's name. LEFT joins, because most runs have no
         parent. The name is read only when the parent's PIPELINE belongs to this
         run's owner — the row the name comes from is the one checked, as
         `GET /api/runs/:id`'s names are (#1392). A child is created with its
         parent's owner, so this never drops a real name. `IS`, not `=`, so a
         row with no owner on either side compares as the route's `===` does. */
      .leftJoin(parentRuns, eq(parentRuns.id, runs.parentRunId))
      .leftJoin(parentVersions, eq(parentVersions.id, parentRuns.pipelineVersionId))
      .leftJoin(
        parentPipelines,
        and(
          eq(parentPipelines.id, parentVersions.pipelineId),
          sql`${parentPipelines.ownerId} is ${runs.ownerId}`,
        ),
      )
      .$dynamic()
  );
}

type SummaryRow = ReturnType<ReturnType<typeof withSummaryColumns>['all']>[number];

/**
 * The rows of `withSummaryColumns`, as `RunSummary`s: each with its cost, its
 * Activities and Rows-written readings and its child count, all read for THESE
 * rows only and inside the caller's transaction.
 */
function toRunSummaries(
  tx: Db,
  rows: readonly SummaryRow[],
  ownerId: string | undefined,
  foldActivities: RunActivityFold,
): RunSummary[] {
  const ids = rows.map((row) => row.run.id);
  /* Costs are aggregated for THIS PAGE's rows only. That falls out of the
     paging rather than being a separate optimisation, and it is the larger
     half of what #1083 bounds: the previous read passed every run id the owner
     had to `aggregateRunCosts`, so the metered-event aggregation grew with the
     history exactly as the response body did. */
  const costs = aggregateRunCosts(tx, ids, ownerId);
  /* #1484 — the Activities and Rows-written columns, for this page's rows only
     and inside the same snapshot. An index-only read gives each log's last seq
     (the fold's memo key); the fold then reads only the logs it has not
     already read at that seq. */
  const lastSeqs = listRunLastSeqs(tx, ids, ownerId);
  const readings = foldActivities(
    tx,
    rows.map((row) => ({
      id: row.run.id,
      pipelineVersionId: row.run.pipelineVersionId,
      lastSeq: lastSeqs.get(row.run.id),
    })),
  );
  const children = countChildRuns(tx, ids, ownerId);
  return rows.map((row) =>
    RunSummarySchema.parse({
      ...row.run,
      pipelineId: row.pipelineId,
      pipelineName: row.pipelineName,
      pipelineVersion: row.pipelineVersion,
      debug: row.debug,
      annotations: row.annotations,
      triggerName: row.triggerName,
      triggeredByKind: row.triggeredByKind,
      parentPipelineName: row.parentPipelineName,
      /* A run with no metered events has no aggregate GROUP, and its cost is a
         genuine zero — nothing was billed. `computeRunCost([])` rather than a
         hand-written zero object, so the empty value stays the FOLD's own and
         cannot fall out of step when `RunCost` grows a field. */
      cost: costs.get(row.run.id) ?? computeRunCost([]),
      activities: readings.get(row.run.id)?.activities ?? null,
      rowsWritten: readings.get(row.run.id)?.rowsWritten ?? null,
      // No GROUP for a run that called nothing — a genuine zero, as cost's is.
      childRunCount: children.get(row.run.id) ?? 0,
    }),
  );
}

/**
 * #1484 — how many runs each of `runIds` called directly (`runs_parent_run_id_idx`),
 * owner-scoped as the list is. Chunked like `aggregateRunCosts`, because a page
 * and its descendants together can pass the bind ceiling's safe margin.
 */
function countChildRuns(
  tx: Db,
  runIds: readonly string[],
  ownerId: string | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < runIds.length; i += RUN_ID_BIND_CHUNK) {
    const chunk = runIds.slice(i, i + RUN_ID_BIND_CHUNK);
    const conditions = [inArray(runs.parentRunId, chunk)];
    if (ownerId !== undefined) conditions.push(eq(runs.ownerId, ownerId));
    const rows = tx
      .select({ parentRunId: runs.parentRunId, n: count() })
      .from(runs)
      .where(and(...conditions))
      .groupBy(runs.parentRunId)
      .all();
    for (const row of rows) {
      if (row.parentRunId !== null) counts.set(row.parentRunId, row.n);
    }
  }
  return counts;
}

/**
 * #1484 OR35 M1 — the ids of every run below `pageIds` in the call tree, that is
 * not itself on the page: shallowest first (then oldest), and at most
 * `RUN_DESCENDANTS_MAX` of them.
 *
 * One `WITH RECURSIVE` over `parent_run_id` (indexed), seeded with the page.
 * - The step never re-enters a page run. A run has one parent, so without that a
 *   page run that is also another page run's child would be walked twice, its
 *   whole subtree with it; with it, every run below the page is reached once.
 * - `ORDER BY depth` makes the walk breadth-first, and its `LIMIT` caps the rows
 *   the walk ever ADDS (SQLite's documented recursive-CTE semantics), so a
 *   fan-out of thousands stops at the cap rather than being read and then cut.
 *   The seeds count towards that limit, hence `+ pageIds.length`.
 * - Depth stops at `MAX_CALL_DEPTH` below a seed: no chain is taller, and it
 *   bounds the walk even over a hand-made cycle.
 * - Every step is owner-scoped as the page is, so a parent link can never lead
 *   into another owner's runs.
 * Every id is a bound parameter; a page is at most `RUNS_MAX_PAGE_SIZE` (200)
 * runs, so the two lists stay far under `RUN_ID_BIND_CHUNK`.
 */
function listRunDescendantIds(
  tx: Db,
  pageIds: readonly string[],
  ownerId: string | undefined,
): string[] {
  if (pageIds.length === 0) return [];
  const seeds = sql.join(
    pageIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const owner = ownerId === undefined ? sql`` : sql` and r.owner_id = ${ownerId}`;
  const rows = tx.all<{ id: string }>(sql`
    with recursive walk(id, depth, started_at) as (
      select id, 0, started_at from runs where id in (${seeds})
      union all
      select r.id, walk.depth + 1, r.started_at
        from runs r join walk on r.parent_run_id = walk.id
        where walk.depth < ${MAX_CALL_DEPTH} and r.id not in (${seeds})${owner}
        order by 2, 3
        limit ${RUN_DESCENDANTS_MAX + pageIds.length}
    )
    select id from walk where depth > 0 order by depth, started_at, id
  `);
  return rows.slice(0, RUN_DESCENDANTS_MAX).map((row) => row.id);
}

/**
 * #646 — `listRuns`, but RESILIENT per row (the `listParsedTriggers`
 * discipline): a corrupt/legacy/hand-edited row is skipped (and reported via
 * `onSkip`) instead of throwing out the whole list. The boot reconciler, the
 * queued-run recovery and the S7 lease sweep use this because their scans sit
 * ABOVE any per-run fault boundary — one poison `running`/`queued` row
 * otherwise aborts SERVER BOOT (`reconcileOnBoot`/`recoverQueued` are awaited
 * unguarded in `index.ts`) or silences the lease heartbeat for every live run.
 * (`listRuns` stays strict: a route surfacing a poison row as a 500 is right
 * there.)
 *
 * Two phases for the same empirically-verified reason as
 * `listParsedDueWakeups`: drizzle's `{mode:'json'}` codec (`params`,
 * `trigger_context`) throws out of `.all()` itself on one invalid-JSON cell, so
 * per-row leniency needs a codec-free id-only projection first, then a strict
 * per-id read whose failure is scoped to its own row. Only DETERMINISTIC
 * corruption (`ZodError`/`SyntaxError` — the #515 classification) is skipped;
 * any other throw is a genuine DB fault and propagates. A row deleted between
 * the phases is silently skipped.
 */
export function listParsedRuns(
  db: Db,
  filter: ListRunsFilter = {},
  onSkip?: (id: string, err: unknown) => void,
): Run[] {
  const conditions = listRunsConditions(filter);
  const ids = (
    conditions.length > 0
      ? db
          .select({ id: runs.id })
          .from(runs)
          .where(and(...conditions))
          .all()
      : db.select({ id: runs.id }).from(runs).all()
  ).map((row) => row.id);

  const parsed: Run[] = [];
  for (const id of ids) {
    try {
      const row = getRun(db, id);
      if (row !== null) parsed.push(row);
    } catch (err) {
      if (isDeterministicRowCorruption(err)) onSkip?.(id, err);
      else throw err;
    }
  }
  return parsed;
}

/**
 * `getRun`, but with `listParsedRuns`'s per-row leniency — the SINGLE-ROW twin,
 * for a reader that knows the one id it wants and so has no list to scan.
 *
 * Same contract as the scan, deliberately: a row whose stored state is
 * deterministically corrupt is reported via `onSkip` and returns `null`; a
 * genuine DB fault PROPAGATES. Callers that read a row outside a lenient scan
 * (the boot reconciler's orphan sweep reads a `pending` child's PARENT, which no
 * scan parsed) would otherwise hand-roll this classification, and a policy
 * hand-rolled per call site is a policy that drifts.
 *
 * `null` covers both "absent" and "corrupt" because every caller so far treats
 * them the same way — there is no row to act on. `onSkip` is what distinguishes
 * them, for a caller that must report the corruption rather than just skip it.
 *
 * So a caller that would CREATE or OVERWRITE on `null` must pass `onSkip` and
 * treat a report as "do not touch this id": to that caller the two outcomes are
 * NOT the same, and silently rebuilding state over a row that merely needs
 * repair is how a corrupt row becomes a lost one.
 */
export function getParsedRun(
  db: Db,
  id: string,
  onSkip?: (id: string, err: unknown) => void,
): Run | null {
  try {
    return getRun(db, id);
  } catch (err) {
    if (!isDeterministicRowCorruption(err)) throw err;
    onSkip?.(id, err);
    return null;
  }
}

/**
 * Mutates ONLY run-lifecycle fields (`status`, `leaseUntil`, `heartbeatAt`,
 * `finishedAt`) — the fields the executor/boot-reconciler update as a run
 * progresses. The immutable-binding + provenance fields (`params`,
 * `pipelineVersionId`, `triggerId`, `parentRunId`, `startedAt`) are not part
 * of `RunLifecyclePatch`'s type, so a caller touching one is a compile-time
 * error; `RunLifecyclePatchSchema.parse` (`.strict()`) is the matching
 * runtime guard for a caller that bypasses the type (`as any`/`as never`).
 */
export function updateRun(db: Db, id: string, patch: RunLifecyclePatch): Run | null {
  const parsedPatch = RunLifecyclePatchSchema.parse(patch);
  const existing = getRun(db, id);
  if (!existing) return null;
  const updated = RunSchema.parse({ ...existing, ...parsedPatch, id: existing.id });
  db.update(runs).set(updated).where(eq(runs.id, id)).run();
  return updated;
}

/**
 * Statuses that OCCUPY a concurrency slot for their trigger — the admission
 * count. Terminal = `success`/`failure`/`skipped`/`interrupted`. (`skipped` is
 * terminal; the concurrency gate never CREATES a skipped run row, but a
 * node-driven skip that terminalizes a whole run must still free the slot.)
 *
 * #5 S4 — a `waiting` (parked) run RELEASES its slot: per the Codex-hardened spec
 * (line 132-134) a run parked on a timer/webhook/dependency for hours "must not
 * occupy a worker or a slot", and "resumption is event-driven". So `waiting` is
 * NOT here — parking frees the trigger's slot, and a resuming run rejoins
 * `running` directly. This is the split #5 S3 deferred: the execution LEASE
 * (`syncRunLifecycle` projects `leaseUntil` from status — held while `running`,
 * released on park) is now distinct from the lifecycle status.
 *
 * CONSEQUENCE (intended, spec-sanctioned): a parked run no longer blocks a new
 * fire, so a `skip_if_running` trigger with a long-parked run WILL fire again,
 * and a resumed run can transiently exceed `parallel`'s `max`. Bounding this with
 * a `waiting_concurrency` re-admission gate on resume is a LATER #5 S6 slice, not
 * S6a's — the "by default" in the spec is exactly that opt-in. (S6a made the
 * QUEUE durable; the resume-readmission gate rides the same substrate next.)
 *
 * `queued` (#5 S6a — a fire held in the durable admission queue, a real `runs`
 * row now) stays OUT of this set: pre-admission ≠ occupying a slot, so a queued
 * row must not count against its trigger's admission gate. `countQueuedRunsForTrigger`
 * is the SEPARATE queue-depth count.
 */
const ACTIVE_RUN_STATUSES = ['pending', 'running'] as const satisfies readonly RunStatus[];

/**
 * #896 — every run status that has NOT finished. Deliberately WIDER than
 * `ACTIVE_RUN_STATUSES` above, and the difference is the whole point of it
 * existing separately rather than reusing the neighbour:
 *
 * - `waiting` — a PARKED run does not occupy a trigger's concurrency slot (that
 *   is exactly why `ACTIVE_RUN_STATUSES` excludes it), but it has not finished
 *   and its remaining nodes have not been billed yet. For a duplicate-work guard
 *   it is unambiguously live.
 * - `queued` — pre-admission, so it likewise must not count against a trigger's
 *   slot. It is unreachable for a rerun today (a rerun drives immediately and
 *   never passes through the launcher's admission queue), and is listed for
 *   completeness of the partition rather than because it is expected.
 *
 * `pending` is defensive in the same way and for a different reason: the reseed
 * producer syncs R2's row to its folded status INSIDE the creating transaction,
 * precisely so a durable `pending` row with a log cannot exist. Both are listed
 * because this set's contract is "has not finished", not "is expected here".
 *
 * Written out rather than derived from `TERMINAL_RUN_STATUS`, because that
 * derivation is subtly wrong: `TERMINAL_RUN_STATUS` is a set of
 * `RunLifecycleStatus`, which contains neither `queued` nor `skipped`, so
 * `!TERMINAL_RUN_STATUS.has(s)` answers `false` for the terminal `skipped` and
 * would quietly admit it here. The partition test in `__tests__/runs.test.ts`
 * is what actually catches a newly-added `RunStatus`.
 */
export const LIVE_RUN_STATUSES = [
  'pending',
  'queued',
  'running',
  'waiting',
] as const satisfies readonly RunStatus[];

/**
 * #896 — the rerun of `sourceRunId` that has not finished, if there is one.
 *
 * The double-spend guard behind `POST /api/runs/:id/rerun-from-failed`. A rerun
 * re-executes every node from the failure onward, so a second one of the same
 * source run is a second bill for work already in progress. The client's own
 * in-flight flag cannot carry this: it is component state on a page keyed by run
 * id, so a navigate-away-and-back mid-flight resets it (and a second tab, or a
 * bare `curl`, never had it at all).
 *
 * Returns the id AND status so the refusal can say which run and what it is
 * doing — with no cancel control in the UI, that is the operator's only handle on
 * it. Backed by `runs_rerun_of_idx`; ordered oldest-first so the answer (and any
 * test asserting it) is stable when a pre-guard database holds several. The
 * tie-break is `rowid`, not `id`:
 * `startedAt` is a millisecond stamp that several rows can share, and `id` is a
 * random nanoid, so an id tie-break is stable but ARBITRARY — it would pick a
 * different one of two same-millisecond reruns on a different insert order.
 *
 * That is the OPPOSITE choice from `listRunSummariesPage`, which moved to `id`
 * in #1083, and the two are consistent rather than in tension — the difference
 * is paging, not taste. This query is not paginated: it mints no cursor, so its
 * ordering never leaves the statement, and within one statement `rowid` is
 * perfectly stable and genuinely chronological. A cursor by contrast is a
 * durable handle a client replays later, and an implicit rowid can be renumbered
 * by `VACUUM` in between. Chronology wins where it is free; stability wins where
 * the key has to survive the round trip.
 */
export function findLiveRerunOf(
  db: Db,
  sourceRunId: string,
): { id: string; status: RunStatus } | null {
  const row = db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.rerunOf, sourceRunId), inArray(runs.status, [...LIVE_RUN_STATUSES])))
    .orderBy(asc(runs.startedAt), asc(sql`rowid`))
    .get();
  return row ?? null;
}

/**
 * Count a trigger's currently-active (non-terminal) runs — the P4 concurrency
 * gate's authoritative, restart-safe source of truth. A run row is durable
 * from creation and survives a process restart (to be resumed by the boot
 * reconciler), whereas an in-memory counter does not; basing admission on the
 * DB keeps the gate correct across a crash mid-run. Filtered in SQL, backed by
 * `runs_status_idx` + the trigger filter.
 */
export function countActiveRunsForTrigger(db: Db, triggerId: string): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.triggerId, triggerId), inArray(runs.status, [...ACTIVE_RUN_STATUSES])))
    .get();
  return row?.n ?? 0;
}

/**
 * #5 S6a — the DURABLE admission queue. A `queue`-policy fire that overflows the
 * trigger's single slot becomes a `runs` row with `status = 'queued'` and a
 * `queued_at` FIFO key, replacing the launcher's old in-memory FIFO (which a
 * crash silently dropped). `count`/`next` back the launcher's enqueue-bound and
 * drain; `admit` promotes the drained row.
 */

/** How many fires are currently held in the durable queue for `triggerId` (the
 * launcher's `maxQueueDepth` bound is checked against this — restart-safe, unlike
 * the old in-memory array length). `queued` is deliberately NOT in
 * `ACTIVE_RUN_STATUSES` (pre-admission ≠ a slot), so this is a SEPARATE count. */
export function countQueuedRunsForTrigger(db: Db, triggerId: string): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.triggerId, triggerId), eq(runs.status, 'queued')))
    .get();
  return row?.n ?? 0;
}

/**
 * The oldest queued fire for `triggerId` — the next to admit — or `null` if the
 * queue is empty. STRICT arrival FIFO: `queued_at` (ms) then `rowid` as the
 * tie-breaker for two fires enqueued in the SAME millisecond. `rowid` is SQLite's
 * monotonic-with-INSERT key, so it reproduces the exact enqueue order the old
 * in-memory array gave — `id` (a random nanoid) could NOT, it would order a
 * same-ms burst arbitrarily. Deterministic and stable across replays/restarts.
 * The queue is bounded (`maxQueueDepth`) and per-trigger, so the unindexed
 * `ORDER BY` scans a small set — no dedicated index in this slice.
 *
 * #5 S6b — `pipelineId` (optional) PIPELINE-scopes the pick: a queued row
 * freezes the version it enqueued under while the trigger's binding is
 * mutable, so one trigger can hold queued rows on TWO pipelines (rebound
 * mid-queue). A pipeline drain must admit only rows belonging to the drained
 * pipeline — the trigger-global oldest could be a FOREIGN-pipeline row that
 * never passed that pipeline's gate.
 */
export function nextQueuedRunForTrigger(
  db: Db,
  triggerId: string,
  pipelineId?: string,
  /** #646 — invoked for each corrupt row SKIPPED on the way to the head. */
  onSkip?: (id: string, err: unknown) => void,
): Run | null {
  const base = and(eq(runs.triggerId, triggerId), eq(runs.status, 'queued'));
  // #646 — LENIENT per row, like `listParsedRuns` and for the same empirically-
  // verified reason: the old strict `.get()` mapped the FIFO head through the
  // json codec, so a corrupt head row threw `SyntaxError` out of every drain —
  // including `recoverQueued`'s unguarded boot drain, re-opening the exact
  // boot-abort this sweep closes, one hop deeper. Phase 1 is a codec-free
  // id-only pick in queue order (no `limit(1)`: the head might be the corrupt
  // row being skipped); phase 2 walks the ids to the first HEALTHY row. A
  // corrupt row is skipped (reported via `onSkip`), NOT admitted and NOT
  // permitted to block the queue behind it: it can never be admitted anyway (no
  // reader can construct it), so blocking on it would starve the trigger's
  // healthy fires behind an unserviceable head, forever.
  const ids = (
    pipelineId === undefined
      ? db
          .select({ id: runs.id })
          .from(runs)
          .where(base)
          .orderBy(asc(runs.queuedAt), asc(sql`rowid`))
          .all()
      : db
          .select({ id: runs.id })
          .from(runs)
          .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
          .where(and(base, eq(pipelineVersions.pipelineId, pipelineId)))
          // Same rowid tie-break as the unscoped branch — qualified, since the
          // join makes a bare `rowid` ambiguous.
          .orderBy(asc(runs.queuedAt), asc(sql`${runs}.rowid`))
          .all()
  ).map((row) => row.id);

  for (const id of ids) {
    try {
      const row = getRun(db, id);
      // Deleted or admitted between the phases: no longer a queued candidate.
      if (row === null || row.status !== 'queued') continue;
      return row;
    } catch (err) {
      if (isDeterministicRowCorruption(err)) onSkip?.(id, err);
      else throw err;
    }
  }
  return null;
}

/**
 * Admit a queued run: flip `queued → pending` and RE-STAMP `started_at` to now
 * (admission time — `run.started.startedAt` reads the row, so `${run.startedAt}`
 * must reflect when the run was admitted, not when it was enqueued; driver.ts's
 * `startRun` comment anticipates exactly this). `queued_at` and `trigger_context`
 * are preserved (the queued-at record + the frozen fire-time context the drive
 * still needs). Returns the admitted run, or `null` if the row is missing or was
 * already admitted by a concurrent drain — the `status = 'queued'` guard in the
 * UPDATE makes the promotion idempotent (a second drain flips nothing).
 *
 * This is a PURPOSE-BUILT write, deliberately NOT `updateRun`: re-stamping
 * `started_at` is a provenance rewrite that `RunLifecyclePatchSchema` (`.strict()`,
 * no `startedAt`) forbids by design. Admission is the one sanctioned exception,
 * so it gets its own function rather than a hole in the lifecycle-patch guard.
 */
export function admitQueuedRun(db: Db, id: string): Run | null {
  const startedAt = Date.now();
  const result = db
    .update(runs)
    .set({ status: 'pending', startedAt })
    .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
    .run();
  if (result.changes === 0) return null;
  return getRun(db, id);
}

/**
 * CX2 (#1320, spec D5) — cancel a run that is still `queued`. A queued run is a
 * ROW-ONLY status: admission has not let it start, so it has no event log and no
 * drive, and there is nothing to fold a cancel onto. It is therefore cancelled by
 * a row patch, the way `sweepPendingRuns` patches a run with no event-sourced
 * lifecycle to preserve.
 *
 * The `status = 'queued'` guard is the whole race story: admission flips the same
 * row with the same guard (`admitQueuedRun`), so exactly one of the two wins. A
 * `false` here means admission got there first and the run now has (or is about
 * to have) a log, so the caller must cancel it the event-sourced way instead. And
 * a row this patched can never be admitted afterwards, because admission only
 * selects and flips `queued` rows.
 *
 * It is the ONLY writer that leaves a `cancelled` row with no event log, and
 * `queuedTriggerCandidatesForPipeline` relies on that to keep such a row off a
 * trigger's service record (#1326). A second row-only terminal writer must be
 * accounted for there too.
 */
export function cancelQueuedRun(db: Db, id: string): boolean {
  const result = db
    .update(runs)
    .set({ status: 'cancelled', finishedAt: Date.now() })
    .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
    .run();
  return result.changes > 0;
}

/**
 * U26 — the annotation filter's options: every distinct annotation on a version
 * that one of `ownerId`'s runs is bound to, sorted for display.
 *
 * Drawn from RUNS, not from every saved version, on purpose. Every Save mints an
 * immutable version, so "all versions" would offer every tag ever typed and
 * never lose one, most of them matching nothing. Keyed on `runs.owner_id`, the
 * same column the list itself is scoped by, so an option is exactly a value the
 * caller's list can match — and the owner proof is the run's, as it is there.
 *
 * Exact strings, NOT case-folded: the filter is an exact match, so `Finance` and
 * `finance` (legal together across versions) are two options, each matching its
 * own runs. Not paginated: it is a vocabulary of distinct authored tags, not a
 * list of rows.
 */
export function listRunAnnotations(db: Db, ownerId: string): string[] {
  const rows = db.all<{ value: string }>(
    sql`select distinct je.value as value
        from ${pipelineVersions}, json_each(${pipelineVersions.annotations}) as je
        where ${pipelineVersions.id} in (
          select ${runs.pipelineVersionId} from ${runs} where ${runs.ownerId} = ${ownerId}
        )`,
  );
  return rows.map((r) => r.value).sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * #5 S6b — count the PIPELINE's currently-active runs across ALL its versions
 * and triggers (including a trigger-less `call_pipeline` child bound to one of
 * its versions): the per-pipeline half of both-must-pass admission. Same
 * `ACTIVE_RUN_STATUSES` definition as the per-trigger gate — `queued` is
 * pre-admission and `waiting` released its slot, so neither occupies pipeline
 * capacity. SQL-filtered via the runs ⋈ pipeline_versions join (a run row
 * carries only its immutable `pipelineVersionId`; the version row carries the
 * pipeline identity).
 */
export function countActiveRunsForPipeline(db: Db, pipelineId: string): number {
  const row = db
    .select({ n: count() })
    .from(runs)
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(
      and(
        eq(pipelineVersions.pipelineId, pipelineId),
        inArray(runs.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/** One trigger's standing in the pipeline's admission queue (#5 S6b). */
export interface QueuedTriggerCandidate {
  triggerId: string;
  /** The trigger's oldest waiting fire (its next-to-admit, FIFO within the trigger). */
  oldestQueuedAt: number;
  /** When the trigger was last SERVED — MAX(started_at) over its non-queued
   * runs (`admitQueuedRun`/`createRun` stamp admission time), less any run
   * cancelled before admission (#1326). `null` = never. */
  lastAdmittedAt: number | null;
}

/**
 * #5 S6b — the pipeline's queued triggers in FAIR service order:
 * least-recently-ADMITTED first (never-served first), then oldest `queuedAt`,
 * then `triggerId` (a total, deterministic order). This is the durable
 * round-robin the spec's "per-trigger round-robin (no monopoly)" requires,
 * derived entirely from persisted run rows — `started_at` is (re-)stamped at
 * every admission, so MAX(started_at) over a trigger's non-queued runs IS its
 * durable service record; no in-memory rotation pointer, restart-safe. A
 * trigger that bursts 100 old fires cannot monopolize a single-slot pipeline:
 * once served, it becomes the MOST-recently-admitted and rotates behind the
 * others. (Caveat, accepted: deleting run history — `deleteRun`, a future
 * retention sweep — erases the service record, resetting a trigger to
 * "never served"; fairness degrades gracefully, never deadlocks.)
 *
 * Within a trigger the queue order stays strict durable-`queuedAt` FIFO
 * (`nextQueuedRunForTrigger`).
 */
export function queuedTriggerCandidatesForPipeline(
  db: Db,
  pipelineId: string,
): QueuedTriggerCandidate[] {
  // Grouped queued rows for this pipeline (runs ⋈ versions), per trigger.
  const queuedGroups = db
    .select({
      triggerId: runs.triggerId,
      oldestQueuedAt: sql<number>`min(${runs.queuedAt})`,
    })
    .from(runs)
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(and(eq(pipelineVersions.pipelineId, pipelineId), eq(runs.status, 'queued')))
    .groupBy(runs.triggerId)
    .all();

  const triggerIds = queuedGroups.map((g) => g.triggerId).filter((id): id is string => id !== null);
  if (triggerIds.length === 0) return [];

  // Service record per trigger: MAX(started_at) over its NON-queued rows (a
  // queued row's started_at is an enqueue-time placeholder, not a service).
  // #1326 — nor is a row CX2 cancelled while still queued (`cancelQueuedRun`):
  // it keeps that placeholder under a terminal status. It is told apart by
  // having no event log, since a queued run is row-only and admission is what
  // gives a run its log. The probe runs only for `cancelled` rows, on the
  // `run_events_run_id_idx` index.
  // PIPELINE-scoped like everything else here: a trigger rebound from another
  // pipeline must rank by its service within THIS pipeline, not drag its old
  // pipeline's history into the fairness order.
  const served = db
    .select({
      triggerId: runs.triggerId,
      lastAdmittedAt: sql<number>`max(${runs.startedAt})`,
    })
    .from(runs)
    .innerJoin(pipelineVersions, eq(runs.pipelineVersionId, pipelineVersions.id))
    .where(
      and(
        eq(pipelineVersions.pipelineId, pipelineId),
        inArray(runs.triggerId, triggerIds),
        sql`${runs.status} != 'queued'`,
        or(
          ne(runs.status, 'cancelled'),
          exists(
            db
              .select({ one: sql`1` })
              .from(runEvents)
              .where(eq(runEvents.runId, runs.id)),
          ),
        ),
      ),
    )
    .groupBy(runs.triggerId)
    .all();
  const lastAdmitted = new Map(served.map((s) => [s.triggerId, s.lastAdmittedAt]));

  return queuedGroups
    .filter((g): g is typeof g & { triggerId: string } => g.triggerId !== null)
    .map((g) => ({
      triggerId: g.triggerId,
      oldestQueuedAt: g.oldestQueuedAt,
      lastAdmittedAt: lastAdmitted.get(g.triggerId) ?? null,
    }))
    .sort((a, b) => {
      const aServed = a.lastAdmittedAt ?? -Infinity;
      const bServed = b.lastAdmittedAt ?? -Infinity;
      if (aServed !== bServed) return aServed - bServed;
      if (a.oldestQueuedAt !== b.oldestQueuedAt) return a.oldestQueuedAt - b.oldestQueuedAt;
      return a.triggerId < b.triggerId ? -1 : a.triggerId > b.triggerId ? 1 : 0;
    });
}

export function deleteRun(db: Db, id: string): boolean {
  const result = db.delete(runs).where(eq(runs.id, id)).run();
  return result.changes > 0;
}
