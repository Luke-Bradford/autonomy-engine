import type {
  EngineEvent,
  PipelineVersion,
  RunActivityCounts,
  RunState,
} from '@autonomy-studio/shared';
import type { Db } from '../repo/types.js';
import { buildEngine, DocUnresolvableError, type DocResolver } from './driver.js';
import { hasRunStartedFact, loadEngineEvents, RunLogUnparseableError } from './events.js';

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
 * WHAT IS COUNTED, stated once because three shapes make it a choice:
 * - The version's nodes and containers, each once, read from the DOC rather
 *   than from state keys — so a parallel ForEach's transient instance keys
 *   (`w@1`) are never counted as activities of their own.
 * - A body node inside a loop counts by its LAST round's status, because the
 *   reducer resets bodies each round. Per-iteration rows are M2/M3's
 *   activity-runs read model, not this column.
 * - A PARALLEL ForEach's body nodes are absent from state (`seedState` skips
 *   them), so they are not counted; the ForEach itself is.
 * - A rerun-from-failed's copied frontier (`run.reseeded`) is `reused`, not
 *   `succeeded`: it succeeded in the source run, and this run's log holds no
 *   `node.succeeded` for it — which is also why Rows written leaves it out.
 */
export function activityCountsFromState(
  doc: Pick<PipelineVersion, 'nodes' | 'containers'>,
  events: readonly EngineEvent[],
  state: RunState,
): RunActivityCounts {
  const reused = reusedIds(doc, events);
  const counts = { succeeded: 0, failed: 0, skipped: 0, reused: 0, unfinished: 0 };
  const tally = (id: string, status: string | undefined) => {
    if (status === undefined) return;
    if (status === 'success') {
      if (reused.has(id)) counts.reused += 1;
      else counts.succeeded += 1;
    } else if (status === 'failure') counts.failed += 1;
    else if (status === 'skipped') counts.skipped += 1;
    else counts.unfinished += 1;
  };
  for (const node of doc.nodes) tally(node.id, state.nodes[node.id]?.status);
  for (const container of doc.containers)
    tally(container.id, state.containers[container.id]?.status);
  return counts;
}

/**
 * The ids a rerun-from-failed carried over: its frontier, its copied containers,
 * and everything inside those containers (a copied container brings its body).
 * The LAST `run.reseeded` wins, matching the fold.
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

/** A page row as the fold needs it; `lastSeq` is `undefined` for an empty log. */
export interface RunActivityFoldRow {
  readonly id: string;
  readonly pipelineVersionId: string;
  readonly lastSeq: number | undefined;
}

/**
 * Folds a page of runs. `db` is the caller's read transaction, so the events
 * come from the same snapshot as the rows; versions are immutable, so reading
 * them through `resolveDoc` outside it changes nothing.
 */
export type RunActivityFold = (
  db: Db,
  rows: readonly RunActivityFoldRow[],
) => Map<string, RunActivityCounts | null>;

/**
 * How many folded runs one app keeps. A finished run's log never grows, so its
 * counts are folded once and then served from here; the bound only keeps a
 * long-lived server from holding every run it has ever listed.
 */
export const ACTIVITY_FOLD_MEMO_LIMIT = 2000;

/**
 * The fold the runs route hands `listRunSummariesPage`, memoised on
 * `(runId, lastSeq)`. The log is append-only and `seq` strictly grows, so that
 * pair names exactly one log; a live run's key moves on every append and is
 * refolded, a settled one is folded once. In-process only: a restart (which is
 * also how a reducer change ships) starts empty.
 *
 * Per row, `null` when there is nothing honest to count, and only for a reason
 * that will not change on retry:
 * - an empty log, or one without `run.started` (the reducer seeds no node until
 *   then, so every count would be a manufactured zero);
 * - the bound version is gone or does not parse;
 * - the log does not parse;
 * - the fold itself throws (the reducer is pure, so that is the log's fault).
 * A transient DB read error propagates, as every other read on this route does.
 */
export function makeRunActivityFold(resolveDoc: DocResolver): RunActivityFold {
  const memo = new Map<string, RunActivityCounts | null>();
  return (db, rows) => {
    const out = new Map<string, RunActivityCounts | null>();
    const docs = new Map<string, PipelineVersion | null>();
    for (const row of rows) {
      if (row.lastSeq === undefined) {
        out.set(row.id, null);
        continue;
      }
      const key = `${row.id}:${row.lastSeq}`;
      if (memo.has(key)) {
        // Re-insert so the bound evicts the least recently LISTED run.
        const hit = memo.get(key) ?? null;
        memo.delete(key);
        memo.set(key, hit);
        out.set(row.id, hit);
        continue;
      }
      const counts = foldOne(db, row, docs, resolveDoc);
      memo.set(key, counts);
      if (memo.size > ACTIVITY_FOLD_MEMO_LIMIT) {
        const oldest = memo.keys().next().value;
        if (oldest !== undefined) memo.delete(oldest);
      }
      out.set(row.id, counts);
    }
    return out;
  };
}

function foldOne(
  db: Db,
  row: RunActivityFoldRow,
  docs: Map<string, PipelineVersion | null>,
  resolveDoc: DocResolver,
): RunActivityCounts | null {
  let doc = docs.get(row.pipelineVersionId);
  if (doc === undefined) {
    try {
      doc = resolveDoc(row.pipelineVersionId);
    } catch (err) {
      // `DocUnparseableError` is a subclass: both are permanent.
      if (!(err instanceof DocUnresolvableError)) throw err;
      doc = null;
    }
    docs.set(row.pipelineVersionId, doc);
  }
  if (doc === null) return null;
  let events: EngineEvent[];
  try {
    events = loadEngineEvents(db, row.id);
  } catch (err) {
    if (err instanceof RunLogUnparseableError) return null;
    throw err;
  }
  if (!hasRunStartedFact(events)) return null;
  try {
    return activityCountsFromState(doc, events, buildEngine(doc).projectRunState(events));
  } catch {
    return null;
  }
}
