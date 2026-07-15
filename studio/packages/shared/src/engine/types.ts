import { z } from 'zod';
import type {
  Param,
  Output,
  Node,
  Edge,
  Container,
  CallConfig,
  PipelineVersion,
} from '../schemas/pipeline.js';

// Re-export the P1 schema types so engine consumers have one import surface for
// the language's inputs. These are NOT redefined here — they are the single
// source of truth in `../schemas/pipeline.ts`.
export type { Param, Output, Node, Edge, Container, CallConfig, PipelineVersion };

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
 * - `run`      — a CLOSED field set describing the current run's identity (see
 *                `RUN_FIELDS`). `${run.<field>}` may read only these names.
 */
export interface SubstitutionContext {
  params: Record<string, unknown>;
  nodeOutputs: Record<string, Record<string, unknown>>;
  run: Record<string, unknown>;
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
]);
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>;

export const NodeRunStateSchema = z.object({
  status: NodeRunStatusSchema,
  attempts: z.number().int().nonnegative(),
  currentAttemptId: z.string().optional(),
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
  /** Why a container terminated (`capped`, `child_failed`, `exitWhen_error`) —
   * observability only; unset while active/pending or on a clean exit. */
  reason: z.string().optional(),
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
export const RunStateSchema = z.object({
  runId: z.string(),
  pipelineVersionId: z.string(),
  params: z.record(z.string(), z.unknown()),
  status: RunLifecycleStatusSchema,
  nodes: z.record(z.string(), NodeRunStateSchema),
  outputs: z.record(z.string(), z.record(z.string(), z.unknown())),
  containers: z.record(z.string(), ContainerRunStateSchema),
  bounces: z.record(z.string(), z.number().int().nonnegative()),
  sessions: z.record(z.string(), z.unknown()),
});
export type RunState = z.infer<typeof RunStateSchema>;

/** Terminal run outcome vocabulary (`capped` is `failure{reason:"capped"}`). */
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
    /** Already-resolved run params (post `resolveRunParams`, secrets stripped). */
    params: z.record(z.string(), z.unknown()),
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
