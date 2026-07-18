import { z } from 'zod';
import { MAX_RETRY_INTERVAL_SECONDS } from '../schemas/pipeline.js';
import type {
  Param,
  Output,
  Node,
  Edge,
  EdgeOn,
  OperationalEdge,
  BranchEdge,
  Container,
  CallConfig,
  PipelineVersion,
} from '../schemas/pipeline.js';

// Re-export the P1 schema types so engine consumers have one import surface for
// the language's inputs. These are NOT redefined here — they are the single
// source of truth in `../schemas/pipeline.ts`.
export type {
  Param,
  Output,
  Node,
  Edge,
  EdgeOn,
  OperationalEdge,
  BranchEdge,
  Container,
  CallConfig,
  PipelineVersion,
};

/**
 * The read-only context a `${...}` expression resolves against. PURE input:
 * everything the language can see lives here, nothing is fetched.
 *
 * - `params`   — resolved run params by name. SECRET-typed params are STRIPPED
 *                before a context is built (see `resolveRunParams`), so a
 *                secret value can never enter substitution or an error message.
 * - `nodeOutputs` — a node's declared outputs, populated ONLY once that node has
 *                reached a terminal `node.succeeded` (partial outputs never feed
 *                substitution). Keyed by nodeId, then by output name.
 * - `nodeStatuses` — every node's CURRENT status, backing `${nodes.<id>.status}`
 *                (#6 E3 T6). Deliberately the whole `NodeRunStatus`, not just the
 *                terminal subset: the map reports what the run knows, and
 *                REFUSING a non-terminal read is the resolver's judgement, not a
 *                gap in the data. Equally deliberately a status-only projection
 *                rather than `RunState.nodes` itself — `attempts` /
 *                `currentAttemptId` are engine bookkeeping and must not become
 *                readable by the expression language.
 * - `run`      — a CLOSED field set describing the current run's identity (see
 *                `RUN_FIELDS`). `${run.<field>}` may read only these names.
 * - `trigger`  — the run's fire-time TRIGGER context (#5 S12), backing
 *                `${trigger.<field>}` over a CLOSED field set (see
 *                `TRIGGER_FIELDS`): `triggerId`, `scheduledTime` (the scheduled
 *                occurrence for a `schedule` fire; `null` otherwise), and `body`
 *                (the webhook/event/run-now payload; `json`, deep-addressable).
 *                Its values are the durable `run.triggerContext` seed FACT folded
 *                into `RunState.triggerContext` — never a fresh read — so every
 *                field is stable across the whole run and identical on replay.
 */
export interface SubstitutionContext {
  params: Record<string, unknown>;
  nodeOutputs: Record<string, Record<string, unknown>>;
  nodeStatuses: Record<string, NodeRunStatus>;
  run: Record<string, unknown>;
  trigger: Record<string, unknown>;
}

/**
 * Raised by `substitute` for any malformed or unresolvable `${...}` at run time
 * (unknown ref, unterminated brace, unknown/arity-bad function, type-invalid
 * function result). Messages are client-safe: they never echo a resolved value,
 * so a secret that somehow reached a context could never leak through an error.
 */
export class SubstituteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubstituteError';
  }
}

/**
 * Raised by `resolveRunParams` when a run's params cannot be resolved:
 * a required param left unset, an override for an undeclared param, or a value
 * that does not match / cannot coerce to its declared type. Client-safe: never
 * echoes a param's value (a misconfigured caller may have pasted a real
 * credential where a secret's label belongs).
 */
export class ParamResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParamResolveError';
  }
}

// ===========================================================================
// P2b — the event-sourced run engine's state, events, and commands (Zod SSOT).
//
// The reducer (`engine/reduce.ts`) is PURE: `reduce(state, event) → { state,
// commands, diagnostics }`. `run_events` (P1a) is the append-only source of
// truth; `RunState` is a projection = fold `reduce` over the log. A COMMAND
// never mutates state — the DRIVER performs it and appends the resulting EVENT,
// and only folding that event changes state (so a crash between "command
// emitted" and "event appended" simply re-emits the command on replay).
// ===========================================================================

/**
 * A single node's execution state within a run.
 * - `pending`    — not yet ready (incoming edges unsatisfied).
 * - `ready`      — the reducer decided to dispatch it (a `dispatchNode` command
 *                  was emitted and its `currentAttemptId` minted) and is awaiting
 *                  the driver's `node.dispatched` event.
 * - `dispatched` — the driver accepted the dispatch (`node.dispatched` folded).
 * - `success` / `failure` — terminal, from `node.succeeded` / `node.failed`.
 * - `skipped`    — an incoming edge became impossible under the join rule.
 * - `waiting`    — a `call_pipeline` node that emitted `startChild` and is
 *                  awaiting its `call.returned` event (P2c).
 * - `retry_pending` — F2b/D4's **HOLD**: a `transient` failure the node's policy
 *                  still has budget for. NON-terminal, which is the whole design
 *                  (see below), and resolved only by a `node.retryDue`.
 * - `wait_pending` — #4 A5/A6's durable **PARK**: a `wait` control node paused on
 *                  S1's alarm. NON-terminal, resolved only by a `timer.due`. It
 *                  is entered by `timer.waitScheduled` — which the driver appends
 *                  AFTER arming the alarm — so a `wait_pending` node ALWAYS has a
 *                  live alarm row (unlike `retry_pending`, entered by `node.failed`
 *                  BEFORE the arm, which is why retry needs a boot re-arm and wait
 *                  does not).
 * - `external_wait_pending` — #4 A13's durable **external PARK**: a `webhook`
 *                  control node paused awaiting an inbound HTTP callback. NON-
 *                  terminal, resolved by `externalWait.completed` (→ `success`) or
 *                  `externalWait.expired` (→ `failure`). Entered by
 *                  `externalWait.created` — appended by the driver AFTER arming the
 *                  expiry alarm + correlation row — so it too ALWAYS has a live
 *                  alarm (the same arm-before-append discipline as `wait_pending`).
 *                  The twin of `wait_pending` with a DIFFERENT resume source (an
 *                  inbound callback, not a timer).
 *
 * `retry_pending`/`wait_pending`/`external_wait_pending` are deliberately ABSENT from
 * `TerminalNodeStatusSchema`, and that single fact is what implements the HOLD/PARK
 * — no new predicate anywhere:
 * `TERMINAL_NODE` excludes it, so `endpointOutcome` returns `null`, every
 * readiness/outcome path treats the node as live, `allTopLevelTerminal` is false
 * (so the run cannot finish while a node is held), a container's
 * `children.every(TERMINAL_NODE)` gate waits for it, and `${nodes.<id>.status}`
 * refuses to read it. See the joint F1b/F2b spec §A.1/§B.1.
 *
 * `attempts` is a monotonic counter minted-from, not random: every dispatch
 * takes `attemptId = \`${nodeId}#${attempts}\`` then increments. A result event
 * whose `attemptId` is not the node's `currentAttemptId` is stale and ignored.
 */
export const NodeRunStatusSchema = z.enum([
  'pending',
  'ready',
  'dispatched',
  'success',
  'failure',
  'skipped',
  'waiting',
  'retry_pending',
  'wait_pending',
  'external_wait_pending',
]);
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>;

/**
 * The TERMINAL subset of `NodeRunStatus` — a node that will never change again.
 * This is one vocabulary serving three consumers, so it lives here rather than
 * in either of them: the reducer's edge/readiness model (`endpointOutcome`), a
 * container's exit gate, and the `${nodes.<id>.status}` expression handle
 * (#6 E3 T6), whose language-level vocabulary is EXACTLY this set.
 *
 * Declared in `types.ts` specifically so `params.ts` can read it: `reduce.ts`
 * already imports `params.ts` (`effectiveEdges`, `backEdgeResetBody`, …), so
 * owning it there and importing it back would be a cycle.
 */
export const TerminalNodeStatusSchema = z.enum(['success', 'failure', 'skipped']);
export type TerminalNodeStatus = z.infer<typeof TerminalNodeStatusSchema>;

/**
 * Runtime membership test for `TerminalNodeStatusSchema`. Derived from the
 * schema's own options rather than hand-listed, so the set and the type can
 * never drift apart.
 */
export const TERMINAL_NODE: ReadonlySet<NodeRunStatus> = new Set<NodeRunStatus>(
  // `satisfies` pins ONLY the subset direction (terminal ⊆ status) — which the
  // surrounding `new Set<NodeRunStatus>(...)` already pins anyway. It catches a
  // terminal option that is not a valid status; it CANNOT catch a valid status
  // that is terminal and was forgotten here.
  //
  // This comment used to claim the opposite ("adding an 8th NodeRunStatus that
  // is terminal, and forgetting it here, is a type error"). That was FALSE —
  // probed: adding a terminal status to `NodeRunStatusSchema` and omitting it
  // below compiles clean. Harmless for F2b's `retry_pending` (non-terminal, and
  // its omission is the DESIGN — see `NodeRunStatusSchema`), but a later fire
  // adding a genuinely terminal status would be trusting a guard that does not
  // exist. `terminalStatusOf` below shows what a real one looks like: an
  // exhaustive `switch` with no `default`. Joint F1b/F2b spec §A.1.
  TerminalNodeStatusSchema.options satisfies readonly NodeRunStatus[],
);

export const NodeRunStateSchema = z.object({
  status: NodeRunStatusSchema,
  attempts: z.number().int().nonnegative(),
  currentAttemptId: z.string().optional(),
  /**
   * F2b — POLICY retries taken for this node in the CURRENT loop round, and the
   * ONLY counter retry-eligibility reads (`retries < policy.retry`).
   *
   * Deliberately NOT `attempts`, which the joint spec's §A.3 rule
   * (`attempts < policy.retry`) named. Two independent defects made that wrong,
   * both probed — see the spec's §A.3 build-time correction:
   *
   *  1. **Off by one.** `attempts` is incremented at DISPATCH (`reduce.ts`
   *     mints `attemptId` from `attempts`, then increments), so it is already 1
   *     at the first `node.failed`. `attempts < retry` therefore delivers
   *     `retry: N` → N total attempts, where F2a's schema contract says
   *     "`retry: 2` = up to 3 attempts" — and makes an explicit `retry: 1`
   *     silently identical to `retry: 0`, the exact confusion §A.3's
   *     absent-vs-explicit-0 rule exists to prevent.
   *  2. **Loop rounds spend the budget.** `attempts` is kept MONOTONIC across a
   *     back-edge reset (§A.6, and correctly so — it is what makes a stale
   *     result from the prior round unfoldable). Keying eligibility on it makes
   *     the retry budget run-LIFETIME: a loop-body node with `retry: 2` retries
   *     in round 1 and, from round 3 on, has none — spent by BOUNCES, not by
   *     failures.
   *
   * A separate counter fixes both at once and keeps §A.6 intact: `attempts`
   * stays monotonic for attempt-id minting, `retries` counts policy retries and
   * is CLEARED by `resetNodes` so every round gets its own budget. It also keeps
   * the rule reading exactly like its English contract ("max retries after the
   * first attempt"), with no off-by-one to re-break.
   *
   * It is incremented ONLY by `node.retryDue`. Boot-recovery's
   * `node.retryRequested` does NOT touch it: re-running a node the crash lost is
   * not a policy retry, and must not consume the operator's budget. That
   * three-way conflation (policy retry / boot retry / loop round) is precisely
   * what `attempts` alone cannot express.
   */
  retries: z.number().int().nonnegative(),
});
export type NodeRunState = z.infer<typeof NodeRunStateSchema>;

/** The run-level lifecycle status (distinct from a node's finer-grained state). */
export const RunLifecycleStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failure',
  'interrupted',
]);
export type RunLifecycleStatus = z.infer<typeof RunLifecycleStatusSchema>;

/**
 * A container's lifecycle state within a run (P2c).
 * - `pending` — not yet entered (its incoming OUTER edges unsatisfied).
 * - `active`  — entered; its children are walking internally.
 * - `success` / `failure` — terminal (from its exit condition, or an unhandled
 *   child failure / a loop hitting `maxRounds` without `exitWhen`).
 * - `skipped` — an incoming OUTER edge became impossible under the join rule.
 *
 * `round` is the 0-based loop round index (a `stage` stays at 0). `outputs` is
 * the container's projected outputs at exit (child outputs merged, sorted).
 */
export const ContainerRunStatusSchema = z.enum([
  'pending',
  'active',
  'success',
  'failure',
  'skipped',
]);
export type ContainerRunStatus = z.infer<typeof ContainerRunStatusSchema>;

export const ContainerRunStateSchema = z.object({
  status: ContainerRunStatusSchema,
  round: z.number().int().nonnegative(),
  outputs: z.record(z.string(), z.unknown()),
  /** Why a container terminated (`capped`, `child_failed`, `exitWhen_error`,
   * `no_progress`, `no_exit_condition`, `timeout`) — observability only; unset
   * while active/pending or on a clean exit. */
  reason: z.string().optional(),
  /**
   * #4 A17 — LOOP only: the epoch-ms instant this loop's wall-clock `timeout`
   * fires, stamped by the `container.timeoutScheduled` fold once the driver armed
   * the alarm. Serves as an operator/audit fact AND the crash-recovery marker:
   * an `active` loop with a `timeout` configured but `timeoutDueAt` UNSET has not
   * yet had its alarm armed (the arm was lost in the enter→arm crash window), so
   * `onResumed` re-emits `scheduleContainerTimeout` for it (idempotent). Unset for
   * a loop with no `timeout`, and for stage/foreach.
   */
  timeoutDueAt: z.number().int().optional(),
  /**
   * FOREACH only (#4 A4): the resolved `items` array, snapshotted at enter so the
   * per-item `${item}` binding and the `results` index are stable for the whole
   * container lifetime (re-derived deterministically on replay — see `reduce.ts`
   * enter path). `round` doubles as the 0-based item index. Unset for loop/stage.
   */
  items: z.array(z.unknown()).optional(),
  /**
   * FOREACH only (#4 A4): the order-stable per-item output accumulator — one
   * entry per COMPLETED item (its projected child outputs), index-aligned with
   * `items`. Projected as the container's `results` output at exit (partial on a
   * mid-iteration child failure). Unset for loop/stage.
   */
  results: z.array(z.unknown()).optional(),
});
export type ContainerRunState = z.infer<typeof ContainerRunStateSchema>;

/**
 * The projection folded from a run's event log. `pending` is the pre-`run.started`
 * seed; `interrupted` is only reachable via the P2d boot reconciler (a
 * non-idempotent node that could not have survived a restart). `outputs` is
 * populated ONLY on `node.succeeded` (partial `node.output` observability events
 * never enter it — no unvalidated/partial data feeds `${}` substitution).
 * `bounces` (per back-edge, keyed by a STABLE `edgeKey`) counts back-edge
 * traversals (P2c); `containers` holds each container's lifecycle state (P2c);
 * `sessions` (agent-session correlation) is defined for P3. All stay `{}` under
 * P2b's acyclic, container-free walk.
 */
/**
 * The run's fire-time TRIGGER context (#5 S12), folded from the durable
 * `run.triggerContext` seed event and read by `${trigger.<field>}`.
 *
 * `triggerId` is the firing trigger — always present, because a context EXISTS
 * only for a trigger-launched run; a run with no trigger (a child `call_pipeline`
 * run, or a pre-S12 log) has `RunState.triggerContext === null` entirely, not a
 * context with a null id. `scheduledTime` is the INTENDED scheduled occurrence
 * (ISO-8601 UTC) for a `schedule` fire — the row's `dueAt`, never the
 * possibly-late actual delivery — and `null` for a manual/webhook/event fire.
 * `body` is the fire payload (webhook/event/run-now); `unknown` so it stays
 * deep-addressable as `json` and carries no static shape.
 *
 * Deliberately NOT `.datetime()` on `scheduledTime` — a durable field with a
 * format enum is a back-compat trap (same reasoning as `run.started.startedAt`).
 */
export const TriggerContextSchema = z.object({
  triggerId: z.string(),
  scheduledTime: z.string().nullable(),
  body: z.unknown(),
});
export type TriggerContext = z.infer<typeof TriggerContextSchema>;

export const RunStateSchema = z.object({
  runId: z.string(),
  pipelineVersionId: z.string(),
  /**
   * When the run started, ISO-8601 UTC — the run-stable timestamp behind
   * `${run.startedAt}` (#6 E3). `null` for a log appended before the fact was
   * carried (see `run.started.startedAt`), and pre-seed.
   */
  startedAt: z.string().nullable(),
  params: z.record(z.string(), z.unknown()),
  status: RunLifecycleStatusSchema,
  nodes: z.record(z.string(), NodeRunStateSchema),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  containers: z.record(z.string(), ContainerRunStateSchema),
  bounces: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * #4 A0 — the business branch each `control` (`if`) node chose, `nodeId →
   * label`, folded from `condition.evaluated`. `edgeState` reads it to satisfy
   * exactly the taken branch edge. Empty for a run with no control node and for
   * a pre-A0 log (which carried no such event), so branch edges from an old doc
   * resolve `unsatisfied-terminal` (dead) deterministically on replay. NOT
   * cleared by `resetNodes` on a loop re-round — a re-skipped `if`'s branch
   * edges resolve `impossible` via the skipped-predecessor rule BEFORE this map
   * is read, so a stale label can never re-satisfy last round's arm.
   */
  branches: z.record(z.string(), z.string()),
  sessions: z.record(z.string(), z.unknown()),
  /**
   * The run's fire-time trigger context (#5 S12), seeded by `run.triggerContext`
   * before `run.started` and carried across the started transition. `null` for a
   * run with no trigger and for a pre-S12 log (which never carried the event), so
   * `${trigger.*}` reads fall back to `null` deterministically on replay.
   */
  triggerContext: TriggerContextSchema.nullable(),
});
export type RunState = z.infer<typeof RunStateSchema>;

/**
 * Terminal run outcome vocabulary. The outcome is binary; WHY carries in the
 * free-text `reason` beside it. The reasons in use, so a reader does not have to
 * grep for them (joint F1b/F2b spec §B):
 *   - `node_failed:<id>` — the blamed node, which may sit far upstream of the
 *     leaf that triggered evaluation.
 *   - `stalled`          — #491: the walk can never finish (no entity can become
 *                          ready, nothing awaits an event). Ids are deliberately
 *                          NOT interpolated: unlike a single blamed node the set
 *                          is unbounded in the doc's size, so it goes to the
 *                          diagnostic and the reason stays a constant — the same
 *                          call `capped` makes.
 *   - `capped`           — the driver's MAX_DRIVER_STEPS fail-safe.
 *   - `invalid_event`    — the reducer refused its own impossible event.
 */
export const RunOutcomeSchema = z.enum(['success', 'failure']);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

/**
 * #1 F0 — the engine's structured failure taxonomy: the RETRY-DECISION axis, and
 * the ONLY thing retry/routing may key off (never `error` TEXT).
 *
 * Deliberately 3-valued, and NOT the same set as the connector adapters'
 * richer 5-kind `ConnectorErrorKind` (`auth`/`rate_limit`/`transient`/
 * `permanent`/`cancelled`). Those are PROVIDER-facing; these are the reducer's
 * decision. The adapter set maps DOWN onto this at the executor seam
 * (`connectors/error-kind.ts`) with the dropped detail preserved losslessly in
 * `code` — e.g. `auth` → `{kind:'permanent', code:'auth'}`, `rate_limit` →
 * `{kind:'transient', code:'rate_limit'}`. Spec #2's error taxonomy fixes that
 * mapping (429 → transient, 401/403 → permanent, abort → cancelled).
 *
 * Keeping the engine set at 3 is what stops the reducer from having to answer a
 * policy question ("is `auth` retryable?") that F2a/F9a own.
 */
export const FailureKindSchema = z.enum(['transient', 'permanent', 'cancelled']);
export type FailureKind = z.infer<typeof FailureKindSchema>;

/**
 * #2 L2 — the completeness axis of a metered provider response. The SSOT for the
 * `activity.metered` event's status field AND the server-side `meterUsage`
 * normalizer, so the literal set is spelled ONCE (mirroring L1's "LLM machinery
 * from one module" decision) — both the shared event schema and the connector
 * layer import it.
 *
 * - `metered` — the provider reported a full, well-formed token count (both input
 *   and output), so the usage fact is complete.
 * - `unknown` — the provider omitted usage, or sent a malformed/partial count, so
 *   the run-cost projection (L6) cannot treat this response as fully accounted.
 *   Whatever partial count WAS present is still stamped (usage is a fact — never
 *   discard a captured token count); the status is what flags the gap.
 * - `unpriced` (#2 L14) — a CLI/subscription response that IS metered (provider,
 *   model, possibly tokens are known) but has NO per-response dollar price BY
 *   DESIGN: a subscription/flat-rate seat covers the call, so there is no unit
 *   price to resolve and the executor stamps NONE of the price fields. Crucially
 *   this is NOT a measurement gap like `unknown` — the cost IS known (there is no
 *   marginal charge) — so the L6 run-cost projection counts it in its OWN bucket
 *   (`unpricedResponseCount`) and does NOT flag the run cost as incomplete.
 *
 * Additive extension — no reshape of a stored `metered`/`unknown` event.
 */
export const MeteringStatusSchema = z.enum(['metered', 'unknown', 'unpriced']);
export type MeteringStatus = z.infer<typeof MeteringStatusSchema>;

/**
 * The `node.failed.code` values the ENGINE itself mints or keys off — one source
 * of truth, so no producer hand-spells a durable identifier.
 *
 * `code` stays an OPEN `z.string()` in the schema on purpose: it is a durable
 * event field, so an enum would be a back-compat trap (an old event carrying a
 * retired code must still parse, and an activity may mint its own provider
 * code). These are just the ones we own.
 */
export const FAILURE_CODES = {
  /** Provider throttled the call (connector `rate_limit`) — a backoff candidate. */
  RATE_LIMIT: 'rate_limit',
  /** Bad/expired credentials (connector `auth`) — permanent until reconfigured. */
  AUTH: 'auth',
  /**
   * RESERVED for #1 D4/F3: the POLICY timeout the driver terminalizes as
   * `node.failed{kind:'transient', code:'timeout'}`. Declared here so F3 cannot
   * mint a rival spelling. NOT an adapter's own internal timeout — that arrives
   * as a plain connector `transient`.
   */
  TIMEOUT: 'timeout',
  /** The adapter's stream ended with no terminal event (contract violation). */
  ADAPTER_NO_TERMINAL: 'adapter_no_terminal',
  /** The adapter threw instead of yielding a terminal `failed` (a bug). */
  ADAPTER_THREW: 'adapter_threw',
  /** The run's doc has no node with the dispatched id. */
  NODE_NOT_FOUND: 'node_not_found',
  /** The node's activity type is absent from the catalog. */
  UNKNOWN_ACTIVITY: 'unknown_activity',
  /** The activity needs a runner the executor does not have. */
  NO_EXECUTOR: 'no_executor',
  /**
   * A CONTROL activity (#1 D6) reached the executor. Control activities are
   * engine-evaluated pure transitions the reducer handles natively, so this is
   * an ENGINE-INVARIANT violation, not a missing runner — categorically
   * different from `NO_EXECUTOR` ("this execution activity has no connector
   * yet"), and kept distinct so an operator can tell a framework bug from an
   * unbuilt feature without string-matching the message.
   */
  CONTROL_NOT_DISPATCHABLE: 'control_not_dispatchable',
  /** The activity requires a connection but the node names none. */
  CONNECTION_MISSING: 'connection_missing',
  /** The node's `connectionId` resolves to no row. */
  CONNECTION_NOT_FOUND: 'connection_not_found',
  /** The bound connection's kind is not one the activity accepts. */
  CONNECTION_KIND_INVALID: 'connection_kind_invalid',
  /** No adapter is registered for the bound connection's kind. */
  NO_ADAPTER: 'no_adapter',
  /** The connection's `secretRef` resolves to no row. */
  SECRET_NOT_FOUND: 'secret_not_found',
  /** The connection's secret exists but could not be decrypted. */
  SECRET_UNDECRYPTABLE: 'secret_undecryptable',
  /**
   * A `{ "$secret": "<name>" }` config-sink marker (item 7 / S3) names a
   * standalone secret that resolves to no row for the run's owner. Distinct from
   * `SECRET_NOT_FOUND` (a CONNECTION credential), so an operator can tell a
   * dangling node-config secret from a dangling connection secret without
   * string-matching. `permanent` — a config typo does not self-heal on retry.
   */
  CONFIG_SECRET_NOT_FOUND: 'config_secret_not_found',
  /**
   * A config-sink secret exists but could not be decrypted (key rotated /
   * ciphertext corrupt). Distinct from `SECRET_UNDECRYPTABLE` for the same
   * connection-vs-config reason. `permanent`; the message NEVER echoes the
   * decrypt error (could leak ciphertext/key detail).
   */
  CONFIG_SECRET_UNDECRYPTABLE: 'config_secret_undecryptable',
  /**
   * #4 A7 — a `fail` control activity FORCE-FAILED the node with its authored
   * `${}` message. Always `permanent` (a deliberate fail is deterministic, so
   * retrying re-fails identically — `retryEligible` never fires on it). A stable
   * marker so the monitor can tell an intentional fail from a connector error
   * without string-matching the message; the node's `type` (`fail`) in the log
   * says the same, so this is a convenience, not the sole signal.
   */
  FORCED_FAIL: 'forced_fail',
} as const;

/**
 * The durable facts the driver/reconciler append to `run_events`; folding them
 * through `reduce` is the ONLY way state changes. Every attempt-bearing event
 * carries its `attemptId` for stale-rejection. `run.resumed` /
 * `node.retryRequested` are the ENGINE-decision (retry) variants the P2d boot
 * reconciler will emit — the reducer HANDLES them here (a fresh dispatch with a
 * new attempt), kept distinct from the driver-accepted `node.dispatched`.
 * `call.returned` (P2c) resolves a `waiting` `call_pipeline` node.
 */
export const EngineEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    runId: z.string(),
    pipelineVersionId: z.string(),
    /**
     * When the run started, ISO-8601 UTC — the LOGGED FACT behind
     * `${run.startedAt}` (#6 E3). It lives in the PAYLOAD, not the envelope's
     * `ts` column, because `reduce` folds payloads only: reading the envelope
     * would mean widening the reducer's contract, and the CP1 invariant is that
     * a pure fold of the payload log IS the state. Stamped by the driver from
     * the run ROW (`runs.started_at`), never from a fresh clock — one named fact
     * must not have two durable answers, and the reducer must stay clock-free
     * so replay is deterministic.
     *
     * OPTIONAL for durable back-compat: `run.started` rows appended before E3
     * carry no stamp and MUST still parse on replay (they fold to `null`).
     * Deliberately NOT `.datetime()` — a durable field with a format enum is a
     * back-compat trap, the same reasoning `node.failed.code` records below.
     */
    startedAt: z.string().optional(),
    /** Already-resolved run params (post `resolveRunParams`, secrets stripped). */
    params: z.record(z.string(), z.unknown()),
  }),
  // #5 S12 — the durable fire-time TRIGGER context. Appended by the driver
  // BEFORE `run.started` (it folds into the `pending` seed, so a root node's
  // config can read `${trigger.*}` on the very first dispatch), and ONLY for a
  // trigger-launched run — a child `call_pipeline` run carries none, so
  // `RunState.triggerContext` stays `null` and `${trigger.*}` resolves `null`.
  // `scheduledTime`/`body` are OPTIONAL (a manual fire carries neither) and fold
  // to `null`; deliberately NOT `.datetime()` on `scheduledTime` for the same
  // durable-back-compat reason as `run.started.startedAt`.
  z.object({
    type: z.literal('run.triggerContext'),
    runId: z.string(),
    // Non-nullable: the driver appends this ONLY for a trigger-launched run and
    // always with `trigger.id`. A run with no trigger emits no event at all, so a
    // null id is unreachable — the schema states that rather than admitting a
    // dead branch.
    triggerId: z.string(),
    scheduledTime: z.string().optional(),
    body: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('node.dispatched'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    /** Decided at dispatch time from the P3 catalog and PERSISTED here; the boot
     * reconciler reads this flag from the event log, never recomputes it. */
    idempotent: z.boolean(),
  }),
  z.object({
    type: z.literal('node.succeeded'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    outputs: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('node.failed'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    /** Human-readable detail. NEVER parsed for control flow — that is `kind`. */
    error: z.string(),
    /**
     * #1 F0 — the machine-readable failure class. `.default('permanent')` is
     * the parse boundary for events stored BEFORE this field existed: safe,
     * because `permanent` never retries. Note `EngineEvent` is the z.infer
     * OUTPUT type, so the default does NOT let a new producer omit `kind` —
     * every construction site must state it, which is the point.
     */
    kind: FailureKindSchema.default('permanent'),
    /** Optional machine detail (see `FAILURE_CODES`); an open vocabulary. */
    code: z.string().optional(),
    /**
     * #2 L7 — a provider-instructed backoff (whole seconds), parsed from a
     * `Retry-After` header on a retryable LLM failure (429/503). When present on a
     * `transient` failure the reducer copies it onto the `scheduleRetry` command,
     * and the driver arms the retry alarm at `now + retryAfterSeconds` INSTEAD of
     * `policy.retryIntervalSeconds` — the provider knows its own reset window. A
     * durable, event-frozen fact (captured once, impurely, in the adapter): the
     * reducer only reads it, so replay is deterministic. `.max` mirrors the policy
     * `retryIntervalSeconds` ceiling as defence-in-depth — the adapter already
     * clamps (`MAX_RETRY_AFTER_SECONDS`), this rejects a hand-forged event too.
     * Ignored on any non-`transient` failure (which never retries).
     */
    retryAfterSeconds: z.number().int().positive().max(MAX_RETRY_INTERVAL_SECONDS).optional(),
  }),
  z.object({
    /**
     * #4 A0/A1 — a `control` activity (`if`) evaluated its `${}` condition and
     * chose a business `branch`. The DURABLE fact `edgeState` reads to satisfy
     * exactly the taken branch edge (`state.branches[nodeId] === edge.branch`);
     * the other arms fall `unsatisfied-terminal` and skip. This is the codex-
     * hardened "the decision is a fact in the LOG before the downstream walk
     * depends on it" rule (#4 spec) — the reducer never re-evaluates the
     * condition against (possibly drifted) state, it reads the logged label, so
     * replay is deterministic.
     *
     * Appended by the DRIVER (`pump`) in response to the reducer's own
     * `evaluateControl` command — the same driver-own, no-executor,
     * append-then-fold shape as `scheduleRetry` → `node.retryScheduled`. NOT
     * emitted by any connector; a control activity is engine-evaluated and never
     * dispatched (the executor refuses one, `CONTROL_NOT_DISPATCHABLE`).
     *
     * `branch` is the STRING label (`'true'`/`'false'` for `if`), matching
     * `BranchEdgeSchema.branch` (`z.string()`) — never a raw boolean, so the
     * `===` against the edge's declared label holds. `attemptId` is the if
     * node's current attempt, so a stale event (a pre-restart evaluation) is
     * ignored exactly as `node.succeeded` is.
     */
    type: z.literal('condition.evaluated'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    branch: z.string(),
  }),
  z.object({
    /**
     * #4 A2 — a `control` `switch` matched its `${}` `on` value against the
     * declared `cases` and chose a named-case (or `default`) `branch`. IDENTICAL
     * durable-fact role + shape to `condition.evaluated` (an `if`), and folded by
     * the same handler; a DISTINCT event type only so the log/monitor can tell a
     * value-match decision from a boolean one (spec #4's codex-hardened block
     * lists `switch.evaluated` separately from `condition.evaluated`). Appended by
     * the DRIVER (`pump`) in response to the reducer's `evaluateControl` command,
     * whose `event` discriminant names exactly this type. `branch` is the matched
     * case label or `'default'`; `attemptId` is the switch node's current attempt,
     * so a stale event (a pre-restart evaluation) is ignored.
     */
    type: z.literal('switch.evaluated'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    branch: z.string(),
  }),
  z.object({
    // A spawned `call_pipeline` child returned. `childOutcome` may be `failure`
    // and STILL carry projected `outputs` (the findings loop). Stale-rejected
    // like any attempt-bearing result: an `attemptId` that is not the call
    // node's current attempt is ignored (a pre-restart child result).
    type: z.literal('call.returned'),
    runId: z.string(),
    callNodeId: z.string(),
    attemptId: z.string(),
    childRunId: z.string(),
    childOutcome: RunOutcomeSchema,
    outputs: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('run.finished'),
    runId: z.string(),
    outcome: RunOutcomeSchema,
    reason: z.string().optional(),
  }),
  z.object({
    // Observability/streaming ONLY — never enters `outputs` or substitution.
    type: z.literal('node.output'),
    runId: z.string(),
    nodeId: z.string(),
    name: z.string(),
    value: z.unknown(),
  }),
  z.object({
    /**
     * #2 L2 — a metering FACT captured PER provider response: the token usage of
     * one `llm_call` (anthropic/openai/ollama) dispatch, stamped into the log at
     * dispatch time and NEVER recomputed (replay folds the fact, it does not re-
     * call the model — spec #2's replay invariant). Emitted by the adapter as a
     * non-terminal `metered` ActivityEvent (mirroring `node.output`) which the
     * executor maps here, ordered BEFORE the terminal `node.succeeded`.
     *
     * OBSERVABILITY ONLY — the reducer folds it INERT (like `node.output`): usage
     * is telemetry, not a typed `${}`-addressable output, so it never enters
     * `outputs` and cannot change run semantics. It is NOT ridden on
     * `node.succeeded` deliberately: that event carries the node's declared typed
     * outputs (`validateOutputs`), and metering is per-RESPONSE, not per-node — a
     * granularity L4c's repair sub-call (two billed responses, one node) and L7's
     * failed-but-billed response both need. A dedicated event is the shape those
     * extend; overloading `node.succeeded` would force a migration later.
     *
     * The L2/L5 SPLIT: L2 introduced this carrier PRICE-LESS (`provider`/`model`/
     * token counts/`meteringStatus`); L5 EXTENDS it ADDITIVELY with the PRICE
     * fields below (`inUnitPrice`/`outUnitPrice`/`costEstimate`/
     * `priceTableVersion`) + the price table, and L6 SUMS the stamped
     * `costEstimate` for the run-cost projection. Introducing the carrier at L2
     * (not L5) was correct sequencing: run_events are immutable, so an L2-era
     * run's usage had to land in the summable shape then or be stranded forever —
     * and the price fields being OPTIONAL keeps those L2-era events valid.
     * `providerRequestId` (a usage fact for crash-window reconciliation, not a
     * price) remains a conscious deferral — the event extends to it additively too.
     */
    type: z.literal('activity.metered'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    /** The provider that billed — the Connection kind (`anthropic_api`/…). */
    provider: z.string(),
    /** The resolved model this response was produced by. */
    model: z.string(),
    /**
     * Input/prompt + output/completion token counts. OPTIONAL: a provider (or an
     * OpenAI-compatible gateway) may omit `usage`, or send a partial/malformed
     * count — then the present count (if any) is stamped and `meteringStatus` is
     * `unknown`. A well-formed pair sets `meteringStatus:'metered'`.
     */
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    meteringStatus: MeteringStatusSchema,
    /**
     * #2 L5 — the PRICE fields, stamped from the model price table AT capture
     * time (immutable: a later price change never edits a past run's cost). All
     * OPTIONAL and FAIL-CLOSED:
     * - `inUnitPrice`/`outUnitPrice` (USD per 1M tokens) + `priceTableVersion`
     *   are stamped IFF a price was resolved for `(provider, model)`; a model
     *   with no known price leaves ALL FOUR absent (never a zero — an absent
     *   price stays visible so L6 can flag run-cost incompleteness, the #473/F13a
     *   fail-open lesson).
     * - `costEstimate` (USD, raw/unrounded — L6 owns display) is stamped IFF a
     *   price was resolved AND both token counts are present (equivalently
     *   `meteringStatus === 'metered'` under `meterUsage`, which sets that status
     *   iff both counts are valid). So `costEstimate` present ⟺ a trustworthy full
     *   cost; its absence (unpriced model OR incomplete usage) is the run-cost
     *   completeness signal.
     */
    inUnitPrice: z.number().nonnegative().optional(),
    outUnitPrice: z.number().nonnegative().optional(),
    costEstimate: z.number().nonnegative().optional(),
    priceTableVersion: z.string().optional(),
  }),
  z.object({
    /**
     * #2 L9a — a debugging CAPTURE FACT for ONE `llm_call` provider response: the
     * prompt/completion SHAPE + the provider-call latency, stamped into the log at
     * dispatch time and NEVER recomputed (replay folds the fact, it does not re-
     * call the model — spec #2's replay invariant). Emitted by the adapter as a
     * non-terminal `captured` ActivityEvent (mirroring `metered`) which the
     * executor maps here, ordered BEFORE the terminal `node.succeeded`/`node.failed`.
     * ONE per provider response — a text call emits one; a structured-repair call's
     * per-response capture is deferred to L9b (see below).
     *
     * OBSERVABILITY ONLY — the reducer folds it INERT (like `activity.metered` /
     * `node.output`): capture is telemetry, not a typed `${}`-addressable output,
     * so it never enters `outputs` and cannot change run semantics. NOT in
     * `TERMINAL_RUN_EVENT_TYPES`.
     *
     * SECURE / F4 SPLIT — this is the "redacted" default the spec's telemetry-vs-
     * content hardening prescribes: "log hash/length/token-count, not text". It
     * carries NO raw prompt/completion text. `chars` is the LENGTH half; the
     * TOKEN-COUNT half lives on `activity.metered` (`inputTokens`/`outputTokens`).
     * `contentHash` is a `sha256` FINGERPRINT for drift/reproducibility, NOT a
     * redaction guarantee (a short/low-entropy input is a brute-forceable oracle) —
     * safe here only because no field is D8-secure yet. RAW-content ('full' mode)
     * capture + verbose reasoning-trace capture BOTH require F4's field-secure model
     * (`secureInputFields`/`secureOutputFields`, redacted-when-set) and are DEFERRED
     * to L9b; structured-mode per-response capture defers there too (its completion
     * IS raw structured content, F4-gated; its request half is F4-independent but
     * deferred with it for plumbing cohesion). See L9b (#605).
     */
    type: z.literal('activity.captured'),
    runId: z.string(),
    nodeId: z.string(),
    attemptId: z.string(),
    /** The provider that produced this response — the Connection kind. */
    provider: z.string(),
    /** The resolved model this response was produced by. */
    model: z.string(),
    /** Provider-call wall time in ms (the spec's always-on `latency` telemetry). */
    latencyMs: z.number().int().nonnegative(),
    /** The prompt SHAPE (fingerprints + lengths, no text). */
    request: z.object({
      /** Number of user/assistant turns (the `system` instruction is separate). */
      messageCount: z.number().int().nonnegative(),
      /** Present IFF a system instruction was sent. */
      system: z
        .object({ chars: z.number().int().nonnegative(), contentHash: z.string() })
        .optional(),
      messages: z.array(
        z.object({
          role: z.enum(['user', 'assistant']),
          chars: z.number().int().nonnegative(),
          contentHash: z.string(),
        }),
      ),
    }),
    /**
     * The completion SHAPE. ABSENT when no completion text was extracted (a
     * transport/HTTP/no-completion failure) — fail-closed: an absent completion is
     * absent, NEVER a hash of `''` (which would manufacture a benign fact, the
     * `#473`/fail-open lesson).
     */
    completion: z
      .object({ chars: z.number().int().nonnegative(), contentHash: z.string() })
      .optional(),
  }),
  z.object({
    type: z.literal('run.resumed'),
    runId: z.string(),
    reason: z.literal('boot_reconcile'),
  }),
  z.object({
    type: z.literal('node.retryRequested'),
    runId: z.string(),
    nodeId: z.string(),
    previousAttemptId: z.string(),
    reason: z.string(),
  }),
  z.object({
    /**
     * F2b/F2c (D4) — the durable fact that a held node's retry has been ARMED.
     * Appended by the DRIVER once S1's alarm row exists, so the log records
     * WHEN the next attempt is due rather than leaving it in an ephemeral timer.
     *
     * Folding it is an inert no-op: the node is already `retry_pending` and the
     * reducer must not read a clock. It exists for the LOG — the durable, audit-
     * able answer to "when is this retry due" — and because §A.2 forbids shipping
     * a partial triple. NOT to drive state.
     *
     * Nothing reads `nextAttemptAt` back today, and that is worth saying plainly
     * rather than implying a consumer: the driver WRITES it (`armRetry`), the boot
     * reconciler WRITES another when it re-arms a hold whose row was lost, and the
     * run's raw event feed renders it. The alarm row — not this event — is what
     * actually fires the retry and what the reconciler checks. So this is an
     * operator/audit fact; if it ever disagrees with the row, the ROW is right.
     * (The monitor's per-node activity summary does not fold it at all yet —
     * `web/…/runSummary.ts`, tracked in #483 — so a held node renders as failed
     * for the retry interval; only the raw feed shows it.)
     *
     * `nextAttemptAt` is a STORED fact (epoch ms), never recomputed at fold
     * time — that is what keeps replay deterministic (spec #5's spike block).
     * The driver stamps it from the ARMED ROW's `dueAt`, not from a fresh
     * computation, so a replayed arm logs the ORIGINAL due time.
     */
    type: z.literal('node.retryScheduled'),
    runId: z.string(),
    nodeId: z.string(),
    /** The FAILED attempt this retry answers (the alarm's freshness handle). */
    attemptId: z.string(),
    nextAttemptAt: z.number().int(),
  }),
  z.object({
    /**
     * F2b/F2c (D4) — the held node's retry is DUE. Appended by the alarm clock's
     * `node_retry` handler when S1's row comes due; folding it re-dispatches the
     * node under a NEW attempt.
     *
     * DISTINCT from `node.retryRequested` (D4 says so explicitly): that one is
     * the BOOT reconciler's crash-recovery decision and is guarded on
     * `LIVE_NODE`; this one is the POLICY retry and is guarded on
     * `retry_pending`. Only this one consumes the policy's retry budget.
     */
    type: z.literal('node.retryDue'),
    runId: z.string(),
    nodeId: z.string(),
    previousAttemptId: z.string(),
  }),
  z.object({
    /**
     * #4 A5/A6 — the durable fact that a `wait` control node has PARKED on S1's
     * alarm. Appended by the DRIVER once the alarm row exists (`armWait`), so the
     * log records WHEN the wait is due rather than leaving it in an ephemeral
     * timer. Named per the spec's `timer.*` family (A5). The reusable A5 PRIMITIVE
     * is the durable alarm + arm-before-append ordering, which A17's `until`-timeout
     * also consumes (spec line 77) — but its FOLD here is wait-specific (`ready` →
     * `wait_pending`), so A17 arms the same alarm with its own due event/fold rather
     * than reusing `timer.due`'s wait-node transition.
     *
     * Folding it TRANSITIONS the node `ready` → `wait_pending` (unlike
     * `node.retryScheduled`, which is inert because `node.failed` already entered
     * the hold). That ordering is load-bearing: the arm precedes this append, so a
     * `wait_pending` node always has a live alarm and needs no boot re-arm.
     *
     * `dueAt` is a STORED fact (epoch ms), stamped from the ARMED ROW's `dueAt`,
     * never recomputed at fold time — replay-deterministic (spec #5's spike block),
     * exactly as `node.retryScheduled.nextAttemptAt` is. The reducer does not read
     * it back (the alarm ROW fires the timer); it is the operator/audit fact for
     * "when does this wait end".
     */
    type: z.literal('timer.waitScheduled'),
    runId: z.string(),
    nodeId: z.string(),
    /** The attempt this timer parks (the alarm's freshness handle). */
    attemptId: z.string(),
    dueAt: z.number().int(),
  }),
  z.object({
    /**
     * #4 A5/A6 — the parked WAIT node's timer is DUE. Appended by the alarm clock's
     * `node_wait` handler when S1's row comes due; folding it completes the wait
     * (`wait_pending` → `success`, empty outputs). The `timer.*` twin of
     * `node.retryDue` — but where `retryDue` re-dispatches, `timer.due` SUCCEEDS
     * (a wait has nothing to re-run). Guarded on `wait_pending` at the parked
     * attempt, so an at-least-once redelivery — or a `timer.due` for anything that
     * is NOT a parked wait node — folds as a no-op. That guard is why this event is
     * WAIT-specific despite the generic name: a future timer consumer (A17's
     * `until`-timeout, on a container) does not reuse this fold — it arms the same
     * A5 alarm but appends its own due event with its own transition.
     */
    type: z.literal('timer.due'),
    runId: z.string(),
    nodeId: z.string(),
    previousAttemptId: z.string(),
  }),
  z.object({
    /**
     * #4 A13 — the durable fact that a `webhook` control node has PARKED awaiting
     * an inbound HTTP callback. Appended by the DRIVER once the expiry alarm row +
     * the correlation row exist (`armExternalWait`), so the log records WHEN the
     * wait expires. The external-wait twin of `timer.waitScheduled`, and like it
     * NOT inert: its fold TRANSITIONS the node `ready` → `external_wait_pending`.
     *
     * The correlation TOKEN is DELIBERATELY NOT carried here. `run_events` is
     * served raw (`GET /api/runs/:id/events`), streamed over the P6 WS feed and
     * fanned out on the bus — a bearer capability in that log would be a plaintext
     * credential exposed for the life of the run and forever after. The token is
     * instead DERIVED deterministically server-side (`HMAC(masterKey,
     * runId|nodeId|attemptId)`, the `deterministicChildRunId` pattern) so it is
     * re-derivable on demand from an owner-scoped endpoint and never persisted raw
     * (only its `sha256` hash, in the correlation row, for the inbound lookup).
     *
     * `dueAt` is a STORED fact (epoch ms), stamped from the ARMED ROW's `dueAt`,
     * never recomputed at fold time — replay-deterministic, exactly as
     * `timer.waitScheduled.dueAt` is. The arm precedes this append, so an
     * `external_wait_pending` node always has a live expiry alarm.
     */
    type: z.literal('externalWait.created'),
    runId: z.string(),
    nodeId: z.string(),
    /** The attempt this external wait parks (the alarm/correlation freshness handle). */
    attemptId: z.string(),
    dueAt: z.number().int(),
  }),
  z.object({
    /**
     * #4 A13 — the parked `webhook` node's inbound callback ARRIVED. Appended by
     * the `POST /api/external-wait/:token` route once it has authenticated the
     * capability token and correlated it to this parked (runId, nodeId, attemptId).
     * Folding it completes the wait (`external_wait_pending` → `success`). The
     * external-wait twin of `timer.due`: where `timer.due` fires from an alarm,
     * this fires from an HTTP request. Guarded on `external_wait_pending` at the
     * parked attempt, so an at-least-once / replayed callback folds as a no-op (the
     * second layer behind the route's own row-status guard).
     *
     * #4 A16 — `outputs` carries the inbound callback body's TYPED, declared-key
     * FILTERED payload (ADF `reportStatusOnCallBack`). It is validated + filtered
     * at the HTTP BOUNDARY (`checkInboundOutputs`) against the webhook's
     * `config.outputs` contract BEFORE this event is appended, so only declared,
     * correctly-typed keys ever enter the raw-served run_events log — never the
     * correlation token (still absent, see `externalWait.created`) and never an
     * undeclared external key. `optional` for back-compat: a pre-A16 completion
     * event carries none, and the fold defaults it to `{}` (empty outputs, the A13
     * behaviour). The fold re-filters through `storeOutputs` against the immutable
     * version so a hand-crafted event cannot inject an undeclared refable key.
     */
    type: z.literal('externalWait.completed'),
    runId: z.string(),
    nodeId: z.string(),
    previousAttemptId: z.string(),
    outputs: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    /**
     * #4 A13 — the parked `webhook` node's expiry alarm fired before any callback
     * arrived. Appended by the alarm clock's `node_external_wait` handler when S1's
     * expiry row comes due; folding it FAILS the node (`external_wait_pending` →
     * `failure`) then `settle`s, so the node's `failure` edge routes the timeout /
     * default path (or the run fails blaming it). Distinct from
     * `externalWait.completed` for observability (the spec names it) and because a
     * parked node is NOT `LIVE_NODE`, so `onFailed` (which guards on `LIVE_NODE`)
     * cannot reach it — this fold is the external-wait's own terminal transition.
     * A timeout is a PERMANENT failure (never policy-retried): the `failure` edge is
     * the configurable escape hatch, matching A7 `fail`'s permanence. Guarded on
     * `external_wait_pending` at the parked attempt (at-least-once redelivery, or an
     * alarm for a node that already completed / reset, folds as a no-op).
     */
    type: z.literal('externalWait.expired'),
    runId: z.string(),
    nodeId: z.string(),
    previousAttemptId: z.string(),
  }),
  z.object({
    /**
     * #4 A17 — the durable fact that a `loop` container's WALL-CLOCK timeout has
     * been armed on S1's alarm. Appended by the DRIVER once the alarm row exists
     * (`armContainerTimeout`), so the log records WHEN the loop times out. The
     * CONTAINER twin of `timer.waitScheduled`: it consumes the same A5 primitive
     * (durable alarm + arm-before-append), but where a wait PARKS a node, this
     * one parks NOTHING — the loop stays `active` and its children keep running.
     * Its fold only STAMPS `timeoutDueAt` onto the container's run-state, which
     * serves two purposes: an operator/audit fact ("when does this loop time
     * out"), and the crash-recovery marker `onResumed` reads to tell an
     * already-armed loop from one whose arm was lost in the enter→arm window.
     *
     * `dueAt` is a STORED fact (epoch ms), stamped from the ARMED ROW's `dueAt`,
     * never recomputed at fold time — replay-deterministic, exactly as
     * `timer.waitScheduled.dueAt` is. The arm precedes this append, so a loop that
     * records this event always has a live alarm.
     */
    type: z.literal('container.timeoutScheduled'),
    runId: z.string(),
    containerId: z.string(),
    dueAt: z.number().int(),
  }),
  z.object({
    /**
     * #4 A17 — a `loop` container's wall-clock timeout ELAPSED while it was still
     * `active`. Appended by the alarm clock's `container_timeout` handler when S1's
     * row comes due; folding it NEUTRALIZES the loop's still-live children (so a
     * late child result cannot re-animate a node under an exited container) then
     * FAILS the container (`active` → `failure`, reason `timeout`) and `settle`s,
     * so the container's outer failure edge routes. The CONTAINER twin of
     * `timer.due`, but where `timer.due` SUCCEEDS a wait node, this FAILS a
     * container — a timeout is the loop's safety net, not a happy path. Guarded on
     * the container being `active`, so an at-least-once redelivery, or a timeout
     * for a loop that already exited via `exitWhen`/`maxRounds`/a child failure,
     * folds as a no-op (the second layer behind the handler's own `active` guard).
     */
    type: z.literal('container.timedOut'),
    runId: z.string(),
    containerId: z.string(),
  }),
  z.object({
    // The event-sourced representation of the boot reconciler's "this run
    // cannot be safely resumed" verdict (P2d). Appended when a run had a
    // NON-idempotent activity in flight at crash time (an LLM call that may
    // already be billed, an `agent_cli` subprocess) — re-running it could
    // double-execute a side effect, so the run is frozen `interrupted` /
    // needs-attention rather than silently resumed. Folding it is the ONLY way
    // `RunState.status` becomes `interrupted`, so the projection and the
    // durable log never disagree (the projection is never patched out-of-band).
    type: z.literal('run.interrupted'),
    runId: z.string(),
    reason: z.string(),
  }),
]);
export type EngineEvent = z.infer<typeof EngineEventSchema>;

/**
 * The event types that record a run's TERMINAL fact — the SSOT, declared as one
 * list so the set and the mapping below cannot drift apart.
 *
 * #443 makes this load-bearing: the LOG is authoritative over the projection for
 * terminality, so "which events are terminal" decides whether a crash survivor is
 * re-driven (re-executing side effects) or merely re-synced. Before this it was
 * hard-coded in four separate places.
 */
const TERMINAL_RUN_EVENT_TYPES = ['run.finished', 'run.interrupted'] as const;

/** The terminal-run-event variants of `EngineEvent`, derived from the one list. */
type TerminalRunEvent = Extract<EngineEvent, { type: (typeof TERMINAL_RUN_EVENT_TYPES)[number] }>;

/**
 * Runtime membership test for "this event type records a terminal run fact".
 * Typed over `EngineEvent['type']`; widen to `ReadonlySet<string>` to test a
 * durable envelope's `type` column (as `TERMINAL_RUN`'s callers already do).
 */
export const TERMINAL_RUN_EVENT: ReadonlySet<EngineEvent['type']> = new Set(
  TERMINAL_RUN_EVENT_TYPES,
);

/**
 * The lifecycle status an event RECORDS as a durable fact, or `null` if it is not
 * a terminal run event.
 *
 * This is the SSOT for the terminal-event SET and for the LOG's reading of it —
 * NOT for `reduce.ts`'s `run.finished` transition, which sits behind an
 * impossibility check and so is deliberately conditional where this is not. The
 * distinction is the point of #443: this answers "what fact does the log record",
 * the reducer answers "what does the CURRENT semantics make of it", and when they
 * disagree on an old log the log wins.
 *
 * Guards, and EXACTLY what each covers — the two drift directions are not equally
 * protected, so do not read one as the other:
 *   - Adding a type to `TERMINAL_RUN_EVENT_TYPES` and not mapping it below is a
 *     COMPILE error (the `switch` is exhaustive over `TerminalRunEvent` with no
 *     default). A real guard, unlike `TERMINAL_NODE`'s `satisfies` above, which
 *     only pins the subset direction — see the joint F1b/F2b spec §A.1.
 *   - Adding a terminal variant to `EngineEventSchema` and FORGETTING this list is
 *     NOT a compile error — it silently reads as non-terminal, which is #443's own
 *     failure mode. That direction is caught only by the count assertion in
 *     `__tests__/terminal-run-event.test.ts`; keep it.
 */
export function terminalStatusOf(event: EngineEvent): RunLifecycleStatus | null {
  if (!(TERMINAL_RUN_EVENT as ReadonlySet<string>).has(event.type)) return null;
  const terminal = event as TerminalRunEvent;
  switch (terminal.type) {
    case 'run.finished':
      // Returned directly, NOT via a `success ? : failure` ternary: `RunOutcome`
      // is a subset of `RunLifecycleStatus`, so if it ever gains a third member
      // this is a compile error, where the ternary would silently map it to
      // `failure`. (`reduce.ts`'s own transition does the same.)
      return terminal.outcome;
    case 'run.interrupted':
      return 'interrupted';
  }
}

/**
 * Requests from the reducer to the driver. A command NEVER changes state — the
 * driver performs it and appends the resulting event. `startChild` (P2c) asks
 * the driver to spawn a `call_pipeline` child; the reducer awaits a
 * `call.returned` event before the call node leaves `waiting`.
 */
export const EngineCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dispatchNode'),
    nodeId: z.string(),
    attemptId: z.string(),
    preparedInput: z.record(z.string(), z.unknown()),
    /**
     * #2 L13a — the node's `connectionId` after the reducer resolved its `${}`
     * expression against the run env (a literal id passes through unchanged;
     * `undefined` when the node carries no `connectionId`). The executor consumes
     * THIS, never `node.connectionId` — the raw field may be a `${}` template the
     * executor has no run env to resolve. Like every field of a command, it is
     * EPHEMERAL (re-derived on each reduce, never persisted in `run_events`), so
     * adding it carries no replay/migration concern.
     */
    resolvedConnectionId: z.string().optional(),
  }),
  z.object({
    // Spawn a `call_pipeline` child. `childRunId` is DETERMINISTIC from
    // (parent runId + callNodeId + attempt) so a crash-replay re-emits the SAME
    // command and the driver's child creation is idempotent (CP1 Q1).
    type: z.literal('startChild'),
    callNodeId: z.string(),
    attemptId: z.string(),
    childRunId: z.string(),
    /** Resolved literal id (a `${}` ref in the call config is substituted first). */
    pipelineVersionId: z.string(),
    params: z.record(z.string(), z.unknown()),
  }),
  z.object({
    /**
     * F2b (D4) — "this node's `transient` failure is retry-eligible; arm its
     * alarm." The reducer's half of the pure/impure split: it decides ELIGIBLE
     * (a pure read of the bound version's `policy` + the node's `retries`), the
     * DRIVER decides WHEN (against a real clock) and appends
     * `node.retryScheduled` → later `node.retryDue`.
     *
     * Shape is spec-verbatim (#1 D4 and joint spec §A.2). The STATIC interval is
     * NOT carried: the driver reads `policy.retryIntervalSeconds` from the same
     * IMMUTABLE bound version the reducer read, so the two cannot disagree and the
     * reducer stays clock-free.
     *
     * #2 L7 — `retryAfterSeconds` IS carried when present: it is a PROVIDER hint
     * frozen on the durable `node.failed` event (a `Retry-After` header), not a
     * doc field, so — exactly like `scheduleWait.seconds` (a `${}`-resolved
     * duration the reducer must compute) — only the value threaded through the
     * command carries it to the driver, which prefers it over the policy interval.
     * The reducer stays clock-free: it copies an already-frozen number, reads no
     * clock. Absent → the driver falls back to the policy interval.
     */
    type: z.literal('scheduleRetry'),
    nodeId: z.string(),
    failedAttemptId: z.string(),
    retryAfterSeconds: z.number().int().positive().max(MAX_RETRY_INTERVAL_SECONDS).optional(),
  }),
  z.object({
    /**
     * #4 A0/A1/A2 — "this `control` node (an `if` or a `switch`) evaluated to
     * `branch`; make the fact durable." The reducer computes the branch PURELY
     * (it holds the node's config + a clock-free eval of the `${}` condition/`on`
     * over run state, exactly as `call_pipeline` resolves its `${}`
     * pipelineVersionId), then hands the driver this command; the driver appends
     * the event named by `event` (`condition.evaluated` for an `if`,
     * `switch.evaluated` for a `switch`) and folds it.
     *
     * `event` is a REQUIRED discriminant (no `.default()` — a silent default here
     * would let a producer emit the wrong event type): both construction sites
     * (dispatch-prep + crash-recovery re-emit) must state which durable event the
     * control node's evaluation makes. The two event types fold identically
     * (`onControlBranchEvaluated`); the discriminant only tells the driver's pump
     * which `type` to append and preserves the log's if-vs-switch distinction.
     *
     * A driver-OWN command like `scheduleRetry` — it needs no executor and no
     * connector (the driver's `pump` routes it to a synchronous single-event
     * append, NOT `executor.perform`). `ExecutorCommand` deliberately excludes
     * it, so forgetting the pump branch is a COMPILE error.
     */
    type: z.literal('evaluateControl'),
    nodeId: z.string(),
    attemptId: z.string(),
    branch: z.string(),
    event: z.enum(['condition.evaluated', 'switch.evaluated']),
  }),
  z.object({
    /**
     * #4 A7 — "this `control` `fail` node force-fails; make its failure durable."
     * A driver-OWN command like `evaluateControl` (no executor, no connector — the
     * driver's `pump` routes it to a synchronous single-event append). The reducer
     * resolves the `${}` `message` PURELY (clock-free over run state, exactly as
     * `evaluateControl` resolves its branch) into `error`, holds the node `ready`,
     * and hands the driver this command; the driver appends `node.failed` with
     * this `error`, `kind:'permanent'` and `code:'forced_fail'` (both fixed — a
     * deliberate fail is deterministic and never retry-eligible) and folds it via
     * the SAME `onFailed` handler a connector failure reaches.
     *
     * `ExecutorCommand` deliberately excludes it (it is not `dispatchNode`/
     * `startChild`), so forgetting the pump branch is a COMPILE error. The
     * `attemptId` is the fail node's current attempt, so a stale re-emit (a
     * pre-restart evaluation) folds as a stale/terminal no-op.
     */
    type: z.literal('failNode'),
    nodeId: z.string(),
    attemptId: z.string(),
    error: z.string(),
  }),
  z.object({
    /**
     * #4 A8 — "this `control` `filter` node succeeds; make its output durable." A
     * driver-OWN command like `evaluateControl`/`failNode` (no executor, no
     * connector — the driver's `pump` routes it to a synchronous single-event
     * append). The reducer resolves `items`+`predicate` PURELY (composing them into
     * the inert `filter(items, predicate)` closed-fn over run state, exactly as
     * `evaluateControl` resolves its branch) into the filtered `outputs`, holds the
     * node `ready`, and hands the driver this command; the driver appends
     * `node.succeeded` with these `outputs` and folds it via the SAME `onSucceeded`
     * handler a dispatched node's success reaches (a `ready` node IS `LIVE_NODE`),
     * so the declared-output contract (`validateOutputs`/`storeOutputs`) applies
     * unchanged.
     *
     * `ExecutorCommand` deliberately excludes it (it is not `dispatchNode`/
     * `startChild`), so forgetting the pump branch is a COMPILE error. The
     * `attemptId` is the filter node's current attempt, so a stale re-emit (a
     * pre-restart evaluation) folds as a stale/terminal no-op.
     */
    type: z.literal('succeedControl'),
    nodeId: z.string(),
    attemptId: z.string(),
    outputs: z.record(z.string(), z.unknown()),
  }),
  z.object({
    /**
     * #4 A6 — "this `control` `wait` node should PARK on a durable timer." A
     * driver-OWN command like `scheduleRetry` (no executor, no connector — the
     * driver's `pump` routes it to `armWait`, which arms S1's alarm THEN appends
     * `timer.waitScheduled`). Mirrors the F2b/F2c pure/impure split: the reducer
     * resolves the DURATION PURELY (the `${}` `seconds` over run state, exactly as
     * `evaluateControl`/`filter` resolve their expressions) and hands the driver
     * the resolved `seconds`; the driver decides WHEN (`now + seconds*1000` against
     * a real clock) and stays the SOLE clock reader.
     *
     * Unlike `scheduleRetry` (whose interval is a static doc field the driver reads
     * back from the immutable version), `seconds` IS carried here: a wait duration
     * may be a `${}` expression over run state, which only the pure reducer's
     * `substitute` can evaluate — so it is resolved reducer-side and passed, not
     * re-read from the doc.
     *
     * `ExecutorCommand` deliberately excludes it (not `dispatchNode`/`startChild`),
     * so forgetting the pump branch is a COMPILE error. The `attemptId` is the wait
     * node's current attempt, the alarm's freshness handle.
     */
    type: z.literal('scheduleWait'),
    nodeId: z.string(),
    attemptId: z.string(),
    /** Resolved, non-negative, finite duration in seconds (the reducer's pure half). */
    seconds: z.number(),
  }),
  z.object({
    /**
     * #4 A13 — "this `control` `webhook` node should PARK awaiting an inbound
     * callback, with a timeout." A driver-OWN command like `scheduleWait` (no
     * executor — the driver's `pump` routes it to `armExternalWait`, which derives
     * the correlation token, upserts the correlation row + arms S1's EXPIRY alarm,
     * THEN appends `externalWait.created`). Same pure/impure split as `scheduleWait`:
     * the reducer resolves the `${}` `timeoutSeconds` PURELY over run state and
     * hands the driver the resolved number; the driver decides WHEN the expiry is
     * (`now + timeoutSeconds*1000`) and mints/stores the token (needs the master
     * key + randomness the pure reducer cannot). `ExecutorCommand` excludes it, so
     * forgetting the pump branch is a COMPILE error. `attemptId` is the webhook
     * node's current attempt — the alarm + correlation freshness handle, and the
     * replay-stable input the deterministic token derivation keys off.
     */
    type: z.literal('scheduleExternalWait'),
    nodeId: z.string(),
    attemptId: z.string(),
    /** Resolved, non-negative, finite timeout in seconds (the reducer's pure half). */
    timeoutSeconds: z.number(),
  }),
  z.object({
    /**
     * #4 A17 — "this `loop` container has just gone `active` with a wall-clock
     * `timeout`, so ARM its durable timeout alarm." A driver-OWN command like
     * `scheduleWait` (no executor — the driver's `pump` routes it to
     * `armContainerTimeout`, which arms S1's alarm THEN appends
     * `container.timeoutScheduled`). Emitted ONCE at container-enter (and re-emitted
     * idempotently by `onResumed` if the arm was lost pre-append), so it bounds the
     * loop's TOTAL wall-clock. Unlike `scheduleWait`, `seconds` is a STATIC doc
     * field (the driver could read it back off the immutable version) — it is still
     * carried here for symmetry with the durable-alarm family and to keep the arm
     * side effect-free of the doc. `ExecutorCommand` excludes it, so forgetting the
     * pump branch is a COMPILE error. `containerId` is the loop; there is no attempt
     * handle because a container timeout is armed once per run, not per attempt.
     */
    type: z.literal('scheduleContainerTimeout'),
    containerId: z.string(),
    /** Resolved, positive, finite whole-loop timeout in seconds (bounded at arm). */
    seconds: z.number(),
  }),
  z.object({
    type: z.literal('finishRun'),
    outcome: RunOutcomeSchema,
    reason: z.string().optional(),
  }),
]);
export type EngineCommand = z.infer<typeof EngineCommandSchema>;

/** The pure reducer's return: the new state, commands to run, and diagnostics. */
export interface ReduceResult {
  state: RunState;
  commands: EngineCommand[];
  diagnostics: string[];
}
