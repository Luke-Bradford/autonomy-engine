import {
  accumulateMetered,
  docNodeIdOf,
  emptyMeteredTotals,
  EngineEventSchema,
  nodeCostFromTotals,
  parseInstanceKey,
  TERMINAL_NODE,
  terminalStatusOf,
  UNPARK_EVENTS as ENGINE_UNPARK_EVENTS,
  type EngineEvent,
  type FailureKind,
  type MeteredTotals,
  type NodeCost,
  type NodeRunStatus,
  type RunEvent,
  type RunLifecycleStatus,
  type RunState,
  type WaitingReason,
} from '@autonomy-studio/shared';

/**
 * PURE derivations the live-run view renders from a run's event log. They take
 * the same `RunEvent` envelopes the REST replay returns and the WebSocket
 * tails, so history and live frames fold identically. Nothing here does I/O or
 * touches `window` except `runStreamUrl`, whose location is injectable for
 * tests.
 *
 * The full engine reducer (`createEngine(doc).projectRunState`) is the SSOT for
 * node state, and as of U11 the run page DOES fold it — R1
 * (`GET /api/runs/:id/detail`) resolves the version doc it needs, and
 * `runProjection.ts`/`RunCanvas.tsx` draw the result on the graph.
 *
 * This doc-FREE derivation is kept deliberately, and is not a leftover. It needs
 * no doc, so it still renders for a run whose version no longer resolves, and it
 * still renders while the stream is mid-replay — both cases where the overlay
 * correctly refuses to draw.
 *
 * U25 ended the second half of that arrangement. The fold is still doc-free, but
 * its status vocabulary is no longer its OWN: it speaks the engine's
 * `NodeRunStatus` and only ever emits the subset a bare event log can justify.
 * "Where the two disagree the engine is right" used to be a docblock promise
 * that no code kept — the page rendered both and let them contradict each other.
 * `reconcileNodeActivity` is that promise as code.
 */

/** Same-origin WebSocket URL for a run's live event tail. `wss` under TLS. */
export function runStreamUrl(
  runId: string,
  loc: { protocol: string; host: string } = window.location,
): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/api/runs/${encodeURIComponent(runId)}/events/stream`;
}

/**
 * What the monitor says a node is doing — the ENGINE's vocabulary, so the graph
 * and the table cannot word the same node differently (U25). It was its own
 * five-word enum until then, which is what let one page say `retry_pending`
 * above and `retrying` below for one node.
 *
 * A bare event log cannot justify all ten members, and this fold emits only the
 * ones it can observe:
 *
 * - `dispatched` — a `node.dispatched`, or a control node's own evaluation.
 * - `retry_pending` — #483/F2b: the node failed `transient`ly, its policy still
 *   has budget, and it is waiting out the retry interval.
 * - `wait_pending` / `external_wait_pending` — the node is PARKED on a DURABLE
 *   alarm that announced itself in the log: a `wait`'s timer, or a `webhook`'s
 *   inbound callback. These were ONE word (`waiting`) before U25, which told an
 *   operator staring at a stuck run that it was parked without saying on what —
 *   the difference between "wait for it" and "something external owes us a
 *   call". The log always knew; every reader threw it away.
 * - `success` / `failure` — terminal.
 *
 * The four it cannot emit are exactly the four that need the doc, and they are
 * why `reconcileNodeActivity` exists: `pending`/`ready` (no event is appended
 * for a node that has not started) and `skipped` (routing-around emits nothing
 * at all — the reducer computes it), plus the engine's `waiting`, which means a
 * `call_pipeline`'s child run is in flight. A call node is the one park this
 * fold structurally cannot see: the engine parks it via a `startChild` COMMAND
 * and appends no event until `call.returned`, so there is nothing in the log to
 * fold (#796 — it needs a new engine event, not a projection change). That
 * window is one synchronous step TODAY, not a real blind spot: `call_pipeline`
 * does not execute yet (the executor's `startChild` branch yields an immediate
 * `call.returned{failure}` — P3b), so there is no child run to be blind to.
 * #796 owns the spawn seam AND the `call.started` append it then owes; #735,
 * which reported the blind spot alone, closed into it.
 *
 * The holds are healthy, in-progress states, and deliberately distinct from
 * `dispatched`: dispatched means the node is executing, and a held/parked node
 * is not — conflating them would tell an operator watching a stuck run that
 * work is happening when nothing is.
 */
export interface NodeActivity {
  nodeId: string;
  status: NodeRunStatus;
  /**
   * How many times the node has been STARTED, and retries bump it.
   *
   * For an executed node that is its dispatch count. But SIX activity kinds are
   * engine-evaluated and never dispatched at all — `if`, `switch`, `wait`,
   * `webhook`, `fail`, `filter` — as is a `call_pipeline` node, so counting only
   * `node.dispatched` would leave every one of them reading terminal after 0
   * attempts, i.e. "never ran".
   *
   * Two rules cover them without a doc (which this view does not have, so it
   * cannot ask what KIND a node is):
   *  - an event that STARTS a node counts (a dispatch, an `if`/`switch`
   *    evaluation, a `wait`/`webhook` park) — each carries its own `attemptId`,
   *    so one event is one attempt exactly;
   *  - a TERMINAL event for a node with no attempts yet is itself the start
   *    (`fail`/`filter`, whose only event is their `node.failed`/`node.succeeded`,
   *    and a call node, whose only event is `call.returned`). A dispatched node
   *    already has attempts ≥ 1 by then, so this never double-counts.
   */
  attempts: number;
  /** Count of streamed `node.output` observability events. */
  outputs: number;
  /** Name of the most recent `node.output`, if any (a live progress hint). */
  lastOutputName: string | undefined;
  /** The failure message, once the node has failed. */
  error: string | undefined;
  /**
   * #1 F0's machine-readable failure CLASS, off the `node.failed` that set
   * `error` — the difference between "the provider throttled us" and "the
   * credential is wrong", which the raw message is not obliged to say.
   *
   * `undefined` is a real answer, not a gap. THREE paths reach a failed node
   * without a stated class: `externalWait.expired`, whose expiry alarm fails the
   * node directly; `call.returned{childOutcome !== 'success'}`, which reports a
   * child run's verdict and has no failure of its own to classify; and a
   * `node.failed` appended before F0 minted the field, whose class the schema's
   * `.default('permanent')` supplies at the PARSE boundary rather than the
   * producer. Readers must render the absence rather than substitute a default —
   * the reducer's own reading of an expired wait as permanent lives in the
   * reducer, and restating it here would make this a second, drifting authority
   * on it.
   */
  failureKind: FailureKind | undefined;
  /** The optional machine detail beside `failureKind` (`FAILURE_CODES`, open). */
  failureCode: string | undefined;
  /**
   * The DECLARED outputs of the most recent `node.succeeded` — the node's typed
   * result contract, distinct from `outputs`/`lastOutputName` above, which count
   * the streamed `node.output` observability frames.
   */
  outputValues: Record<string, unknown> | undefined;
  /**
   * The RAW node id the result on show came from, when it differed from the
   * canvas node id this row folds onto (`w@1` → `w`) — set by EVERY terminal
   * branch, so a parked or evaluated instance is attributed like a dispatched
   * one. `undefined` for an ordinary node, so the collapse is named exactly
   * where it happened instead of being caveated everywhere.
   *
   * It names the KEY, not a cause: an `id@n` key is how a parallel foreach's
   * items are written, but a SEQUENTIAL doc may legitimately carry a literal
   * `x@2` node id (save-time only refuses those for `batchCount >= 2`), so no
   * reader may infer "this is a parallel foreach" from its presence.
   */
  instanceId: string | undefined;
  /**
   * #867 — the envelope `ts` of the event that STARTED the latest attempt, and
   * the `ts` of the event that ENDED it. `undefined`/`undefined` is the common
   * and correct answer for a whole class of nodes; see below.
   *
   * The log's append stamps are the only clock available. The reducer is pure
   * and stamps no per-node time, and `activity.captured.latencyMs` is a
   * DIFFERENT number — one provider call's wall time, on two activity kinds —
   * so it cannot answer "how long did this node take".
   *
   * The span is per-ATTEMPT, which is what keeps it honest: a retry hold
   * (`node.retryScheduled` → `node.retryDue`, minutes under policy) sits
   * BETWEEN attempt n's end and attempt n+1's start, so it falls outside every
   * span rather than inside one. A first-dispatch→terminal span would swallow
   * it and present the total as runtime.
   *
   * Which events count is NOT the same question as which ones count an
   * `attempt` above, and conflating them is the trap here. A start may only be
   * an event with a DISTINCT later terminal — `node.dispatched`,
   * `timer.waitScheduled`, `externalWait.created`. An `if`/`switch` is started
   * AND succeeded by its single `condition.evaluated`/`switch.evaluated`, as a
   * `fail`/`filter`/`call_pipeline` node is by its single terminal event, so
   * those get no start at all and render as "no span" — never as `0ms`, which
   * would state a measurement nothing made.
   *
   * For a `wait`/`webhook` the span deliberately IS the park: for those nodes
   * waiting is the work, and `timer.due`/`externalWait.completed` are their
   * success event (no `node.succeeded` follows). So the rendered number is wall
   * clock from start to settle, INCLUDING any park — which is why the UI says
   * so rather than calling it execution time.
   */
  startedAtMs: number | undefined;
  endedAtMs: number | undefined;
  /**
   * #866 — what this node SPENT: the `activity.metered` responses billed under
   * it, folded through the shared fail-closed accumulator so the per-node and
   * per-run readings cannot drift (`pricing/run-cost.ts` owns the rule).
   *
   * A node with no LLM activity holds an EMPTY cost, which is the true answer —
   * zero billed exchanges, `complete: true`, nothing to price. It is not a
   * "cost unknown": nothing was expected to be priced. The panel decides whether
   * that is worth rendering.
   *
   * SUMMED ACROSS ATTEMPTS, deliberately, unlike the result fields above which
   * `resetForNewAttempt` clears when a node re-opens. A retry re-runs the work
   * and the provider bills again; dropping attempt n's spend when attempt n+1
   * starts would under-report real money. `RunCost.responseCount` says the same
   * thing at run level ("billed exchanges … the money was spent each time").
   */
  cost: NodeCost;
  /**
   * Whether any of that spend arrived under an INSTANCE key (`w@1`), i.e. from a
   * parallel foreach ITEM rather than the canvas node itself.
   *
   * It exists because this row folds every item onto one node (`ensure`), and
   * the two things the panel shows about such a row then have DIFFERENT scopes:
   * `outputValues`/`instanceId` are ONE item's, last-write-wins, while the cost
   * is ALL of them summed. Summing is right for money — every item's charge is
   * real — but a panel that states both without qualification asserts two
   * incompatible scopes about one row, so the fact is recorded rather than left
   * for the reader to infer.
   */
  costSpansInstances: boolean;
  /**
   * #866 — the tool calls an LLM node's loop made, in LOG ORDER.
   *
   * `activity.toolCalled` carries `toolName`/`round`/`callId`/`isError` IN THE
   * CLEAR; only the args/result payloads are reduced to chars + hash. So "which
   * tools ran, in which exchange, which errored" is renderable today, and this
   * is the fold that makes it so.
   */
  toolCalls: NodeToolCall[];
}

/**
 * One `activity.toolCalled` fact, flattened for rendering.
 *
 * The args/result HASHES are deliberately not carried: they are fingerprints for
 * drift correlation, not content, and a sha256 on screen is not worth a column.
 * The CHAR counts are, because size is the one thing about an opaque payload a
 * reader can act on.
 */
export interface NodeToolCall {
  /**
   * The 0-based provider-EXCHANGE index that requested the call. NOT unique on
   * its own — it restarts at 0 on every attempt, and sibling foreach instances
   * run their own exchanges concurrently — which is why `attempt` and
   * `instanceId` sit beside it.
   */
  round: number;
  /** The executed tool name. `''` for a structurally nameless (malformed) call. */
  toolName: string;
  /** The provider's call id, ABSENT where the provider issues none (Ollama). */
  callId: string | undefined;
  /** Whether the result fed back to the model was an ERROR tool_result. */
  isError: boolean;
  argsChars: number;
  resultChars: number;
  /**
   * Which ATTEMPT of the node made this call (1-based, the node's `attempts` at
   * the time it was appended). A retry re-runs the tool loop from round 0, so
   * without this the list carries duplicate rounds with nothing distinguishing
   * them.
   */
  attempt: number;
  /** The foreach ITEM key (`w@1`) this call came from, `undefined` otherwise. */
  instanceId: string | undefined;
}

/** The cost of a node nothing billed under: zero exchanges, complete, $0. */
export function emptyNodeCost(): NodeCost {
  return nodeCostFromTotals(emptyMeteredTotals());
}

/** The row shape the fold BUILDS. The three #866 fields are projected once at
 * the end (from accumulators kept beside the map) rather than mutated in place,
 * so no caller can be handed a live accumulator. */
type FoldingNode = Omit<NodeActivity, 'cost' | 'costSpansInstances' | 'toolCalls'>;

/**
 * Fold the node-bearing events into per-node activity, in first-seen order
 * (insertion order of the map = dispatch order, stable for rendering). A node
 * is first seen on its dispatch (or a `call.returned` for a call node whose
 * dispatch is not itself an event).
 */
export function deriveNodeActivity(events: RunEvent[]): NodeActivity[] {
  const byNode = new Map<string, FoldingNode>();
  /* #866 — the observability accumulators, kept BESIDE the row map rather than
     on the rows. They are only ever written for a node the fold has already
     seen start (see the `activity.*` cases), so they cannot conjure a row. */
  const costByNode = new Map<string, MeteredTotals>();
  const instanceSpannedCost = new Set<string>();
  const toolCallsByNode = new Map<string, NodeToolCall[]>();
  // #566 slice 2 / #4 A4b — a PARALLEL foreach's body events carry per-item
  // INSTANCE keys (`w@1`); fold them onto the CANVAS node's row (`w`) so item
  // instances light up the one node the author drew — last-write-wins, the same
  // collapse the sequential foreach's rounds already have. CAVEAT: a literal
  // node id shaped like `x@2` is folded onto `x` too — accepted; save-time now
  // refuses such ids for parallel docs, and a doc-free event view cannot tell
  // the two apart. Since #483 that collapse also covers the PARKED statuses, and
  // reads worse there: a parallel foreach over a `wait` shows `success` the
  // moment the FIRST instance's timer fires, while its siblings are still parked.
  // Same last-write-wins rule as before, just newly visible.
  //
  // NO STALENESS GUARD, unlike every reducer fold this mirrors (which check node
  // status + `attemptId` and no-op on redelivery). That is safe only because the
  // durable-alarm handlers gate the APPEND — `retry-alarm.ts`, `wait-alarm.ts`,
  // `external-wait-alarm.ts` all check the node is still parked at that attempt
  // before writing, and the webhook route has its own row-status guard — so a
  // stale `timer.due`/`externalWait.expired`/`node.retryDue` never reaches the
  // log at all. That is an EXTERNAL guarantee this file depends on: if an append
  // guard were ever relaxed, a late `externalWait.expired` would flip a green row
  // red here while the reducer treats it as a no-op, and the two views would
  // disagree with nothing failing.
  const ensure = (rawNodeId: string): FoldingNode => {
    const nodeId = docNodeIdOf(rawNodeId);
    let n = byNode.get(nodeId);
    if (!n) {
      n = {
        nodeId,
        status: 'dispatched',
        attempts: 0,
        outputs: 0,
        lastOutputName: undefined,
        error: undefined,
        failureKind: undefined,
        failureCode: undefined,
        outputValues: undefined,
        instanceId: undefined,
        startedAtMs: undefined,
        endedAtMs: undefined,
      };
      byNode.set(nodeId, n);
    }
    return n;
  };

  /**
   * Drop the node's last TERMINAL result, because the node has re-opened. One
   * helper rather than five assignments at each of the three re-open sites: the
   * message, its class, the outputs and the instance they came from are one
   * fact, and splitting them is how a stale kind outlives the message it
   * classifies.
   *
   * Called at the three RE-OPEN sites (dispatch, the retry re-open, the park)
   * and at the head of EVERY terminal branch. The terminal calls are what keep a
   * parallel foreach honest: its item instances are not serialised, so
   * `succeeded w@1` then `failed w@2` folds two instances onto one row and would
   * otherwise leave a green row carrying w@2's failure — with `instanceId`
   * confidently attributing the pair to one of them. Deliberately NOT called on
   * `node.retryScheduled` — the hold keeps its reason on screen (see that case).
   */
  const clearResult = (n: FoldingNode): void => {
    n.error = undefined;
    n.failureKind = undefined;
    n.failureCode = undefined;
    n.outputValues = undefined;
    n.instanceId = undefined;
  };

  /** The raw id, when this event came from a foreach ITEM INSTANCE of the node. */
  const instanceOf = (rawNodeId: string): string | undefined =>
    docNodeIdOf(rawNodeId) === rawNodeId ? undefined : rawNodeId;

  /**
   * A TERMINAL event for a node we never saw start. That happens for the
   * activities the engine evaluates itself and never dispatches — `fail` and
   * `filter`, whose only event is the `node.failed`/`node.succeeded` the driver
   * appends for them, and a `call_pipeline` node, whose only event is
   * `call.returned`. Their one event IS their one attempt. A dispatched (or
   * evaluated, or parked) node already has attempts ≥ 1 by the time it
   * terminates, so this can never double-count.
   */
  const countIfUnstarted = (n: FoldingNode): void => {
    if (n.attempts === 0) n.attempts = 1;
  };

  /**
   * #867 — which foreach INSTANCE the currently-open span belongs to, kept here
   * rather than on the row because it is bookkeeping for the fold, not a fact
   * about the node that any reader should render.
   */
  const spanInstance = new Map<string, string | undefined>();

  /**
   * Open the latest attempt's span, discarding the previous attempt's end. The
   * reset is the point: a re-dispatched node that kept its old `endedAtMs`
   * would render the PREVIOUS attempt's duration beside a row that is running
   * again.
   */
  const openSpan = (n: FoldingNode, rawNodeId: string, at: number): void => {
    n.startedAtMs = at;
    n.endedAtMs = undefined;
    spanInstance.set(n.nodeId, instanceOf(rawNodeId));
  };

  /**
   * Forget the span entirely — no start, no end, and no claim about either.
   *
   * The map delete keeps the invariant "an entry exists iff a span is open"
   * true. Nothing reads a stale entry today (`openSpan` is the only writer of
   * `startedAtMs` and always rewrites it), so it is belt-and-braces rather than
   * load-bearing — stated so a later reader does not mistake it for a fix.
   */
  const dropSpan = (n: FoldingNode): void => {
    n.startedAtMs = undefined;
    n.endedAtMs = undefined;
    spanInstance.delete(n.nodeId);
  };

  /**
   * Close the span — unless the terminal came from a DIFFERENT instance than
   * the one that opened it, in which case there is no honest span to state and
   * the whole pair is dropped.
   *
   * A parallel foreach's items are not serialised, so `dispatched w@1` then
   * `succeeded w@2` folds onto one `w` row. Subtracting across that pair yields
   * a number that is neither item's runtime — a fabricated measurement, which
   * is strictly worse than the em-dash dropping it leaves. The same collapse is
   * why every terminal branch sets `instanceId`; this is that rule applied to
   * the one field where a mismatched pair invents data rather than misattributes
   * it.
   *
   * A terminal with no open span (a `fail`/`filter` node's only event) is a
   * no-op: it leaves the row with no start, which IS "no span".
   */
  const closeSpan = (n: FoldingNode, rawNodeId: string, at: number): void => {
    if (n.startedAtMs === undefined) return;
    if (spanInstance.get(n.nodeId) !== instanceOf(rawNodeId)) {
      dropSpan(n);
      return;
    }
    n.endedAtMs = at;
  };

  for (const row of events) {
    const parsed = EngineEventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const e = parsed.data;
    switch (e.type) {
      case 'node.dispatched': {
        const n = ensure(e.nodeId);
        n.status = 'dispatched';
        n.attempts += 1;
        clearResult(n);
        openSpan(n, e.nodeId, row.ts);
        break;
      }
      case 'node.output': {
        const n = ensure(e.nodeId);
        n.outputs += 1;
        n.lastOutputName = e.name;
        break;
      }
      case 'node.succeeded': {
        const n = ensure(e.nodeId);
        clearResult(n);
        n.status = 'success';
        n.outputValues = e.outputs;
        n.instanceId = instanceOf(e.nodeId);
        closeSpan(n, e.nodeId, row.ts);
        countIfUnstarted(n); // a `filter`'s only event
        break;
      }
      case 'node.failed': {
        const n = ensure(e.nodeId);
        clearResult(n);
        n.status = 'failure';
        n.error = e.error;
        /* `kind` carries `.default('permanent')` in `EngineEventSchema` — a
           PARSE boundary for failures stored before #1 F0 minted the field, and
           safe there because `permanent` never retries. It is NOT a fact the
           producer stated, so reading `e.kind` straight would print a
           machine-readable class onto an event that never had one. Presence is
           read off the RAW payload for that reason alone; the VALUE still comes
           from the parsed event, so this is not a second parser. */
        const statedKind = (row.payload as { kind?: unknown } | null)?.kind !== undefined;
        n.failureKind = statedKind ? e.kind : undefined;
        n.failureCode = e.code;
        n.instanceId = instanceOf(e.nodeId);
        closeSpan(n, e.nodeId, row.ts);
        countIfUnstarted(n); // a `fail` control node's only event
        break;
      }
      case 'node.retryRequested':
      case 'node.retryDue': {
        // Both re-OPEN the node, and the `node.dispatched` that follows is what
        // bumps `attempts` — so neither counts an attempt of its own, or every
        // retry would be counted twice. (`retryRequested` is the boot
        // reconciler's crash-recovery decision, `retryDue` is F2b/F2c's policy
        // retry firing; they differ in the engine, not in what the monitor shows.)
        const n = ensure(e.nodeId);
        n.status = 'dispatched';
        clearResult(n);
        /* And the span goes with the result, for the same reason. These events
           re-open the node WITHOUT starting an attempt (the `node.dispatched`
           that follows does that), so between the two the row would otherwise
           show the PREVIOUS attempt's completed span beside a `dispatched`
           status — "200ms" over a node that is running again, from an attempt
           before last. That window is a real live-tail frame, and it freezes
           permanently if the process dies after the boot reconciler's
           `node.retryRequested` and before the re-dispatch. */
        dropSpan(n);
        break;
      }
      case 'node.retryScheduled': {
        // F2b/F2c (#483) — the node is HELD for its retry interval. `node.failed`
        // just painted it red; this says the run is still healthy and the node is
        // coming back. `error` is deliberately KEPT: it is the reason for the
        // hold, and the detail column is the only place it appears. It is cleared
        // by the `node.retryDue`/`node.dispatched` that re-open the node.
        // U24: the failure CLASS is kept for the same reason and cleared by the
        // same events — `clearResult` moves the whole result as one fact, so the
        // kind can never outlive the message it classifies.
        ensure(e.nodeId).status = 'retry_pending';
        break;
      }
      // #4 A5/A6 + A13 — the node PARKED on an alarm (a `wait`'s timer) or on an
      // inbound callback (a `webhook`). These are the START of a control node's
      // life, not a transition within it: such nodes are engine-evaluated and
      // never dispatched, so this is also the event that counts their attempt.
      //
      // TWO cases rather than one, since U25. They shared a branch while the
      // monitor had a single `waiting` word for both, and folding them together
      // was the last place the distinction was lost: the log names which alarm a
      // node is parked on, the engine keeps them apart (`wait_pending` vs
      // `external_wait_pending`), and only this reader collapsed them.
      case 'timer.waitScheduled': {
        const n = ensure(e.nodeId);
        n.status = 'wait_pending';
        n.attempts += 1;
        clearResult(n);
        openSpan(n, e.nodeId, row.ts);
        break;
      }
      case 'externalWait.created': {
        const n = ensure(e.nodeId);
        n.status = 'external_wait_pending';
        n.attempts += 1;
        clearResult(n);
        openSpan(n, e.nodeId, row.ts);
        break;
      }
      case 'timer.due':
      case 'externalWait.completed': {
        // The park resolved successfully. These ARE the node's success event —
        // there is no following `node.succeeded` for a parked node (reduce.ts
        // `onWaitDue` / `onExternalWaitCompleted` flip it to `success` directly).
        const n = ensure(e.nodeId);
        clearResult(n);
        n.status = 'success';
        n.instanceId = instanceOf(e.nodeId);
        closeSpan(n, e.nodeId, row.ts);
        break;
      }
      case 'externalWait.expired': {
        // #4 A13 — the expiry alarm beat the callback, which the reducer treats as
        // a PERMANENT failure. The event carries no message (there is no provider
        // to quote), so state the reason rather than leave a red row with a blank
        // detail column.
        const n = ensure(e.nodeId);
        clearResult(n);
        n.status = 'failure';
        n.error = 'external wait expired before a callback arrived';
        n.instanceId = instanceOf(e.nodeId);
        closeSpan(n, e.nodeId, row.ts);
        break;
      }
      case 'condition.evaluated':
      case 'switch.evaluated': {
        // An `if`/`switch` is engine-evaluated and never dispatched, and THIS is
        // its terminal-success event (reduce.ts `onControlBranchEvaluated`). Until
        // it was folded, control nodes never appeared in this table at all — the
        // author drew them, the run executed them, and the monitor showed nothing.
        const n = ensure(e.nodeId);
        clearResult(n);
        n.status = 'success';
        n.attempts += 1;
        n.instanceId = instanceOf(e.nodeId);
        break;
      }
      case 'call.returned': {
        const n = ensure(e.callNodeId);
        clearResult(n);
        n.status = e.childOutcome === 'success' ? 'success' : 'failure';
        // A call node's declared outputs arrive on THIS event rather than a
        // `node.succeeded` — it is the only terminal event a call node gets — so
        // without this the Outputs section stayed empty on the one activity that
        // can carry a whole child run's result. Folded on BOTH outcomes, not
        // gated on success: `call.returned`'s own schema records that a
        // `failure` child may still carry projected `outputs` (the findings
        // loop), and gating would silently drop exactly that documented case.
        n.outputValues = e.outputs;
        n.instanceId = instanceOf(e.callNodeId);
        /* A no-op today — a call node has no start event, so there is no span
           to close. It is wired anyway because #796 adds `call.started`: the
           day it lands, a call node's span would open here and never close,
           every call node would silently read as unmeasured, and no test would
           fail. `closeSpan` is documented as a no-op without an open span. */
        closeSpan(n, e.callNodeId, row.ts);
        countIfUnstarted(n); // a call node's only event
        break;
      }

      // ── Deliberately NOT node activity ────────────────────────────────────
      // Listed as explicit empty cases rather than swept into a `default:`, and
      // that is the actual fix for #483's defect CLASS. #483 was not "two events
      // were missed"; it was that a `default:` silently absorbed NINE node-bearing
      // events and the monitor lied with every unit test green. Prose cannot stop
      // that recurring — the `never` assertion below can: every one of the union's
      // members is now named, so adding a 29th `EngineEvent` narrows `e` to
      // something other than `never` in the final branch and fails TYPECHECK until
      // its author decides which side it falls on. Same guard `engine/reduce.ts`
      // documents for `NodeRunStatus`, in the form a non-returning switch needs.

      // Why each is ignored, kept HERE rather than beside its `case` so the
      // labels stay adjacent — eslint's `no-fallthrough` counts a case carrying
      // only a comment as non-empty (the same constraint `engine/reduce.ts`
      // records):
      //   - `run.*` — RUN-level, no node row. `run.started`/`run.resumed`/
      //     `run.waiting` and the terminal pair are folded by
      //     `deriveRunLifecycle` below. `run.triggerContext` and `run.reseeded`
      //     are folded by NOTHING today — they are provenance that only the raw
      //     event feed renders.
      //   - `container.*` — CONTAINER-level: they carry a `containerId` and NO
      //     `nodeId`, so in a per-node table there is no row for them to land in.
      //     Surfacing container state needs the version doc this page does not
      //     fetch (a P6c follow-up).
      //   - `activity.*` — node-bearing but pure OBSERVABILITY: they say nothing
      //     about whether the node is RUNNING, so none of them may set a status
      //     or create a row. `node.output` is folded above (it feeds the
      //     `outputs` count and the `lastOutputName` progress hint), and since
      //     #866 `activity.metered`/`activity.toolCalled` are folded too — into
      //     the cost/tool accumulators only, and ONLY onto a row that already
      //     exists. `captured`/`agentTelemetry`/`warned` remain wholly inert
      //     (#750 pins `warned`'s inertness).
      case 'run.started':
      case 'run.finished':
      case 'run.resumed':
      case 'run.interrupted':
      case 'run.waiting':
      case 'run.triggerContext':
      case 'run.reseeded':
      case 'container.timeoutScheduled':
      case 'container.timedOut':
      case 'activity.captured':
      case 'activity.agentTelemetry':
      case 'activity.warned':
        break;

      /* #866 — SPEND. Attributed to an EXISTING row only: `node.dispatched`
         precedes every activity event the executor emits and the stream replays
         the log uncapped, so an unrowed metered event is unreachable in practice
         — but the rule the inert group states ("observability never creates a
         row") is the one worth keeping, because the alternative invents a node
         with a manufactured status. */
      case 'activity.metered': {
        const target = byNode.get(docNodeIdOf(e.nodeId));
        if (target === undefined) break;
        let totals = costByNode.get(target.nodeId);
        if (totals === undefined) {
          totals = emptyMeteredTotals();
          costByNode.set(target.nodeId, totals);
        }
        accumulateMetered(totals, e);
        if (instanceOf(e.nodeId) !== undefined) instanceSpannedCost.add(target.nodeId);
        break;
      }

      case 'activity.toolCalled': {
        const target = byNode.get(docNodeIdOf(e.nodeId));
        if (target === undefined) break;
        const list = toolCallsByNode.get(target.nodeId) ?? [];
        list.push({
          round: e.round,
          toolName: e.toolName,
          callId: e.callId,
          isError: e.isError,
          argsChars: e.argsChars,
          resultChars: e.resultChars,
          /* The node's attempt count AT APPEND TIME. `node.dispatched` has
             already bumped it, so the first attempt reads 1. */
          attempt: target.attempts,
          instanceId: instanceOf(e.nodeId),
        });
        toolCallsByNode.set(target.nodeId, list);
        break;
      }
      default: {
        // Unreachable while every member above is named — which is exactly the
        // property being enforced. A new event type makes this assignment fail to
        // compile; it is not a runtime branch.
        const exhaustive: never = e;
        void exhaustive;
        break;
      }
    }
  }

  /* Project the #866 accumulators onto the rows ONCE, at the end. Walking the
     nodes (a handful) rather than the events (unbounded), so this is not the
     fourth log fold #849 is about. Each row gets its OWN empty cost rather than
     a shared constant — a shared object would hand every uncosted node the same
     mutable `providers`/`models` arrays. */
  return [...byNode.values()].map((n) => {
    const totals = costByNode.get(n.nodeId);
    return {
      ...n,
      cost: totals === undefined ? emptyNodeCost() : nodeCostFromTotals(totals),
      costSpansInstances: instanceSpannedCost.has(n.nodeId),
      toolCalls: toolCallsByNode.get(n.nodeId) ?? [],
    };
  });
}

/**
 * U25 — let the ENGINE settle the status of every node it has an opinion about,
 * and add the rows only it can know exist.
 *
 * `deriveNodeActivity` above folds a bare event log; `projectRun` folds the same
 * log through the reducer WITH the doc. Both were rendered on one page, in two
 * vocabularies, and nothing reconciled them — so the graph could paint a node
 * grey-`skipped` while the table two elements below simply had no row for it,
 * which reads as "never reached". This is the join.
 *
 * The split of authority is deliberate and narrow:
 *
 *  - **STATUS comes from the engine** wherever the engine has one. It is the
 *    same reducer the driver runs, and it sees routing, containers and the doc.
 *  - **Every other column stays the FOLD's.** `attempts`, the streamed-output
 *    count, the failure message/kind/code, the declared outputs and the
 *    instance attribution are things the log records and the projection either
 *    discards or never had. Overwriting them from `NodeRunState` would trade a
 *    rich row for a poorer one to buy a consistency nothing was violating.
 *
 * PARALLEL-FOREACH BODY NODES ARE THE CASE THAT MAKES THIS SUBTLE, and getting
 * it wrong makes the table worse rather than better. `seedState` deliberately
 * does NOT seed them (`reduce.ts` skips `parallelChildIds`); their state lives
 * only under transient per-item instance keys (`w@1`), which are DELETED as
 * each item completes. So for such a node `state.nodes['w']` is absent whether
 * it has never run, is running, or has long finished — while the fold, which
 * collapses `w@1`/`w@2` onto `w`, lit that row up correctly. Two rules follow,
 * and both are load-bearing:
 *
 *  1. The engine wins only where `state.nodes[nodeId]` EXISTS. Absent means
 *     "the projection has no opinion", never "pending" — treating it as pending
 *     would blank exactly the rows a parallel foreach is driving.
 *  2. Seeded rows come from bare keys of `state.nodes` only. An instance key is
 *     skipped rather than collapsed: `w@1` and `w@2` would collapse onto one
 *     row with no defensible rule for which item's status wins, and the fold
 *     has already made that row from the same events under its own stated
 *     last-write-wins.
 *
 * The caller is responsible for only calling this once the projection is
 * trustworthy — see `useRunProjection`, which withholds it until the replay is
 * complete. A projection of a partly-replayed log holds nodes the run has in
 * fact moved past, and letting THAT win over the fold would reintroduce the
 * same lie from the other direction.
 */
export function reconcileNodeActivity(rows: NodeActivity[], state: RunState): NodeActivity[] {
  const reconciled = rows.map((row) => {
    const engine = state.nodes[row.nodeId];
    if (engine === undefined) return row;
    /* #867 — an OPEN span cannot survive the engine calling the node terminal.
       The reducer can settle a node with no node event at all: `container.timedOut`
       flips a live child to `skipped` via `abandonLiveChildren`, so the fold is
       left holding a start whose close will never be appended. Keeping it would
       render "skipped" beside a span the UI describes as still in flight. The
       engine is the authority on the status, so it is the authority on whether
       an attempt is still running. */
    const open = row.startedAtMs !== undefined && row.endedAtMs === undefined;
    const settled = TERMINAL_NODE.has(engine.status);
    return open && settled
      ? { ...row, status: engine.status, startedAtMs: undefined }
      : { ...row, status: engine.status };
  });

  const seen = new Set(reconciled.map((row) => row.nodeId));
  for (const [nodeId, engine] of Object.entries(state.nodes)) {
    if (seen.has(nodeId)) continue;
    if (parseInstanceKey(nodeId) !== null) continue;
    reconciled.push({
      nodeId,
      status: engine.status,
      /* ZERO, and deliberately NOT `engine.attempts` — except for the one
         status where the engine is right and the zero would be the lie.

         The general rule first. The reducer mints an attempt id as a node
         becomes READY and bumps the counter then, so a node that has not run
         yet reports `attempts: 1` — measured, not assumed (the test pins it).
         This column means "how many times the node has been STARTED", so
         copying that across would print "1 attempt" beside `ready` and restate,
         in the attempts column, exactly the kind of falsehood this
         reconciliation exists to remove.

         The exception is `waiting`, and it is the one status whose absence from
         the fold does NOT imply "nothing started it". A `call_pipeline` node is
         parked by a `startChild` COMMAND with no event appended until
         `call.returned` (see the `NodeActivity` docblock above, and
         `reduce.ts`'s `waiting` park, which sets `attempts: attempts + 1`), so
         the node reaches this branch precisely BECAUSE the engine started it
         and told no one. Zero there would render "waiting (child run) · 0
         attempts" over a child run that is genuinely on its first attempt.
         Barely reachable today — the executor answers `startChild` with an
         immediate `call.returned{failure}` (P3b) — but it is the state a live
         tail passes through, it FREEZES there if the server dies between the
         command and the append, and #796 makes it routine. */
      attempts: engine.status === 'waiting' ? engine.attempts : 0,
      outputs: 0,
      lastOutputName: undefined,
      error: undefined,
      failureKind: undefined,
      failureCode: undefined,
      outputValues: undefined,
      instanceId: undefined,
      /* No event, so no stamp — the row exists BECAUSE the fold never saw one.
         Same rule as the fields above: an absent fact is rendered as absent,
         never manufactured (#867). */
      startedAtMs: undefined,
      endedAtMs: undefined,
      /* #866 — likewise. A row reached here because NO event named this node, so
         nothing billed under it and no tool ran: an empty cost and an empty list
         are the MEASURED answer here, not a placeholder standing in for one. */
      cost: emptyNodeCost(),
      costSpansInstances: false,
      toolCalls: [],
    });
  }
  return reconciled;
}

/**
 * #870 — the events that RESUME a parked run, DERIVED from the engine's own
 * `UNPARK_EVENTS` rather than hand-copied from it, so the two cannot drift and a
 * fifth engine unpark event is honoured here the day it lands.
 *
 * `run.resumed` is subtracted because this fold handles it unconditionally
 * above, preserving the deliberate resume-after-terminal live-VIEW rule pinned
 * in this module's tests. (If the engine ever drops it from the set, the
 * subtraction is a harmless no-op.)
 *
 * THE SET IS SHARED; THE PRECISION IS NOT, and the gap is stated because it is
 * real. In the reducer each of these reaches `unparkIfWaiting` only after its
 * handler's node-level guard — the parked node must still be at the attempt the
 * event names. A redelivered or superseded alarm (at-least-once delivery, a
 * back-edge reset, a child abandoned by a container timeout) no-ops there and
 * the run stays parked. This fold has no node state and cannot make that check,
 * so it un-parks on any of them. Measured: for
 * `run.waiting → timer.due{previousAttemptId: <stale>}` the reducer stays
 * `waiting` and this fold says `running`.
 *
 * That is the right trade for what this fold IS — the answer when no version doc
 * resolves, where the alternative (never un-parking without a `run.resumed`) is
 * wrong on every ordinary timer resume rather than on a rare redelivery. Where
 * a doc DOES resolve, `RunDetailPage` prefers the projection for exactly this
 * question; see its comment.
 */
const UNPARK_EVENTS = new Set<EngineEvent['type']>(
  [...ENGINE_UNPARK_EVENTS].filter((type) => type !== 'run.resumed'),
);

/** The run's lifecycle status and, when it is parked, WHY. */
export interface RunLifecycle {
  status: RunLifecycleStatus;
  /**
   * Non-null only while `status === 'waiting'`. The reducer nulls it on every
   * edge out of `waiting` (`unparkIfWaiting`) and this fold mirrors that, so a
   * stale reason cannot survive an unpark and be rendered over a running run.
   */
  waitingReason: WaitingReason | null;
}

/**
 * The run's lifecycle status AS THE LOG SEES IT, or `null` if no lifecycle event
 * has landed yet (the caller then shows the run row's REST status). Later events
 * win, so a `run.finished` after `run.started` yields the terminal outcome.
 *
 * NOT checked here, unlike in the reducer: `e.runId`. The reducer guards it
 * (a foreign run's `run.waiting` cannot park this run); this fold is only ever
 * handed `useRunStream(runId)`'s rows, which are one run's by construction. It
 * is named rather than silently omitted, because "mirrors the reducer's S3
 * rules" would otherwise cover a rule that is not in fact mirrored.
 *
 * #870 — this is now the run detail page's FALLBACK, not its primary answer.
 * Where the version doc resolves, the page reads the run's status and park
 * reason off the ENGINE's projection instead, which is U25's settled split of
 * authority applied one level up: the reducer sees the whole run, this fold sees
 * only the run-level events. The fold is kept, and improved rather than
 * simplified, because it is what still renders for a run whose version no longer
 * resolves and while the stream is mid-replay — exactly the cases a broken run
 * most needs reading. See `RunDetailPage`.
 *
 * The terminal events map through `terminalStatusOf` — the engine's SSOT (#443),
 * shared with the reducer and the boot reconciler, so this page and `runs.status`
 * can never disagree about what a `run.finished` MEANS.
 *
 * Deliberately NOT the same rule as the server's `terminalFactFromLog`, which
 * takes the last TERMINAL event: this is a live VIEW, so a `run.resumed` tailing
 * in must show the run as running again. `terminalFactFromLog` answers a
 * different question — "what terminal fact does this log durably record" — where a
 * resume must never erase the terminal under it. Same mapping, different rule, by
 * intent.
 */
export function deriveRunLifecycle(events: RunEvent[]): RunLifecycle | null {
  let status: RunLifecycleStatus | null = null;
  let waitingReason: WaitingReason | null = null;
  for (const row of events) {
    const parsed = EngineEventSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const e = parsed.data;
    const terminal = terminalStatusOf(e);
    if (terminal !== null) {
      status = terminal;
      waitingReason = null;
    } else if (e.type === 'run.started' || e.type === 'run.resumed') {
      // A resume/(re)start tailing in shows the run running again — and CLEARS a
      // prior `waiting` (the live-view reverse edge, mirroring the reducer's
      // waiting→running un-park, wired in #619 as `unparkIfWaiting`).
      status = 'running';
      waitingReason = null;
    } else if (e.type === 'run.waiting') {
      // #5 S3 — the run parked on an external event. Live VIEW: show it `waiting`
      // (not the stale `running`) until an unpark returns it.
      //
      // #870 — GUARDED ON `running`, mirroring the reducer's own S3 status guard
      // instead of taking the last `run.waiting` in the log. Three of the
      // reducer's pinned behaviours fall out of that one condition, and
      // last-wins would have broken the middle one: a `run.waiting` before
      // `run.started` is ignored; a SECOND `run.waiting` on an already-parked
      // run is ignored, so the FIRST reason stands; and a post-terminal one is
      // ignored.
      //
      // A second park cannot in fact occur today — the PRODUCER is itself
      // status-guarded (`parkRun` fires only on a `running` run), so no log
      // carries one. The guard is kept anyway, and is not defensive clutter:
      // it is what makes first-wins EXPLICIT, so a future producer cannot
      // silently flip a rendered reason from one confident noun to another.
      if (status === 'running') {
        status = 'waiting';
        waitingReason = e.reason;
      }
    } else if (UNPARK_EVENTS.has(e.type)) {
      // #870 — the REST of the reducer's unpark set. Without these the fold
      // stayed `waiting` forever on the common path: `run.resumed` is appended
      // only by boot-reconcile and lease-reclaim, so a run parked on a timer and
      // resumed by `timer.due` kept a stale `waiting` here while the row and the
      // reducer had both moved on. That was survivable while the word was bare;
      // with a reason attached it becomes a confident lie — "waiting (timer)"
      // over a running run — and the runs LIST, reading the row, would say
      // `running` for that same run. Precisely the cross-surface drift #870
      // exists to close.
      //
      // Conditional on `waiting`, exactly as `unparkIfWaiting` is: these are
      // node-level facts that no-op on a run which is not parked, and must never
      // resurrect a terminal one.
      if (status === 'waiting') {
        status = 'running';
        waitingReason = null;
      }
    }
  }
  return status === null ? null : { status, waitingReason };
}
