import type {
  EngineEvent,
  PipelineVersion,
  RunActivityCounts,
  RunState,
} from '@autonomy-studio/shared';
import type { Db } from '../repo/types.js';
import {
  buildEngine,
  DocUnparseableError,
  DocUnresolvableError,
  type DocResolver,
} from './driver.js';
import { loadEngineEvents, RunLogUnparseableError } from './events.js';

/**
 * #1484 OR35 M1 — the runs list's Activities column, as a read model over the
 * ENGINE's own fold.
 *
 * Node status (`success`/`failure`/`skipped`) exists only in reducer state: no
 * event records a skip, so a SQL count over `run_events` cannot produce one. The
 * honest source is the one the driver and the run page already use,
 * `buildEngine(version).projectRunState(events)`, and this module is that call
 * plus a count. When M3 lands a `node.skipped` event the count could move to SQL.
 *
 * WHAT IS COUNTED, stated once because several shapes make it a choice:
 * - The version's nodes and containers, each once, read from the DOC rather
 *   than from state keys — so a parallel ForEach's transient instance keys
 *   (`w@1`) are never counted as activities of their own.
 * - A body node inside a loop counts by its LAST round's status, because the
 *   reducer resets bodies each round. Per-iteration rows are M2/M3's
 *   activity-runs read model, not this column.
 * - A PARALLEL ForEach's body nodes are absent from state (`seedState` skips
 *   them), so they are not counted; the ForEach itself is.
 * - What a rerun-from-failed carried over (`run.reseeded`) is `reused`, whatever
 *   its status here: the frontier folds to `success`, but a copied container's
 *   body stays `pending` (the fold copies the container as one terminal unit and
 *   never re-runs its body). Neither ran in THIS run, which is also why Rows
 *   written leaves them out. The web's own reading of the same event is
 *   `pages/runs/runSummary.ts`.
 *
 * `null` when the fold seeded no node at all — no `run.started` yet, or one the
 * reducer refused — because every count would then be a manufactured zero.
 */
export function activityCountsFromState(
  doc: Pick<PipelineVersion, 'nodes' | 'containers'>,
  events: readonly EngineEvent[],
  state: RunState,
): RunActivityCounts | null {
  if (Object.keys(state.nodes).length === 0 && Object.keys(state.containers).length === 0) {
    return null;
  }
  const reused = reusedIds(doc, events);
  const counts = { succeeded: 0, failed: 0, skipped: 0, reused: 0, unfinished: 0 };
  const tally = (id: string, status: string | undefined) => {
    if (status === undefined) return;
    if (reused.has(id)) counts.reused += 1;
    else if (status === 'success') counts.succeeded += 1;
    else if (status === 'failure') counts.failed += 1;
    else if (status === 'skipped') counts.skipped += 1;
    else counts.unfinished += 1;
  };
  for (const node of doc.nodes) tally(node.id, state.nodes[node.id]?.status);
  for (const container of doc.containers) {
    tally(container.id, state.containers[container.id]?.status);
  }
  return counts;
}

/**
 * The ids a rerun-from-failed carried over: its frontier, its copied containers,
 * and everything inside those containers. The LAST `run.reseeded` wins, matching
 * the fold.
 */
function reusedIds(
  doc: Pick<PipelineVersion, 'containers'>,
  events: readonly EngineEvent[],
): Set<string> {
  let reseeded: Extract<EngineEvent, { type: 'run.reseeded' }> | undefined;
  for (const e of events) if (e.type === 'run.reseeded') reseeded = e;
  if (reseeded === undefined) return new Set();
  const ids = new Set(reseeded.frontier);
  const children = new Map(doc.containers.map((c) => [c.id, c.children]));
  const pending = Object.keys(reseeded.copiedContainers);
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (ids.has(id)) continue;
    ids.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return ids;
}

/**
 * #1484 — `RunSummary.rowsWritten`: the `outputs.rowsWritten` of every
 * `node.succeeded` in this run's log, summed.
 *
 * - EVERY success, not the reducer's latest output per node: a ForEach copy
 *   succeeds once per item, and a late success the reducer ignores as stale still
 *   committed its rows.
 * - Once per attempt: a success redelivered for the same `attemptId` is the same
 *   rows, so it is not counted twice.
 * - Successes only. On a failed copy the figure is a rolled-back 0 or an
 *   uncommitted running total (`connectors/copy.ts`), and a child pipeline's
 *   outputs come back on `call.returned` — the child's rows are on its own row.
 * - Only a non-negative safe integer counts, and the sum is capped at
 *   `Number.MAX_SAFE_INTEGER`, so one odd payload cannot fail the list's parse.
 *
 * `null` when no success reported the figure; `0` is a copy that wrote nothing.
 */
export function rowsWrittenFromLog(events: readonly EngineEvent[]): number | null {
  const seen = new Set<string>();
  let total: number | null = null;
  for (const e of events) {
    if (e.type !== 'node.succeeded' || seen.has(e.attemptId)) continue;
    const rows = e.outputs.rowsWritten;
    if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0) continue;
    seen.add(e.attemptId);
    total = Math.min((total ?? 0) + rows, Number.MAX_SAFE_INTEGER);
  }
  return total;
}

/** What the runs list reads off one run's log. */
export interface RunLogReading {
  readonly activities: RunActivityCounts | null;
  readonly rowsWritten: number | null;
}

/** A page row as the fold needs it; `lastSeq` is `undefined` for an empty log. */
export interface RunActivityFoldRow {
  readonly id: string;
  readonly pipelineVersionId: string;
  readonly lastSeq: number | undefined;
}

/**
 * Reads a page of runs. `db` is the caller's read transaction, so the events
 * come from the same snapshot as the rows; versions are immutable, so reading
 * them through `resolveDoc` outside it changes nothing.
 */
export type RunActivityFold = (
  db: Db,
  rows: readonly RunActivityFoldRow[],
) => Map<string, RunLogReading>;

/**
 * How many runs one app remembers. A finished run's log never grows, so it is
 * read once and then served from here; the bound only keeps a long-lived server
 * from holding every run it has ever listed.
 */
export const ACTIVITY_FOLD_MEMO_LIMIT = 2000;

export interface RunActivityFoldOptions {
  /** Defaults to `ACTIVITY_FOLD_MEMO_LIMIT`. */
  readonly memoLimit?: number;
  /**
   * Told when a run cannot be read because something is CORRUPT: its log or its
   * version does not parse, or the fold throws. The row then shows `null`, and
   * this is what keeps that from being a silent em-dash. A version that is
   * simply gone is not reported: that is a state, not a fault.
   */
  readonly onUnreadable?: (runId: string, err: unknown) => void;
}

const EMPTY: RunLogReading = { activities: null, rowsWritten: null };

/**
 * The fold the runs route hands `listRunSummariesPage`. Memoised per run on its
 * `lastSeq`: the log is append-only and `seq` strictly grows, so an unchanged
 * `lastSeq` is an unchanged log. A live run is re-read whenever it has grown and
 * overwrites its own entry; a settled one is read once. In-process only: a
 * restart (which is also how a reducer change ships) starts empty.
 *
 * Per row, `null` counts when there is nothing honest to count:
 * - an empty log, or a fold that seeded no node (`activityCountsFromState`);
 * - the bound version is gone or does not parse;
 * - the log does not parse (rows written is `null` too);
 * - the fold itself throws. The reducer is pure, so that is this log meeting
 *   this reducer.
 * Every cause but a missing version or an empty log is reported through
 * `onUnreadable`, so corruption or a reducer regression is not silent.
 * A transient DB read error propagates, as every other read on this route does.
 */
export function makeRunActivityFold(
  resolveDoc: DocResolver,
  options: RunActivityFoldOptions = {},
): RunActivityFold {
  const limit = options.memoLimit ?? ACTIVITY_FOLD_MEMO_LIMIT;
  const memo = new Map<string, { lastSeq: number; reading: RunLogReading }>();
  return (db, rows) => {
    const out = new Map<string, RunLogReading>();
    const docs = new Map<string, PipelineVersion | null>();
    for (const row of rows) {
      if (row.lastSeq === undefined) {
        out.set(row.id, EMPTY);
        continue;
      }
      const hit = memo.get(row.id);
      // Delete then set either way, so the bound evicts the least recently
      // LISTED run.
      memo.delete(row.id);
      const reading =
        hit !== undefined && hit.lastSeq === row.lastSeq
          ? hit.reading
          : readOne(db, row, docs, resolveDoc, options.onUnreadable);
      memo.set(row.id, { lastSeq: row.lastSeq, reading });
      if (memo.size > limit) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) memo.delete(oldest);
      }
      out.set(row.id, reading);
    }
    return out;
  };
}

function readOne(
  db: Db,
  row: RunActivityFoldRow,
  docs: Map<string, PipelineVersion | null>,
  resolveDoc: DocResolver,
  onUnreadable: RunActivityFoldOptions['onUnreadable'],
): RunLogReading {
  let events: EngineEvent[];
  try {
    events = loadEngineEvents(db, row.id);
  } catch (err) {
    if (!(err instanceof RunLogUnparseableError)) throw err;
    onUnreadable?.(row.id, err);
    return EMPTY;
  }
  const rowsWritten = rowsWrittenFromLog(events);
  let doc = docs.get(row.pipelineVersionId);
  if (doc === undefined) {
    try {
      doc = resolveDoc(row.pipelineVersionId);
    } catch (err) {
      // Both are permanent; only the unparseable subclass is a fault to report.
      if (!(err instanceof DocUnresolvableError)) throw err;
      if (err instanceof DocUnparseableError) onUnreadable?.(row.id, err);
      doc = null;
    }
    docs.set(row.pipelineVersionId, doc);
  }
  if (doc === null) return { activities: null, rowsWritten };
  try {
    const state = buildEngine(doc).projectRunState(events);
    return { activities: activityCountsFromState(doc, events, state), rowsWritten };
  } catch (err) {
    onUnreadable?.(row.id, err);
    return { activities: null, rowsWritten };
  }
}
