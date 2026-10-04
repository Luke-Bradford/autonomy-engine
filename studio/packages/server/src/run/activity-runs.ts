import {
  parseInstanceKey,
  TERMINAL_NODE,
  type ActivityRun,
  type ActivityRunIteration,
  type EngineEvent,
  type NodeRunStatus,
  type PipelineVersion,
  type RunState,
} from '@autonomy-studio/shared';
import type { Engine } from '@autonomy-studio/shared';
import { loggedCount, reusedIds } from './activity-counts.js';
import type { LoggedEngineEvent } from './events.js';

/**
 * #1484 OR35 M2/M3 — the run's ACTIVITY RUNS: one row per attempt of each
 * activity, per iteration of its container, as a pure projection of the event
 * log. `GET /api/runs/:id/activity-runs` serves it, adding the child runs' names.
 *
 * WHY THE REDUCER IS STEPPED, rather than the log read on its own. Three facts
 * live only in reducer state: which iteration a body node is in (a sequential
 * ForEach's `round`), whether an attempt ended without a result event of its own
 * (an abandoned or doomed attempt is flipped to `skipped`), and every skip (no
 * event records one). So this folds the log through the engine one event at a
 * time and reads the state on either side of each event.
 *
 * WHAT MAKES A ROW.
 * - An ATTEMPT is a row from the first event that names its `attemptId`. That is
 *   not always `node.dispatched`: If, Switch, Set variable and Fail are settled
 *   by the engine, Execute Pipeline starts at `call.started`, a Wait at
 *   `timer.waitScheduled`, and a preflight failure is a bare `node.failed`. An
 *   attempt the reducer minted but nothing ever logged is not a row: it never ran.
 * - A SKIP is a row when a node turns `skipped` without an attempt in flight,
 *   seen as it happens and given the item it happened in. A skip the SAME reduce
 *   also resets (the event that ends a ForEach item or loop round resets the
 *   body) or deletes (a parallel item's instances) cannot be seen in any state,
 *   so it is inferred: when an item ends, every body node is terminal, and one
 *   with no row in that item was skipped.
 * - What a rerun REUSED from the run it reran is a row, marked `reused`, with no
 *   times: it did not run here.
 * Container-level outcomes (a loop that timed out or hit its cap) are not rows;
 * containers become group rows in a later M2 slice.
 *
 * HOW AN ATTEMPT SETTLES:
 * 1. An event about the attempt counts only if the attempt was the node's live
 *    one going in: the reducer ignores a stale result, and so does this.
 * 2. While the node's state still holds the attempt, the STATE is its status, so
 *    a success whose outputs broke the contract reads as the failure the engine
 *    made it. `retry_pending` reads as the `failure` it is.
 * 3. When the same reduce reset the node for the next item or deleted a parallel
 *    item's state, the result EVENT is the only record left, and it decides
 *    (`resultOf`).
 * 4. An attempt the engine abandoned with no event of its own (a loop's timeout,
 *    a doomed ForEach) is settled `skipped` when its node turns `skipped`.
 * 5. Anything else stays at the last status it had. On a cancelled run the page
 *    names that with the run's status.
 *
 * `attempt` counts POLICY retries within the item (`NodeRunState.retries`). An
 * operator's retry does not spend the policy, so its attempt keeps the number.
 */
export type ProjectedActivityRun = Omit<ActivityRun, 'childRun'>;

/** How many runs' projections one server remembers (`routes/runs.ts`). */
export const ACTIVITY_RUNS_MEMO_LIMIT = 200;

type Doc = Pick<PipelineVersion, 'nodes' | 'containers'>;
type Container = Doc['containers'][number];

/** The node an event is about and the attempt it names, if it names one. */
function attemptOf(e: EngineEvent): { nodeId: string; attemptId: string } | null {
  switch (e.type) {
    case 'node.dispatched':
    case 'node.succeeded':
    case 'node.failed':
    case 'condition.evaluated':
    case 'switch.evaluated':
    case 'variable.set':
    case 'variable.append':
    case 'timer.waitScheduled':
    case 'externalWait.created':
      return { nodeId: e.nodeId, attemptId: e.attemptId };
    case 'call.started':
    case 'call.detached':
    case 'call.returned':
      return { nodeId: e.callNodeId, attemptId: e.attemptId };
    default:
      return null;
  }
}

/** The attempt an event SETTLES, and how, for when the state no longer says. */
function resultOf(
  e: EngineEvent,
): { attemptId: string; status: NodeRunStatus; error?: string } | null {
  switch (e.type) {
    // The engine settles If, Switch and Set variable on their own events, with
    // no `node.succeeded` after them.
    case 'node.succeeded':
    case 'call.detached':
    case 'condition.evaluated':
    case 'switch.evaluated':
    case 'variable.set':
    case 'variable.append':
      return { attemptId: e.attemptId, status: 'success' };
    case 'node.failed':
      return { attemptId: e.attemptId, status: 'failure' };
    case 'call.returned':
      return e.childOutcome === 'success'
        ? { attemptId: e.attemptId, status: 'success' }
        : {
            attemptId: e.attemptId,
            status: 'failure',
            // A refused spawn says why here, and has no child run to look at.
            error: e.reason ?? `the called pipeline's run ended ${e.childOutcome}`,
          };
    case 'timer.due':
    case 'externalWait.completed':
      return { attemptId: e.previousAttemptId, status: 'success' };
    case 'externalWait.expired':
      return {
        attemptId: e.previousAttemptId,
        status: 'failure',
        error: 'the wait expired before it was completed',
      };
    case 'node.retryRequested':
      // An operator retried an attempt that had not finished; it ends here.
      return { attemptId: e.previousAttemptId, status: 'failure', error: e.reason };
    default:
      return null;
  }
}

/** A short label for a ForEach item: a scalar as text, or an object's `name`. */
function itemLabel(item: unknown): string | null {
  const MAX = 120;
  const cut = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);
  if (typeof item === 'string') return cut(item);
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
    const name = (item as Record<string, unknown>).name;
    if (typeof name === 'string') return cut(name);
  }
  return null;
}

function statedKind(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'kind' in payload;
}

export function projectActivityRuns(
  doc: Doc,
  engine: Engine,
  log: readonly LoggedEngineEvent[],
): ProjectedActivityRun[] {
  const docIds = new Set(doc.nodes.map((n) => n.id));
  const containerOf = new Map<string, Container>();
  for (const c of doc.containers) for (const child of c.children) containerOf.set(child, c);

  /** The doc node behind an event's node id: the EXACT id first, because a
   * sequential doc may legally hold a literal `x@2` (`instance-key.ts`). */
  const resolve = (nodeId: string): { activityId: string; itemIndex: number | null } => {
    if (docIds.has(nodeId)) return { activityId: nodeId, itemIndex: null };
    const parsed = parseInstanceKey(nodeId);
    return parsed === null
      ? { activityId: nodeId, itemIndex: null }
      : { activityId: parsed.docId, itemIndex: parsed.itemIndex };
  };

  const iterationOf = (nodeId: string, state: RunState): ActivityRunIteration | null => {
    const { activityId, itemIndex } = resolve(nodeId);
    const container = containerOf.get(activityId);
    if (container === undefined || container.kind === 'stage') return null;
    const cs = state.containers[container.id];
    // A parallel ForEach names the item in the key; a sequential one, and a
    // loop, are on their container's `round`.
    const index = itemIndex ?? cs?.round;
    if (index === undefined) return null;
    const items = container.kind === 'foreach' ? cs?.items : undefined;
    return {
      containerId: container.id,
      index,
      count: items?.length ?? null,
      item: items !== undefined && index < items.length ? itemLabel(items[index]) : null,
    };
  };

  const blank = (
    key: string,
    nodeId: string,
    status: NodeRunStatus,
    iteration: ActivityRunIteration | null,
  ): ProjectedActivityRun => ({
    key,
    nodeId,
    activityId: resolve(nodeId).activityId,
    attemptId: null,
    attempt: null,
    status,
    reused: false,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    iteration,
    branch: null,
    rowsRead: null,
    rowsWritten: null,
    bytesRead: null,
    bytesWritten: null,
    childRunId: null,
    error: null,
  });

  const rows: ProjectedActivityRun[] = [];
  const byAttempt = new Map<string, ProjectedActivityRun>();
  const open = new Set<ProjectedActivityRun>();
  /** `nodeId|containerId|index` of every row in an iteration. */
  const inItem = new Set<string>();
  const itemKey = (nodeId: string, it: ActivityRunIteration) =>
    `${nodeId}|${it.containerId}|${it.index}`;
  const push = (row: ProjectedActivityRun) => {
    rows.push(row);
    if (row.iteration !== null) inItem.add(itemKey(row.nodeId, row.iteration));
  };
  const addSkip = (nodeId: string, iteration: ActivityRunIteration | null) =>
    push(blank(`skip:${nodeId}:${rows.length}`, nodeId, 'skipped', iteration));
  const iterating = doc.containers.filter((c) => c.kind !== 'stage');

  const settle = (row: ProjectedActivityRun, status: NodeRunStatus, ts: number) => {
    row.status = status;
    row.finishedAt = ts;
    row.durationMs = row.startedAt !== null && ts >= row.startedAt ? ts - row.startedAt : null;
    open.delete(row);
  };
  /** Rule 2: the node's state, while it still holds the attempt. */
  const observe = (row: ProjectedActivityRun, status: NodeRunStatus, ts: number) => {
    if (status === 'retry_pending') settle(row, 'failure', ts);
    else if (TERMINAL_NODE.has(status)) settle(row, status, ts);
    else row.status = status;
  };

  let state = engine.seedState();
  for (const { event: e, ts, payload } of log) {
    const before = state;
    state = engine.reduce(before, e).state;

    const ref = attemptOf(e);
    if (ref !== null && !byAttempt.has(ref.attemptId)) {
      // The node's policy retries so far in this iteration, read wherever the
      // state still holds this attempt (a parallel item's state can be gone
      // after the very event that completed it).
      const entry = [before.nodes[ref.nodeId], state.nodes[ref.nodeId]].find(
        (n) => n?.currentAttemptId === ref.attemptId,
      );
      const row: ProjectedActivityRun = {
        ...blank(ref.attemptId, ref.nodeId, 'dispatched', iterationOf(ref.nodeId, before)),
        attemptId: ref.attemptId,
        attempt: entry === undefined ? null : entry.retries + 1,
        startedAt: ts,
      };
      push(row);
      byAttempt.set(ref.attemptId, row);
      open.add(row);
    }

    // What the event says about its attempt, settled or not.
    if (e.type === 'condition.evaluated' || e.type === 'switch.evaluated') {
      const row = byAttempt.get(e.attemptId);
      if (row !== undefined) row.branch = e.branch;
    } else if (
      e.type === 'call.started' ||
      e.type === 'call.detached' ||
      e.type === 'call.returned'
    ) {
      const row = byAttempt.get(e.attemptId);
      if (row !== undefined) row.childRunId ??= e.childRunId;
    } else if (e.type === 'node.succeeded') {
      const row = byAttempt.get(e.attemptId);
      if (row !== undefined) {
        row.rowsRead = loggedCount(e.outputs.rowsRead);
        row.rowsWritten = loggedCount(e.outputs.rowsWritten);
        row.bytesRead = loggedCount(e.outputs.bytesRead);
        row.bytesWritten = loggedCount(e.outputs.bytesWritten);
      }
    } else if (e.type === 'node.failed') {
      const row = byAttempt.get(e.attemptId);
      if (row !== undefined) {
        row.error = {
          message: e.error,
          kind: statedKind(payload) ? e.kind : null,
          code: e.code ?? null,
          connectionId: e.connectionId ?? null,
        };
      }
    }

    const result = resultOf(e);
    const subject = result?.attemptId ?? ref?.attemptId;
    const own = subject === undefined ? undefined : byAttempt.get(subject);
    if (
      own !== undefined &&
      open.has(own) &&
      before.nodes[own.nodeId]?.currentAttemptId === own.attemptId
    ) {
      if (result?.error !== undefined && own.error === null) {
        own.error = { message: result.error, kind: null, code: null, connectionId: null };
      }
      const entry = state.nodes[own.nodeId];
      if (entry?.currentAttemptId === own.attemptId) observe(own, entry.status, ts);
      else if (result !== null) settle(own, result.status, ts);
    }

    if (state.nodes !== before.nodes) {
      for (const [nodeId, entry] of Object.entries(state.nodes)) {
        if (entry.status !== 'skipped' || before.nodes[nodeId]?.status === 'skipped') continue;
        // Rule 4: an attempt in flight that the engine abandoned is that row.
        const live = before.nodes[nodeId]?.currentAttemptId ?? entry.currentAttemptId;
        const abandoned = live === undefined ? undefined : byAttempt.get(live);
        if (abandoned !== undefined && open.has(abandoned)) settle(abandoned, 'skipped', ts);
        else addSkip(nodeId, iterationOf(nodeId, before));
      }
      // A skip this reduce also reset or deleted: when an item ends, a body node
      // with no row in it was skipped.
      const ended: string[] = [];
      for (const c of iterating) {
        const was = before.containers[c.id];
        const now = state.containers[c.id];
        if (was !== undefined && now !== undefined && now.round > was.round)
          ended.push(...c.children);
      }
      for (const nodeId of Object.keys(before.nodes)) {
        if (state.nodes[nodeId] === undefined && parseInstanceKey(nodeId) !== null)
          ended.push(nodeId);
      }
      for (const nodeId of ended) {
        const iteration = iterationOf(nodeId, before);
        if (iteration !== null && !inItem.has(itemKey(nodeId, iteration)))
          addSkip(nodeId, iteration);
      }
    }

    for (const row of open) {
      const entry = state.nodes[row.nodeId];
      if (entry?.currentAttemptId === row.attemptId) observe(row, entry.status, ts);
    }
  }

  const reused = reusedIds(
    doc,
    log.map((l) => l.event),
  );
  const carried = doc.nodes
    .filter((n) => reused.has(n.id))
    .map((n) => ({ ...blank(`reused:${n.id}`, n.id, 'success', null), reused: true }));
  return [...carried, ...rows];
}
