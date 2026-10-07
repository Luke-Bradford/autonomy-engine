import { docNodeIdOf, type RunEvent } from '@autonomy-studio/shared';
import type { ActivityRun } from '@autonomy-studio/shared';
import { parseEngineEvent } from './parsedEvent';
import { blankNodeActivity, deriveNodeActivity, type NodeActivity } from './runSummary';

/**
 * #1484 OR35 M2 — what ONE activity run did: the drawer's reading of a single
 * attempt, in a single ForEach item or loop round, rather than the node's
 * latest.
 *
 * The node fold (`deriveNodeActivity`) keys on the node, so a sequential
 * ForEach's second item overwrites its first and a retry overwrites the attempt
 * that failed. Every attempt-scoped event names its attempt, though, and an
 * attempt id is unique within a run (the reducer does not reset `attempts`
 * between rounds, and a parallel item's id carries its instance key). So the
 * same fold over just that attempt's events IS that attempt's record — input,
 * outputs, cost, tool calls, captures and its child run — with no second fold
 * to keep in step.
 */

/**
 * Result events that name the attempt they SETTLE in `previousAttemptId`: the
 * timer or callback a parked attempt was waiting on.
 *
 * `node.retryRequested` and `node.retryDue` also carry a `previousAttemptId`,
 * and are left out on purpose. They name the attempt that failed only to RE-OPEN
 * the node for the next one, and the fold answers them by clearing the error,
 * input and span — which, over this one attempt's events, would wipe the very
 * failure the drawer was opened to read.
 */
const SETTLED_BY_PREVIOUS = new Set([
  'timer.due',
  'externalWait.completed',
  'externalWait.expired',
]);

/** The raw node id (`w` or `w@2`) and attempt an event names, if it names one. */
function attemptRef(row: RunEvent): { raw: string; attemptId: string } | null {
  const e = parseEngineEvent(row);
  if (e === null) return null;
  const raw = 'callNodeId' in e ? e.callNodeId : 'nodeId' in e ? e.nodeId : undefined;
  if (typeof raw !== 'string') return null;
  if ('attemptId' in e && typeof e.attemptId === 'string') return { raw, attemptId: e.attemptId };
  if (SETTLED_BY_PREVIOUS.has(e.type) && 'previousAttemptId' in e) {
    return { raw, attemptId: e.previousAttemptId };
  }
  return null;
}

/**
 * The events of one attempt, in log order.
 *
 * `node.output` names no attempt, only its node. The executor streams it while
 * an attempt is dispatched, so it belongs to the latest attempt its (raw) node
 * had started before it. One that arrives before any attempt has no attempt to
 * belong to and is dropped; the stream never sends one.
 */
export function attemptEvents(events: readonly RunEvent[], attemptId: string): RunEvent[] {
  const out: RunEvent[] = [];
  walkAttempts(events, (row, owner) => {
    if (owner === attemptId) out.push(row);
  });
  return out;
}

/**
 * #1299 on the activity runs: each attempt's latest streamed value, by attempt
 * id. A running row shows it, so a long copy's per-batch progress reads as
 * progress rather than a hang. One pass, attributing each `node.output` the way
 * `attemptEvents` does, so a parallel item's tick lands on that item's row and a
 * retry starts with nothing.
 */
export function latestOutputByAttempt(
  events: readonly RunEvent[],
): Map<string, { name: string; value: unknown }> {
  const latest = new Map<string, { name: string; value: unknown }>();
  walkAttempts(events, (row, owner) => {
    const e = parseEngineEvent(row);
    if (e?.type === 'node.output') latest.set(owner, { name: e.name, value: e.value });
  });
  return latest;
}

/** One line of an activity run's streamed output, for the drawer's Logs tab. */
export interface StreamedLine {
  seq: number;
  ts: RunEvent['ts'];
  name: string;
  value: unknown;
}

/**
 * #1484 OR35 M2 — everything one attempt streamed, in log order: the drawer's
 * Logs. Attributed the way `attemptEvents` attributes them, so a parallel
 * ForEach item's lines are that item's and a retry starts with none.
 */
export function attemptOutputLines(events: readonly RunEvent[], attemptId: string): StreamedLine[] {
  const out: StreamedLine[] = [];
  walkAttempts(events, (row, owner) => {
    if (owner !== attemptId) return;
    const e = parseEngineEvent(row);
    if (e?.type === 'node.output')
      out.push({ seq: row.seq, ts: row.ts, name: e.name, value: e.value });
  });
  return out;
}

/** Calls `visit` with each event that belongs to an attempt, and that attempt. */
function walkAttempts(
  events: readonly RunEvent[],
  visit: (row: RunEvent, attemptId: string) => void,
): void {
  const latest = new Map<string, string>();
  const started = new Set<string>();
  for (const row of events) {
    const ref = attemptRef(row);
    if (ref !== null) {
      // An attempt's FIRST event starts it and makes it its node's latest. A
      // timer or callback settling an attempt does not start one, and a late
      // or duplicate result for an earlier attempt does not take the stream
      // back from the one now running.
      if (!SETTLED_BY_PREVIOUS.has(row.type) && !started.has(ref.attemptId)) {
        started.add(ref.attemptId);
        latest.set(ref.raw, ref.attemptId);
      }
      visit(row, ref.attemptId);
      continue;
    }
    if (row.type === 'node.output') {
      const e = parseEngineEvent(row);
      const owner = e?.type === 'node.output' ? latest.get(e.nodeId) : undefined;
      if (owner !== undefined) visit(row, owner);
    }
  }
}

/**
 * The drawer's record of one activity run.
 *
 * The row is the read model's account (`/activity-runs`), and where it speaks
 * it wins: its status, times and error. The fold below cannot tell those apart
 * from one attempt's events alone. An attempt the engine abandoned (a loop's
 * timeout, a doomed ForEach) has no event that ends it, so its fold still reads
 * running. And an attempt that failed and was retried reads `retry_pending`.
 *
 * A row with no attempt has no events of its own:
 * - a REUSED row is the node fold's copied-frontier record, which is node-level
 *   anyway: a rerun copies a node once;
 * - a SKIP is a blank skipped record. The panel says why it was skipped.
 *
 * The page's two sources can disagree for a moment. The rows are re-read as the
 * log grows, so the fold can be a frame ahead of its row; the next read closes
 * it.
 */
export function activityOfRow(
  events: readonly RunEvent[],
  nodes: readonly NodeActivity[],
  row: ActivityRun,
): NodeActivity {
  const base =
    row.attemptId !== null
      ? deriveNodeActivity(attemptEvents(events, row.attemptId)).find(
          (n) => n.nodeId === docNodeIdOf(row.nodeId),
        )
      : row.reused
        ? nodes.find((n) => n.nodeId === row.activityId)
        : undefined;
  const node = base ?? blankNodeActivity(row.activityId, row.reused ? 'success' : row.status);
  return {
    ...node,
    status: row.reused ? 'success' : row.status,
    ...(row.attemptId === null
      ? {}
      : {
          // The row's times, so an abandoned attempt, which no event of its own
          // closes, reads settled and does not count up.
          startedAtMs: row.startedAt ?? undefined,
          endedAtMs: row.finishedAt ?? undefined,
          // One attempt is one span, of one item. The fold marks a parallel
          // item's span with its instance key so a node-wide reading never
          // counts up across items, and leaves an abandoned attempt's open;
          // neither holds for a single attempt the row has settled.
          spans: node.spans.map((s) => ({
            ...s,
            instanceId: undefined,
            endedAtMs: s.endedAtMs ?? row.finishedAt ?? undefined,
          })),
          // The fold's "this sums every item" and "the item dispatched most
          // recently" readings are about a node; this is one item's attempt.
          costSpansInstances: false,
          inputInstanceId: undefined,
          error: row.error?.message,
          failureKind: row.error?.kind ?? undefined,
          failureCode: row.error?.code ?? undefined,
        }),
    // A copied node inside a copied container has no fold record, so name the
    // run it came from here (the reseed event says which).
    copiedFromRunId: row.reused ? (node.copiedFromRunId ?? reseedSource(events)) : undefined,
  };
}

function reseedSource(events: readonly RunEvent[]): string | undefined {
  for (const row of events) {
    const e = parseEngineEvent(row);
    if (e?.type === 'run.reseeded') return e.sourceRunId;
  }
  return undefined;
}
