import pLimit from 'p-limit';
import {
  AGENT_CLI_CONNECTION_KIND,
  catalog as sharedCatalog,
  collectSecretSinkMarkers,
  computeCostEstimate,
  containsSecretMarker,
  describeDatasetAddress,
  sameDatasetAddress,
  resolveDocNode,
  FAILURE_CODES,
  findLlmMessagesRowIndex,
  LLM_CALL_ACTIVITY_TYPE,
  llmCallConfigSchema,
  normalizeLlmRequest,
  parseConnectionPriceTable,
  resolvePrice,
  WARNING_CODES,
  type ActivityCatalog,
  type ConnectionKind,
  type DatasetAddress,
  type DatasetKind,
  type EngineEvent,
  type FailureKind,
  type Node,
  type WarningCode,
  isNonOverridableConnectionConfigKey,
} from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import { connectionNotReadyReason, getConnection } from '../repo/connections.js';
import { getDataset } from '../repo/datasets.js';
import { getConnectionQuotaResetEpoch } from '../repo/connection-quota.js';
import { getSecretByRef, getSecretByName } from '../repo/secrets.js';
import { decrypt } from '../secrets/secrets.js';
import { deepRedactRecord, deepRedactSecrets, redactSecrets } from '../connectors/redact.js';
import type { Db } from '../repo/types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { toEngineFailure } from '../connectors/error-kind.js';
import { DatasetIoError } from '../connectors/dataset-io-error.js';
import { emptyTruncationWarning } from '../connectors/llm-shared.js';
import type {
  ActivityContext,
  ConnectorAdapter,
  LlmUsage,
  ResolvedDataset,
} from '../connectors/types.js';
import type { DocResolver, Executor, ExecutorCommand } from './driver.js';
import type { ChildRuns } from './child.js';

/**
 * P3 — the REAL executor: the connector-facing half of the run engine's impure
 * boundary. The driver sequences reduce↔persist; THIS turns a `dispatchNode`
 * command into an actual activity run via its connector adapter, streaming the
 * durable engine events back. It is the sole place a plaintext secret is
 * resolved (fetched + decrypted just-in-time) and handed to an adapter — never
 * into a persisted event, `preparedInput`, or `ActivityContext`.
 *
 * CRASH-SAFETY (the load-bearing ordering — see the `Executor` doc in
 * `driver.ts`): everything that is a PURE READ (resolve the node from the doc,
 * catalog lookup, resolve the connection, fetch + decrypt the secret, pick the
 * adapter) runs BEFORE `node.dispatched` is yielded, so a pre-flight failure
 * fails the node while it is still `ready` (no idempotent record, cleanly
 * re-dispatchable on resume). `node.dispatched{idempotent}` is yielded — and so
 * folded/durable — ONLY immediately before the adapter's side effect. A crash
 * after that always leaves the node `dispatched` (recovered per the persisted
 * idempotent flag), never `ready`. The executor maps EVERY adapter failure to a
 * terminal `node.failed`; it does not throw for expected errors.
 *
 * CONCURRENCY: one shared `p-limit(concurrency)` caps ADAPTER runs across all
 * concurrently-driven runs (P4's scheduler). It wraps only the side effect —
 * `node.dispatched` is not gated (it is cheap + must be durable first). A
 * SECOND, independent budget (`PREFLIGHT_STORE_CONCURRENCY`, #1200) caps the
 * one part of pre-flight that is no longer local work: since M10 a store can be
 * asked where a dataset physically is, which opens a session. The two budgets
 * are deliberately separate — they ration different resources (this engine's
 * worker slots vs a remote store's connection slots) — and are never held at
 * the same time, so they cannot deadlock. Within a
 * single run, adapter side effects of DIFFERENT nodes may overlap wall-clock
 * (#4 A4b slice 1: the pump multiplexes its executor streams, bounded by its
 * own per-run cap); what stays strictly serial is the run's FOLD/APPEND path.
 *
 * The real invariant this module relies on is "one DRIVE per run — one
 * in-memory state, one appender" — ENFORCED by `run/drives.ts`'s per-run lock,
 * rather than merely true. It used to hold only because the LAUNCHER was the one
 * thing that could pump a run; when F2c's retry alarm became a second entry
 * point, nothing serialized them, and the measured result was a shared successor
 * dispatched twice under one `attemptId` (a real adapter call billed twice) and
 * then a permanent hang. If you add a THIRD way to start a drive, it goes through
 * `driveRun` — this sentence is not a description, it is a requirement. (A4b's
 * multiplexing lives INSIDE the single pump and per-stream events still fold in
 * stream order, so it changes neither property.)
 *
 * Known best-effort degradation under overlap (L14c): parallel siblings sharing
 * a spent `agent_cli` connection can all pass the quota-window admission gate
 * before the first `rate_limit` failure records the window — concurrent doomed
 * subprocesses that each fail and re-record it. Only the optimisation is lost;
 * correctness (failure → window → later admissions skip) is unchanged.
 */
export interface ExecutorDeps {
  db: Db;
  /** The secret-encryption master key (for just-in-time secret decrypt). */
  masterKey: Uint8Array;
  /** Resolve a run's immutable pipeline version (for the node's type/connection). */
  resolveDoc: DocResolver;
  /** Connector adapters by Connection kind. */
  adapters: ConnectorRegistry;
  /**
   * #796 (P3b) — the `call_pipeline` child-spawn seam. OPTIONAL because the
   * wiring is mutually recursive (executor → child spawn → driver → executor,
   * closed lazily in `index.ts` the way the alarm clock already is) and because
   * many driver tests construct an executor with no run engine behind it. Absent
   * ⇒ a `startChild` is refused as a typed `call.returned{failure}`, never a
   * throw and never a silent hang.
   */
  childRuns?: ChildRuns;
  /** Activity catalog (defaults to the shared MVP catalog). */
  catalog?: ActivityCatalog;
  /** Global worker-pool cap on concurrent ADAPTER runs. Default 4. */
  concurrency?: number;
  /** #2 L14c — clock seam (epoch ms) for the quota admission gate's "is this
   * connection's reset window still in the future" check; defaults to the wall
   * clock, mirroring `DriverDeps.now`/`AlarmClockDeps.now`. Injected in tests for
   * determinism. Read only on a LIVE pre-flight (never on replay). */
  now?: () => number;
}

/**
 * A terminal `node.failed` for `nodeId`/`attemptId` (before OR after dispatch).
 * `failure` carries the STRUCTURED classification (#1 F0): `kind` is the
 * machine-readable retry axis, `error` is human detail only. The kind is never
 * formatted into the message — a retry layer must never parse text.
 */
function nodeFailed(
  runId: string,
  nodeId: string,
  attemptId: string,
  failure: {
    error: string;
    kind: FailureKind;
    code?: string;
    retryAfterSeconds?: number;
    // #2 L14c — the resolved connection this attempt dispatched to (stamped ONLY
    // on a post-dispatch adapter failure, so the driver's quota-window writer can
    // key an `agent_cli` `rate_limit` window off the exact connection).
    connectionId?: string;
    // M1 (#1104) — which END of a PAIRED activity's connection pair failed.
    // Absent on every single-connection failure (all of them at M1).
    side?: 'source' | 'sink';
  },
): EngineEvent {
  return { type: 'node.failed', runId, nodeId, attemptId, ...failure };
}

/**
 * #796 — a typed `call.returned{failure}` for a child that could not be
 * spawned. `childRunId` is echoed so the reducer's deterministic-child-id
 * identity check passes and the call node actually terminalizes. The REASON is
 * logged by the seam that refused (`child.ts`'s `ensure`) rather than carried
 * here: `call.returned` has no error field, and inventing one is #796's own
 * follow-up.
 */
function callFailed(
  runId: string,
  command: Extract<ExecutorCommand, { type: 'startChild' }>,
): EngineEvent {
  return {
    type: 'call.returned',
    runId,
    callNodeId: command.callNodeId,
    attemptId: command.attemptId,
    childRunId: command.childRunId,
    childOutcome: 'failure',
    outputs: {},
  };
}

/**
 * Item 7 / S3 — scrub every held plaintext from an outbound adapter event before
 * it becomes durable. Only the value-bearing shapes can carry a leak: a
 * `node.output` (both its `name` AND `value` — an adapter could build either from
 * a resolved secret), a `node.succeeded` outputs map, and a `node.failed` message
 * (a string). Every other event type (`node.dispatched`, `call.returned`) carries
 * no adapter value and passes through untouched.
 *
 * `node.dispatched` is the one that needs stating rather than listing, since M6
 * slice B (#1149) put an adapter-minted value on it after this was written:
 * `datasetAddresses` carries a store path and an object name. It stays out of
 * the scrub deliberately, not by omission — `DatasetAddressSchema` is
 * NON-SECRET BY CONSTRUCTION (data-movement spec §8: an address may carry what
 * NAMES the data, never what unlocks it), and the same path is already embedded
 * in the `DATASET_SELF_COPY` refusal message below. A store whose address ever
 * needed a credential in it would be a schema change, and this is where it
 * would have to be answered. Deep for structured values,
 * string for the leaf/message; both reuse the connector redaction helpers.
 * (`node.output` is inert in the reducer — pure observability — so scrubbing its
 * `name` cannot change run semantics; it only keeps a plaintext out of the log.)
 */
function redactEventPlaintexts(
  ev: EngineEvent,
  plaintexts: readonly (string | null)[],
): EngineEvent {
  if (ev.type === 'node.output') {
    return {
      ...ev,
      name: redactSecrets(ev.name, plaintexts),
      value: deepRedactSecrets(ev.value, plaintexts),
    };
  }
  if (ev.type === 'node.succeeded') {
    return { ...ev, outputs: deepRedactRecord(ev.outputs, plaintexts) };
  }
  if (ev.type === 'node.failed') {
    return { ...ev, error: redactSecrets(ev.error, plaintexts) };
  }
  return ev;
}

/**
 * #2 L12 — augment a successful `emitMessages: true` `llm_call`'s outputs with
 * the `messages` TRANSCRIPT: the request's non-system turns (history + authored,
 * exactly as `normalizeLlmRequest` ordered them for the wire) plus the final
 * assistant completion. This is multi-turn as STATELESS DATAFLOW — the
 * conversation is a VALUE a downstream node threads via
 * `history: '${nodes.x.output.messages}'`, never engine state.
 *
 * Assembled HERE (the one point every adapter's `succeeded` flows through)
 * rather than per-adapter: one site covers the three API adapters, `agent_cli`,
 * and the L10b tool loop uniformly, and adds none of the per-adapter
 * boilerplate #648 is about. Recomputing the turns from `ctx.input` is
 * wire-faithful for the text path (the adapters send exactly
 * `normalizeLlmRequest(config)`), and DELIBERATELY excludes tool exchanges —
 * the agentic loop owns its internal history (the L12 ticket's own boundary);
 * tool traffic is `activity.toolCalled` telemetry, not conversation.
 *
 * Fail-safe gates, each returning the outputs UNTOUCHED:
 * - not an `llm_call`, or a config that no longer parses (the adapter already
 *   ran on it, so a non-parsing config cannot have succeeded — defence, not a
 *   reachable state), or the flag absent/false;
 * - a non-string `text` output (a structured node — its coupling refusal means
 *   `emitMessages` can't be set, so this is again defence in depth).
 *
 * An EMPTY completion (`text: ''` — a real, succeeded result per #461) appends
 * NO assistant turn: an empty turn is not a conversation fact (and the message
 * schema's `min(1)` would refuse it on the next node's `history` parse) — the
 * `stopReason` output carries the why. The executor emits `messages` exactly
 * when the save-time lowering declared the row (both gates read the SAME
 * literal `emitMessages === true`), so contract and emission cannot desync.
 */
function withTranscript(
  ctx: ActivityContext,
  outputs: Record<string, unknown>,
): Record<string, unknown> {
  if (ctx.activityType !== LLM_CALL_ACTIVITY_TYPE) return outputs;
  const cfg = llmCallConfigSchema.safeParse(ctx.input);
  if (!cfg.success || cfg.data.emitMessages !== true) return outputs;
  // The DECLARED-ROW gate: emit only when the persisted contract carries the
  // lowered `messages` row. Every ≥17 save couples flag→row, but a pre-17
  // stored doc could carry a stray `emitMessages: true` the old save path never
  // lowered (unknown config keys passed through) — emitting for it would just
  // be an undeclared key `storeOutputs` silently drops. Skipping keeps a pre-17
  // doc's behaviour byte-identical to a pre-17 build, and makes flag+row (not
  // flag alone) the emission condition — contract and emission cannot desync.
  const declared = ctx.input['outputs'];
  if (!Array.isArray(declared) || findLlmMessagesRowIndex(declared) === -1) return outputs;
  const text = outputs['text'];
  if (typeof text !== 'string') return outputs;
  const turns: { role: string; content: string }[] = [...normalizeLlmRequest(cfg.data).messages];
  if (text.length > 0) turns.push({ role: 'assistant', content: text });
  return { ...outputs, messages: turns };
}

/**
 * #1200 — how many PRE-FLIGHT store sessions may be open at once, across every
 * run and every executor in the process.
 *
 * `createExecutor`'s `limit` caps the RUNNING phase, and only that: it wraps
 * `runAdapter`, which happens after `node.dispatched`. Pre-flight is outside it
 * by design, because the module's crash-safety ordering (see the docblock at
 * the top of this file) requires every pure read to complete BEFORE the
 * dispatch record is durable. That was free while pre-flight was catalog
 * lookups and a secret decrypt. M10 (#1193) changed the premise: a postgres
 * cluster's physical identity is only answerable from a session, so
 * `resolveDatasetAddress` now opens one — twice per copy node, once per end.
 *
 * Per node nothing got worse (the two ends are sequential, each closed in a
 * `finally`, peak two). ACROSS nodes it was uncapped: N concurrently
 * dispatching copy nodes opened N-2N sessions at once while the phase that
 * actually moves the data was capped at 4. That does not refuse cleanly —
 * postgres `53300 too_many_connections` is classified `transient`, so
 * exhausting a server's slots produces a retrying thundering herd, reported as
 * `DATASET_ADDRESS_UNRESOLVABLE` ("this address did not resolve") rather than
 * as "the engine opened too many sessions at once".
 *
 * MODULE-LEVEL, following `PROBE_CONCURRENCY` (`connectors/probe.ts`) rather
 * than `limit` beside it, and the difference is deliberate. `limit` is
 * per-`createExecutor` because it rations THIS engine's worker slots. This
 * rations sessions on a REMOTE store, which two executors in one process
 * contend for identically — the same argument probe.ts makes for outbound
 * sockets. Sharing it across instances is the intended reading, not an
 * oversight. Same value as both existing budgets, which is the house default
 * rather than a number tuned for this seam. The visible cost is the same one
 * probe.ts names: concurrent test apps ration each other, which shows up as
 * slower resolutions and never as a failure. One caveat for whoever writes the
 * next test here — a `describe.concurrent`/`it.concurrent` in this file would
 * make two tests contend for THIS budget, so a test asserting a peak would need
 * its own serial block. Vitest isolates module state per test FILE, so nothing
 * leaks between files.
 *
 * IT BOUNDS RESOURCES, NOT LATENCY, and the cost is real enough to name. A
 * saturated limiter makes a node WAIT for a slot before `node.dispatched`, with
 * no event emitted anywhere — so the trade is unbounded sessions for bounded
 * but invisible pre-dispatch delay. One slot can be held for
 * `DEFAULT_POSTGRES_CONNECT_TIMEOUT_MS` (10s) plus up to two
 * `DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS` (30s) enrichment queries
 * (`connectors/postgres-session.ts`), so a wide fan-out of copy nodes against
 * one unreachable server queues at roughly ceil(N/4) x that, where today it is
 * one such window in parallel. A run cancelled while queued still proceeds to
 * dispatch when its slot arrives — unchanged from today, but the window widens.
 *
 * NO DEADLOCK, and it is worth stating because there are now two limiters. A
 * store slot is acquired and fully released inside pre-flight, strictly before
 * `limit` is ever acquired; neither limiter is ever held across the other, so
 * there is no lock-ordering cycle. That holds only while `resolveDatasetAddressFor`
 * stays the single seam (its two call sites are both pre-flight) — a third call
 * site from INSIDE `limit(...)` would break it, which is why the seam refuses
 * to be bypassed rather than merely happening not to be.
 */
export const PREFLIGHT_STORE_CONCURRENCY = 4;

const storeLimit = pLimit(PREFLIGHT_STORE_CONCURRENCY);

export function createExecutor(deps: ExecutorDeps): Executor {
  const limit = pLimit(deps.concurrency ?? 4);
  const catalog = deps.catalog ?? sharedCatalog;

  /**
   * Resolve the node object AND the run's owner for a dispatch command. The
   * `ownerId` is the namespace a `{$secret}` config-sink marker resolves within
   * (item 7 / S3) — a node only ever reaches a secret its run's owner holds.
   */
  function resolveNode(
    runId: string,
    nodeId: string,
  ): { node: Node; ownerId: string | null } | null {
    const run = getRun(deps.db, runId);
    if (run === null) return null;
    const pv = deps.resolveDoc(run.pipelineVersionId);
    // #4 A4b — a parallel-foreach dispatch carries an INSTANCE key (`w@1`);
    // EXACT id first (a legacy literal `x@2` node resolves to itself), then the
    // instance-suffix strip resolves the doc node behind the item instance.
    const node = resolveDocNode(pv.nodes, nodeId) ?? null;
    return node === null ? null : { node, ownerId: run.ownerId };
  }

  /**
   * Resolve a node's `{ "$secret": "<name>" }` config-sink markers (item 7 / S3)
   * into a plaintext side channel keyed by config PATH. Walks ONLY the activity's
   * declared `secretSinkFields` via the SAME `collectSecretSinkMarkers` traversal
   * the save-time gate uses (no drift — a version this reaches was gated), so a
   * marker outside a sink is never resolved. Owner-scoped: a null-owner run has
   * no namespace to resolve within, so any marker it carries fails closed.
   *
   * Returns a structured error (→ permanent `node.failed`) or the resolved map.
   * Every cause carries its OWN code, distinct from the CONNECTION-secret codes,
   * so an operator can tell a dangling node-config secret from a dangling
   * connection credential. All `permanent` — a config typo does not self-heal.
   * The empty-sink fast path means this is a pure no-op for every activity that
   * declares no sink (all of them until S4), so no stored version can even carry
   * a marker to resolve (fail-closed, spec §4.3).
   */
  async function resolveConfigSecrets(
    sinkFields: readonly string[],
    preparedInput: Record<string, unknown>,
    ownerId: string | null,
  ): Promise<{ error: string; code: string } | { secretFields: Record<string, string> }> {
    if (sinkFields.length === 0) return { secretFields: {} };
    const markers = collectSecretSinkMarkers(preparedInput, sinkFields);
    if (markers.length === 0) return { secretFields: {} };
    // A null-prototype map: a marker `path` keyed into this is developer-authored
    // catalog config (a sink field name), not external data, but keying a plain
    // object by a path that happened to be `__proto__` would hit the prototype
    // accessor rather than store data — the same class hardened in the redact
    // walk. `Object.create(null)` makes EVERY key a plain data property.
    const secretFields: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const { path, name } of markers) {
      // A null-owner run cannot own a standalone (named) secret — resolve to
      // not-found rather than let `owner_id = NULL` silently match nothing.
      const row = ownerId === null ? null : getSecretByName(deps.db, name, ownerId);
      if (row === null) {
        return {
          error: `secret '${name}' not found`,
          code: FAILURE_CODES.CONFIG_SECRET_NOT_FOUND,
        };
      }
      try {
        secretFields[path] = await decrypt(row.ciphertext, deps.masterKey);
      } catch {
        // NEVER echo the decrypt error (could leak ciphertext/key detail).
        return {
          error: `secret '${name}' could not be decrypted`,
          code: FAILURE_CODES.CONFIG_SECRET_UNDECRYPTABLE,
        };
      }
    }
    return { secretFields };
  }

  /**
   * Resolve the adapter + plaintext secret + connection config for a node whose
   * activity requires a connection. Returns a structured error (→ `node.failed`)
   * or the resolved bundle. All pure reads — safe to run before `node.dispatched`.
   *
   * Every cause carries its OWN `code`: six distinct misconfigurations funnel
   * through one call site, and an operator (and F9a's `errorMap`) must be able
   * to tell "you never bound a connection" from "your key won't decrypt" without
   * string-matching the message. All are `permanent` — a config mistake does not
   * fix itself on a retry.
   *
   * M1 (#1104) — called TWICE for a PAIRED activity (one the catalog declares
   * `sinkConnectionKinds` for). The `side` label is applied by the CALLER, which
   * already knows which end it asked for, rather than spread across the ten
   * error returns here: `labelSide` below is the one place it is attached, so a
   * new return path cannot ship unlabelled. The `code` vocabulary is deliberately
   * NOT doubled with SINK_ variants — the side is orthogonal to the cause, and
   * travels beside `code` on the event.
   */
  async function resolveConnection(
    connectionId: string | undefined,
    kinds: readonly string[],
    activityType: string,
    ownerId: string | null,
    resolvedParams: Record<string, unknown> | undefined,
  ): Promise<
    | { error: string; code: string; kind?: FailureKind; retryAfterSeconds?: number }
    | {
        adapter: ConnectorAdapter;
        secret: string | null;
        connectionConfig: Record<string, unknown>;
        connectionKind: ConnectionKind;
      }
  > {
    // #2 L13a — `connectionId` is the value the reducer resolved from the node's
    // (possibly `${}`) connectionId against the run env, threaded on the
    // `dispatchNode` command. The executor never reads `node.connectionId`
    // directly: that raw field may be a `${}` template it has no run env to
    // resolve. `undefined` here ⟺ the node carried no connectionId at all; a
    // `${}` that resolved to '' is a bound-but-empty ref → CONNECTION_NOT_FOUND
    // below, distinct from CONNECTION_MISSING.
    //
    // M1 (#1104) — the same holds for the PAIRED binding: the caller passes an
    // end of `command.resolvedConnectionIds`, never `node.connectionIds`, for
    // the identical reason. So "the executor never reads the node's raw
    // connection fields" covers both shapes.
    if (connectionId === undefined) {
      return {
        error: `activity '${activityType}' requires a connection but the node has none`,
        code: FAILURE_CODES.CONNECTION_MISSING,
      };
    }
    const connection = getConnection(deps.db, connectionId);
    // Owner authorization (authn ≠ authz): a run may bind ONLY a connection it
    // owns, or a null-owner (shared/global) connection. This closes the vector
    // #2 L13a opened — `connectionId` now derives from run params, which a
    // trigger's body/param bindings can influence, so a bare id lookup would let
    // a run steer dispatch onto ANOTHER owner's connection and decrypt ITS
    // secret. Mirrors the owner-scoping the config-sink secret path already
    // enforces (`resolveConfigSecrets` → `getSecretByName(db, name, ownerId)`).
    // A cross-owner (or null-owner-run vs owned-connection) hit folds into
    // NOT_FOUND — never a distinct "forbidden", which would leak that the id
    // names a real connection (enumeration-resistant, fail-closed).
    if (connection === null || (connection.ownerId !== null && connection.ownerId !== ownerId)) {
      return {
        error: `connection '${connectionId}' not found`,
        code: FAILURE_CODES.CONNECTION_NOT_FOUND,
      };
    }
    if (!kinds.includes(connection.kind)) {
      return {
        error: `connection kind '${connection.kind}' is not valid for activity '${activityType}' (expected: ${kinds.join(', ')})`,
        code: FAILURE_CODES.CONNECTION_KIND_INVALID,
      };
    }
    const adapter = deps.adapters.get(connection.kind);
    if (adapter === undefined) {
      return {
        error: `no adapter for connection kind '${connection.kind}'`,
        code: FAILURE_CODES.NO_ADAPTER,
      };
    }
    // #3 G8a — the SECRET-READINESS dispatch GATE (git-publish spec 742-745):
    // refuse to dispatch a node whose connection is operator-disabled or is
    // missing its required credential. Read LIVE per dispatch off the derived,
    // server-maintained `secretStatus`/`enabled`, so a secret removed (or the
    // connection disabled) AFTER a trigger was enabled cannot fire a secretless
    // run — the gate is at fire time, not just enable time. Placed here, after
    // the kind/adapter validation and BEFORE the L13b param merge + the L14c
    // quota gate + any secret decrypt: a disabled/unprovisioned connection is a
    // more fundamental refusal than validating per-dispatch overrides, and
    // (`permanent`, like the other config-shape checks) it must surface its
    // permanent error rather than a spurious transient — a missing secret does
    // not self-heal on retry. `ready`/`not_required` pass; the existing
    // `SECRET_NOT_FOUND`/`SECRET_UNDECRYPTABLE` checks below remain the belt-
    // and-suspenders guard for a `ready` row whose secret later vanished / won't
    // decrypt.
    // #3 G8b — one readiness decision, shared with the enable-time gate
    // (`connectionNotReadyReason`) so the two can never drift; the distinct
    // messages stay here (behaviour byte-identical to the G8a inline checks).
    const notReadyReason = connectionNotReadyReason(connection);
    if (notReadyReason !== null) {
      return {
        error:
          notReadyReason === 'disabled'
            ? `connection '${connectionId}' is disabled`
            : `connection '${connectionId}' is missing its required secret (needs_secret)`,
        code: FAILURE_CODES.CONNECTION_NOT_READY,
        kind: 'permanent',
      };
    }
    // #2 L13b — gate + merge the node's resolved `connectionParams` over the
    // connection's static `config`. Two refusals, both `permanent` (placed with
    // the other config-shape checks, BEFORE the L14c transient gate, for the
    // same reason it sits after them: a genuine misconfig must surface its
    // permanent error, never a spurious transient):
    //   (0) no bound key may be a SECURITY-BOUNDARY config key
    //       (`CONNECTION_NON_OVERRIDABLE_CONFIG_KEYS`) — `fs`/`sqlite` `roots`
    //       is the path-confinement allowlist and `sqlite` `path` is the store
    //       address, so an override would let the confined party rewrite its own
    //       confinement. Checked FIRST: the allowlist cannot bless these.
    //   (i) every other bound key must be on the connection's declared `parameters`
    //       allowlist — the OWNER's per-key opt-in (a shared connection's
    //       borrower must not override e.g. `baseUrl` and redirect the
    //       decrypted credential). Enforced HERE, not at save: connections are
    //       mutable rows and `connectionId` may itself be `${}`-resolved, so
    //       the target is unknowable at save time.
    //  (ii) no resolved VALUE may be (or embed) a `{$secret}` marker —
    //       parameters are non-secret by design, and a `${}` binding can
    //       resolve run-supplied json the save gate never saw.
    // The merge is SHALLOW ({...config, ...params}): the static value is the
    // default, an allowlisted binding replaces it whole. The adapter's own
    // `configSchema` then validates the EFFECTIVE config — the existing
    // boundary, unchanged.
    let connectionConfig = connection.config;
    if (resolvedParams !== undefined) {
      for (const [key, value] of Object.entries(resolvedParams)) {
        // #1119 M4 — refused BEFORE the allowlist check, because this refusal
        // is not about what the owner opted into: a key on this list may never
        // be overridden even if the allowlist names it. Enforced at the MERGE
        // rather than only at the allowlist write path, because a connection
        // row authored before this rule existed can already carry one.
        if (isNonOverridableConnectionConfigKey(connection.kind, key)) {
          return {
            error:
              `connection parameter '${key}' may never be overridden per dispatch on a ` +
              `'${connection.kind}' connection — it is a security boundary, not a setting`,
            code: FAILURE_CODES.CONNECTION_PARAM_NON_OVERRIDABLE,
          };
        }
        if (!connection.parameters.includes(key)) {
          return {
            error:
              `connection '${connectionId}' does not declare parameter '${key}' ` +
              '(its parameters allowlist is the owner’s opt-in for per-dispatch overrides)',
            code: FAILURE_CODES.CONNECTION_PARAM_UNDECLARED,
          };
        }
        if (containsSecretMarker(value)) {
          return {
            error:
              `connection parameter '${key}' resolved to a value containing a ` +
              'secret marker — parameters are non-secret; use a declared secret sink',
            code: FAILURE_CODES.CONNECTION_PARAM_SECRET_MARKER,
          };
        }
      }
      connectionConfig = { ...connection.config, ...resolvedParams };
    }
    // #2 L14c — the quota ADMISSION GATE. A subscription CLI (`agent_cli`) shares
    // ONE rolling usage quota across every run that binds it. When an earlier
    // dispatch discovered exhaustion, the driver recorded the reset window here
    // (keyed by this SAME resolved `connectionId`); while it is still in the
    // future, short-circuit to a `rate_limit` retry WITHOUT decrypting the secret
    // or spawning a doomed subprocess — otherwise every concurrent run burns its
    // own subprocess to rediscover the shared quota is spent. Placed AFTER kind +
    // adapter validation so a genuinely mis-bound connection still surfaces its
    // PERMANENT error rather than a spurious transient. This carries NO
    // `connectionId` (a pre-dispatch failure), so the driver's window writer does
    // not re-record the window it is reacting to. Best-effort over the reactive
    // path: an absent row (`null`) means "not known exhausted" → not gated.
    if (connection.kind === AGENT_CLI_CONNECTION_KIND) {
      const resetEpochMs = getConnectionQuotaResetEpoch(deps.db, connectionId);
      const now = (deps.now ?? Date.now)();
      if (resetEpochMs !== null && resetEpochMs > now) {
        return {
          error: `connection '${connectionId}' quota is exhausted; retry after the reset window`,
          code: FAILURE_CODES.RATE_LIMIT,
          kind: 'transient',
          retryAfterSeconds: Math.ceil((resetEpochMs - now) / 1000),
        };
      }
    }
    let secret: string | null = null;
    if (connection.secretRef !== null) {
      const secretRow = getSecretByRef(deps.db, connection.secretRef);
      if (secretRow === null) {
        // Defence in depth, not a reachable state: `connections.secret_ref` is an
        // FK onto `secrets.ref` with `onDelete: 'restrict'`, so a dangling ref is
        // rejected at insert AND the referenced secret cannot be deleted out from
        // under it. Kept (with its own code) so a future schema change that
        // relaxes the FK surfaces loudly instead of NPE-ing.
        return {
          error: `secret '${connection.secretRef}' not found`,
          code: FAILURE_CODES.SECRET_NOT_FOUND,
        };
      }
      try {
        secret = await decrypt(secretRow.ciphertext, deps.masterKey);
      } catch {
        // NEVER echo the underlying decrypt error (could leak ciphertext/key detail).
        return {
          error: `secret '${connection.secretRef}' could not be decrypted`,
          code: FAILURE_CODES.SECRET_UNDECRYPTABLE,
        };
      }
    }
    return { adapter, secret, connectionConfig, connectionKind: connection.kind };
  }

  /**
   * M5 slice 4a (#1130, data-movement spec §3.1) — resolve ONE end of a
   * dataset-bound dispatch: the node's dataset ref becomes a checked address, or
   * a labelled refusal.
   *
   * The ladder mirrors `resolveConnection`'s above step for step, and the shared
   * shape is the point — a dataset ref follows `connectionId`'s rules by
   * settlement (§3.1), so a second, differently-ordered set of checks would be a
   * divergence to maintain rather than a feature. Like connections, this runs at
   * DISPATCH and not at save: datasets are MUTABLE rows, so a save-time check
   * would go stale, and the ref may itself be a `${}` expression whose target is
   * unknowable at save.
   *
   * `datasetId` is the value the REDUCER resolved (`command.resolvedDatasetIds`),
   * never `node.datasetIds` — that raw field may be a template this module has
   * no run env to resolve. `undefined` ⟺ the node named no dataset at all; a
   * `${}` that resolved to `''` is bound-but-empty and falls to NOT_FOUND, the
   * same split `resolveConnection` documents.
   */
  function resolveDataset(
    datasetId: string | undefined,
    kinds: readonly DatasetKind[],
    activityType: string,
    ownerId: string | null,
    boundConnectionId: string | undefined,
  ): { error: string; code: string } | { dataset: ResolvedDataset } {
    if (datasetId === undefined) {
      return {
        error: `activity '${activityType}' requires a dataset but the node has none`,
        code: FAILURE_CODES.DATASET_MISSING,
      };
    }
    const dataset = getDataset(deps.db, datasetId);
    // Owner authorization (authn is not authz), on `resolveConnection`'s exact
    // argument: `datasetId` derives from run params via a `${}` ref, which a
    // trigger's param bindings can influence, so a bare id lookup would let a run
    // steer a copy onto ANOTHER owner's dataset — and, since the dataset carries
    // the table name, read or overwrite their data. A cross-owner hit folds into
    // NOT_FOUND rather than a distinct "forbidden", which would confirm the id
    // names a real dataset (enumeration-resistant, fail-closed).
    if (dataset === null || (dataset.ownerId !== null && dataset.ownerId !== ownerId)) {
      return {
        error: `dataset '${datasetId}' not found`,
        code: FAILURE_CODES.DATASET_NOT_FOUND,
      };
    }
    if (!kinds.includes(dataset.kind)) {
      return {
        error: `dataset kind '${dataset.kind}' is not valid for activity '${activityType}' (expected: ${kinds.join(', ')})`,
        code: FAILURE_CODES.DATASET_KIND_INVALID,
      };
    }
    // The agreement check. A node binds a connection pair (M1) AND a dataset pair
    // (M3), and the dataset independently names the store it lives in — so until
    // this ran, the two could contradict each other and nothing would say so. The
    // copy would then read the dataset's table out of the NODE's store: the right
    // shape, the wrong data, silently. Refused rather than resolved in either
    // direction, because neither ref is obviously subordinate to the other and
    // guessing is what produces the silent-wrong run.
    //
    // The node's binding stays the one the ADAPTER runs on: it is what the
    // two-sided readiness gate reads statically (`connection-readiness.ts`) and
    // what the secret side-channel decrypts. This check makes the dataset agree
    // with that, rather than replacing it.
    //
    // `undefined` REFUSES rather than skipping, and the polarity is the point.
    // It is unreachable today — both call sites pass an id that already survived
    // `resolveConnection` — but a guard that silently admits a mismatched store
    // when it cannot see the bound one is fail-OPEN, which is the one direction
    // this codebase never leaves available to a later change.
    if (boundConnectionId === undefined || dataset.connectionId !== boundConnectionId) {
      return {
        error:
          boundConnectionId === undefined
            ? `dataset '${datasetId}' lives in connection '${dataset.connectionId}', but the node bound no connection for this side`
            : `dataset '${datasetId}' lives in connection '${dataset.connectionId}', but the node bound connection '${boundConnectionId}' for this side`,
        code: FAILURE_CODES.DATASET_CONNECTION_MISMATCH,
      };
    }
    return {
      dataset: {
        id: dataset.id,
        name: dataset.name,
        kind: dataset.kind,
        config: dataset.config,
        columns: dataset.columns,
      },
    };
  }

  /**
   * M6 slice B (#1149, spec §2.1) — ask a store WHERE one resolved dataset
   * physically is.
   *
   * A thin wrapper over the adapter's seam that exists to do two things the
   * call sites must not each decide for themselves. First, the MISSING-seam
   * refusal: `resolveDatasetAddress` is optional on `ConnectorAdapter` (six of
   * the seven adapters are not stores), so a store that has not implemented it
   * is refused rather than skipped — a dispatch that cannot say where it lands
   * gets no dispatch record AND no physical self-copy check, which is the
   * "optional gate" shape §7 refuses.
   *
   * Second, the classification. A `DatasetIoError` carries the store's own
   * verdict and goes through `toEngineFailure`, so a store that is merely
   * UNREACHABLE stays `transient` instead of being reported as a config error
   * the operator has to go and fix. Anything else that escapes is `permanent`:
   * an unclassified throw is a defect, and guessing `transient` for it would
   * retry a bug on a timer.
   *
   * Only the KIND is taken from that mapping — the `code` stays
   * `DATASET_ADDRESS_UNRESOLVABLE`, because what an operator acts on here is
   * "this address did not resolve", and the provider-flavoured cause is in the
   * message. It costs nothing today (a `sqlite` store classifies only
   * `permanent`/`transient`) and is written down because M10's networked store
   * can mint `auth`/`rate_limit`, at which point the choice becomes visible.
   */
  async function resolveDatasetAddressFor(
    adapter: ConnectorAdapter,
    connectionConfig: Record<string, unknown>,
    dataset: ResolvedDataset,
    // #1193 — THAT END's credential, never the other's. A postgres-to-postgres
    // copy resolves two addresses against two servers, and passing the source's
    // secret to the sink would send one server's password to another. The sink
    // end is `string | null | undefined` at the call site because an UNPAIRED
    // node never resolves one; `undefined` and `null` collapse here, and a store
    // that needs a credential refuses either identically.
    secret: string | null,
  ): Promise<{ error: string; code: string; kind?: FailureKind } | { address: DatasetAddress }> {
    // Captured, rather than asserted past with `!` at the call below: the
    // field is genuinely optional (six of the seven adapters are not stores),
    // and TS discards a property narrowing inside a closure — which is exactly
    // what `storeLimit` needs. A local const narrows once, here, next to the
    // guard that earns it.
    const resolveAddress = adapter.resolveDatasetAddress;
    if (resolveAddress === undefined) {
      return {
        error: `connection kind '${adapter.kind}' cannot resolve a physical address for dataset '${dataset.id}', so this dispatch cannot record where it would land`,
        code: FAILURE_CODES.DATASET_ADDRESS_UNSUPPORTED,
      };
    }
    try {
      return {
        // #1200 — the ONE seam every pre-flight store session passes through,
        // and therefore the only place the cap has to be applied. The slot is
        // held until the adapter's promise SETTLES, which is what makes it
        // count: `resolvePostgresDatasetAddress` awaits `client.end()` inside
        // its own `finally`, so the session is closed before the slot frees.
        // Do not wrap a race (or anything that can settle before the session
        // does) here — `pLimit` releases on what it wrapped, so a slot freed
        // on a backstop while a socket lives on bounds nothing. That is not
        // hypothetical: `connectors/probe.ts` carries the scar.
        address: await storeLimit(() => resolveAddress({ connectionConfig, dataset, secret })),
      };
    } catch (err) {
      const kind =
        err instanceof DatasetIoError ? toEngineFailure(err.kind).kind : ('permanent' as const);
      return {
        error: `dataset '${dataset.id}' could not be resolved to an address: ${err instanceof Error ? err.message : String(err)}`,
        code: FAILURE_CODES.DATASET_ADDRESS_UNRESOLVABLE,
        kind,
      };
    }
  }

  /**
   * M1 (#1104) — attach the source/sink `side` to a pre-flight resolution
   * failure, for a PAIRED activity only. The ONE place the label is applied, so
   * a new error return inside `resolveConnection` (or, since slice 4a,
   * `resolveDataset`) cannot ship unlabelled.
   *
   * Both a structured field AND the human message: the field is the contract
   * (`node.failed.side`, machine-readable beside `code`, never string-matched);
   * the message keeps the existing run-log surface honest before a UI ticket
   * renders the field, since "connection 'x' not found" on a node bound to two
   * connections names neither.
   *
   * M5 slice 4a (#1130) — `ref` names WHICH pair, because a node now binds two
   * of them. Hardcoding "connection" here (as this did) would have prefixed a
   * dataset refusal with the wrong noun on precisely the support surface the
   * label exists to fix: "sink connection: dataset 'ds' not found" reads as a
   * connection fault. It is a parameter rather than a second helper so the
   * "ONE place the label is applied" property survives the widening.
   */
  function labelSide<T extends { error: string }>(
    failure: T,
    side: 'source' | 'sink',
    ref: 'connection' | 'dataset',
  ): T & { side: 'source' | 'sink' } {
    return { ...failure, side, error: `${side} ${ref}: ${failure.error}` };
  }

  /**
   * The ONE constructor for a `node.failed` from a PRE-FLIGHT resolution refusal
   * — `resolveConnection`'s and, since slice 4a, `resolveDataset`'s — so the
   * source and sink call sites cannot drift on how a failure is shaped. It was
   * named for connections alone; the rename is the point, since a dataset
   * refusal now flows through it and a name that claimed otherwise would invite
   * a second near-identical constructor.
   *
   * Most pre-flight failures are PERMANENT (a config typo does not self-heal);
   * the #2 L14c admission gate is the one transient case, carrying its own
   * `kind:'transient'` + `retryAfterSeconds` so it flows through the L7 retry
   * path exactly like an adapter-reported `rate_limit`. `side` is applied here
   * for a PAIRED activity only — an unpaired failure must not claim an end.
   */
  function preflightFailure(
    runId: string,
    nodeId: string,
    attemptId: string,
    failure: { error: string; code: string; kind?: FailureKind; retryAfterSeconds?: number },
    side: 'source' | 'sink' | undefined,
    ref: 'connection' | 'dataset',
  ): EngineEvent {
    const labelled = side === undefined ? failure : labelSide(failure, side, ref);
    return nodeFailed(runId, nodeId, attemptId, {
      error: labelled.error,
      kind: failure.kind ?? 'permanent',
      code: failure.code,
      ...(failure.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: failure.retryAfterSeconds }
        : {}),
      ...(side !== undefined ? { side } : {}),
    });
  }

  /**
   * Consume an adapter's `ActivityEvent` stream (INSIDE the worker-pool limit)
   * and map it to the terminal + observability engine events. Any throw, or a
   * stream that ends without a terminal, becomes a `node.failed` — one bad node
   * fails its node, never the whole pump.
   */
  async function runAdapter(
    adapter: ConnectorAdapter,
    ctx: ActivityContext,
    secret: string | null,
    secretFields: Record<string, string>,
    controller: AbortController,
    runId: string,
    nodeId: string,
    attemptId: string,
    connectionId: string | undefined,
    /**
     * M1 (#1104) — the SINK end's plaintext credential for a PAIRED activity,
     * passed straight through to the adapter's side channel. `undefined` for
     * every single-connection activity.
     */
    sinkSecret: string | null | undefined,
  ): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    // #2 L5 — the per-connection price-table override, parsed ONCE per dispatch
    // (fail-safe: a malformed override → null → the built-in table is used, and
    // a bad price config never fails the node — pricing is best-effort).
    const priceOverride = parseConnectionPriceTable(ctx.connectionConfig);
    /**
     * #2 L2 — a per-response metering FACT (non-terminal, like `output`): stamp the
     * captured usage into the durable log as `activity.metered`, ordered BEFORE the
     * terminal. The reducer folds it inert; L6 SUMS these events for the run-cost
     * projection. Optional token fields are omitted (not sent as `undefined`) so the
     * stored event matches the schema's `.optional()` shape exactly.
     *
     * #2 L5 — resolve the unit price for (provider, model) against the price table
     * (override ⊕ built-in) and stamp it AT capture. FAIL-CLOSED: an unpriced model
     * leaves ALL price fields absent (never a zero), and `costEstimate` is stamped
     * ONLY when both token counts are present — equivalently
     * `meteringStatus === 'metered'` (meterUsage sets that iff both counts are
     * valid) — so its presence ⟺ a trustworthy full cost.
     *
     * #725 — SHARED by both doors: the adapter's own `metered` event AND a terminal
     * `failed.spendFact` (an exchange that was billed but failed). One builder, so
     * the fail-closed price rules cannot drift apart between the success and
     * failure paths.
     */
    const meteredEvent = (usage: LlmUsage): EngineEvent => {
      // #2 L14 — a subscription/CLI response (`meteringStatus:'unpriced'`) has NO
      // per-token dollar price BY DESIGN (a flat/covered seat pays for it).
      // Suppress price resolution entirely so ALL four price fields stay absent —
      // even if the (provider, model) WOULD match a priced built-in entry. Stamping
      // a manufactured per-token cost onto a subscription call would misreport spend
      // (the same fail-open shape #473 / the merge-gate forbid). The usage counts are
      // still stamped below (usage is a fact); only the price is withheld, and L6
      // folds `unpriced` into its own non-gap bucket.
      const price =
        usage.meteringStatus === 'unpriced'
          ? null
          : resolvePrice(usage.provider, usage.model, priceOverride);
      const priceFields =
        price === null
          ? {}
          : {
              inUnitPrice: price.inUnitPrice,
              outUnitPrice: price.outUnitPrice,
              priceTableVersion: price.priceTableVersion,
              ...(usage.inputTokens !== undefined && usage.outputTokens !== undefined
                ? {
                    costEstimate: computeCostEstimate(usage.inputTokens, usage.outputTokens, price),
                  }
                : {}),
            };
      return {
        type: 'activity.metered',
        runId,
        nodeId,
        attemptId,
        provider: usage.provider,
        model: usage.model,
        meteringStatus: usage.meteringStatus,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...priceFields,
      };
    };
    try {
      for await (const ev of adapter.runActivity(ctx, secret, secretFields, sinkSecret)) {
        if (ev.type === 'output') {
          events.push({ type: 'node.output', runId, nodeId, name: ev.name, value: ev.value });
        } else if (ev.type === 'metered') {
          events.push(meteredEvent(ev.usage));
        } else if (ev.type === 'captured') {
          // #2 L9a — a per-response prompt/completion CAPTURE fact (non-terminal,
          // like `metered`): stamp the shape + latency into the durable log as
          // `activity.captured`, ordered BEFORE the terminal. The reducer folds it
          // inert. Built from the adapter's `ActivityContext.input` (secret-free by
          // construction) — it carries no plaintext, so it needs no scrubbing (the
          // capture is hash/length only). The executor adds the run/node/attempt ids.
          const { capture } = ev;
          events.push({
            type: 'activity.captured',
            runId,
            nodeId,
            attemptId,
            provider: capture.provider,
            model: capture.model,
            latencyMs: capture.latencyMs,
            request: capture.request,
            ...(capture.completion !== undefined ? { completion: capture.completion } : {}),
          });
        } else if (ev.type === 'agentTelemetry') {
          // #2 L11a — an `agent_task` subprocess TELEMETRY fact (non-terminal, like
          // `captured`): stamp the exit code + summary + latency + stdout shape into
          // the durable log as `activity.agentTelemetry`, ordered BEFORE the terminal.
          // The reducer folds it inert. Carries only shape/classification (no raw
          // text), so it needs no scrubbing. The executor adds the run/node/attempt ids.
          const { telemetry } = ev;
          events.push({
            type: 'activity.agentTelemetry',
            runId,
            nodeId,
            attemptId,
            latencyMs: telemetry.latencyMs,
            exitCode: telemetry.exitCode,
            summary: telemetry.summary,
            outputChars: telemetry.outputChars,
            ...(telemetry.signal !== undefined ? { signal: telemetry.signal } : {}),
            ...(telemetry.outputHash !== undefined ? { outputHash: telemetry.outputHash } : {}),
          });
        } else if (ev.type === 'toolCalled') {
          // #2 L10b — one executed tool call's TELEMETRY fact (non-terminal, like
          // `agentTelemetry`): stamp the round + name + args/result shape into the
          // durable log as `activity.toolCalled`, ordered BEFORE the terminal. The
          // reducer folds it inert. Carries only shape/classification (chars +
          // hashes, no raw text), so it needs no scrubbing. The executor adds the
          // run/node/attempt ids; optional fields stay OMITTED when absent
          // (fail-closed — never manufactured).
          const { call } = ev;
          events.push({
            type: 'activity.toolCalled',
            runId,
            nodeId,
            attemptId,
            round: call.round,
            toolName: call.toolName,
            argsChars: call.argsChars,
            resultChars: call.resultChars,
            isError: call.isError,
            ...(call.callId !== undefined ? { callId: call.callId } : {}),
            ...(call.argsHash !== undefined ? { argsHash: call.argsHash } : {}),
            ...(call.resultHash !== undefined ? { resultHash: call.resultHash } : {}),
          });
        } else if (ev.type === 'warned') {
          // #1101 — an ADAPTER-minted advisory: the executor stamps the ids and
          // nothing else. `code` was already typed against `WARNING_CODES` at the
          // producer (the durable field is an open string by back-compat
          // contract), so there is no second spelling to drift.
          //
          // Non-terminal like `activity.toolCalled`, folded inert, and — unlike
          // the #750 warning below — NOT tied to a success: it is emitted while
          // the outcome is still undecided, so it rides failing attempts too.
          events.push({
            type: 'activity.warned',
            runId,
            nodeId,
            attemptId,
            code: ev.code,
            reason: ev.reason,
          });
        } else if (ev.type === 'succeeded') {
          // #750 — a non-fatal ADVISORY, ordered BEFORE the terminal exactly like
          // `activity.toolCalled`, and folded inert by the reducer. Read from the
          // adapter's RAW outputs (`withTranscript` only ever ADDS a `messages`
          // key, so the two agree on `text`/`stopReason`). The code is typed
          // against the `WARNING_CODES` SSOT — the durable field is an open
          // string for back-compat, so the producer is where "no hand-spelled
          // identifier" is enforced.
          const warning = emptyTruncationWarning(ev.outputs);
          if (warning !== null) {
            events.push({
              type: 'activity.warned',
              runId,
              nodeId,
              attemptId,
              code: WARNING_CODES.EMPTY_TRUNCATED_COMPLETION satisfies WarningCode,
              reason: warning,
            });
          }
          events.push({
            type: 'node.succeeded',
            runId,
            nodeId,
            attemptId,
            outputs: withTranscript(ctx, ev.outputs),
          });
          return events;
        } else {
          // F0: map the adapter's PROVIDER kind onto the engine's retry axis and
          // carry the message through RAW. This used to be `${ev.kind}: ${ev.error}`
          // — a classification recoverable only by parsing text.
          // #2 L7: plumb a `Retry-After` hint (LLM adapters set it only on a
          // retryable non-2xx) onto the durable event; the reducer feeds it to the
          // retry alarm. Omitted when absent → the driver uses the policy interval.
          //
          // #725 — a failure that DISCARDED a billed provider exchange carries its
          // metering fact, and it is stamped BEFORE the terminal (which matters: the
          // metered event folds inert, so it cannot terminalize the run and get the
          // failure dropped, whereas the reverse order could lose the cost). A
          // truncated 2xx contributes its REAL counts; an unparseable one a
          // `costUnknown` gap. Without this the provider billed, `usageOf` was never
          // reached, and L6 summed a run cost that silently omitted the exchange —
          // the same silent-loss shape #708 closed at the price-table door.
          if (ev.spendFact !== undefined) events.push(meteredEvent(ev.spendFact));
          events.push(
            nodeFailed(runId, nodeId, attemptId, {
              error: ev.error,
              ...toEngineFailure(ev.kind),
              ...(ev.retryAfterSeconds !== undefined
                ? { retryAfterSeconds: ev.retryAfterSeconds }
                : {}),
              // #2 L14c — stamp the resolved connection on the DISPATCHED failure
              // so the driver's window writer knows which `agent_cli` connection a
              // `rate_limit` came from (L13a `${}` routing means the node's
              // template string is not it). Only the adapter path carries it; a
              // pre-dispatch failure legitimately has none. Always defined here (a
              // connection-bound activity dispatched), the guard is type-hygiene.
              ...(connectionId !== undefined ? { connectionId } : {}),
            }),
          );
          return events;
        }
      }
      // Stream ended with no terminal — an adapter contract violation.
      events.push(
        nodeFailed(runId, nodeId, attemptId, {
          error: 'adapter produced no terminal event',
          kind: 'permanent',
          code: FAILURE_CODES.ADAPTER_NO_TERMINAL,
        }),
      );
      return events;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // An unexpected throw is an adapter BUG of unknown cause, not a classified
      // failure — adapters signal a real cancel/transient by yielding a terminal
      // `failed` themselves. `permanent` is the safe read: it never retries, so a
      // broken adapter cannot retry-loop, and (no MVP activity being idempotent)
      // a blind retry could repeat a side effect that already happened.
      events.push(
        nodeFailed(runId, nodeId, attemptId, {
          error: message,
          kind: 'permanent',
          code: FAILURE_CODES.ADAPTER_THREW,
        }),
      );
      return events;
    } finally {
      controller.abort();
    }
  }

  async function* performDispatch(
    command: Extract<ExecutorCommand, { type: 'dispatchNode' }>,
    runId: string,
  ): AsyncGenerator<EngineEvent> {
    const { nodeId, attemptId } = command;

    // --- pre-flight (pure reads; node stays `ready` on any failure here) ------
    const resolvedNode = resolveNode(runId, nodeId);
    if (resolvedNode === null) {
      yield nodeFailed(runId, nodeId, attemptId, {
        error: `node '${nodeId}' not found in the run's doc`,
        kind: 'permanent',
        code: FAILURE_CODES.NODE_NOT_FOUND,
      });
      return;
    }
    const { node, ownerId } = resolvedNode;
    const entry = catalog.get(node.type);
    if (entry === undefined) {
      yield nodeFailed(runId, nodeId, attemptId, {
        error: `unknown activity type '${node.type}'`,
        kind: 'permanent',
        code: FAILURE_CODES.UNKNOWN_ACTIVITY,
      });
      return;
    }

    // The ActivityDefinition's `kind` (#1 D6) is now the PRIMARY dispatch
    // discriminant, checked ahead of the `connectionKinds` proxy below (which
    // survives, to separate connector-dispatched from the future built-in
    // runner). On its own that proxy conflated a CONTROL activity — never
    // dispatched at all — with an execution activity whose runner does not
    // exist yet: different causes, so they now carry different codes.
    if (entry.kind === 'control') {
      // Control activities are pure reducer transitions (#4: "Reducer handles
      // them natively"), so one reaching the executor means the engine routed
      // it wrong — a bug, not a misconfiguration. Loud, never a silent no-op.
      yield nodeFailed(runId, nodeId, attemptId, {
        error: `control activity '${node.type}' is engine-evaluated and must never be dispatched`,
        kind: 'permanent',
        code: FAILURE_CODES.CONTROL_NOT_DISPATCHABLE,
      });
      return;
    }

    let adapter: ConnectorAdapter;
    let secret: string | null;
    let connectionConfig: Record<string, unknown>;
    // M1 (#1104) — the SINK end, resolved only for a PAIRED activity. Both stay
    // `undefined` for every single-connection activity (all of them at M1).
    let sink: { kind: ConnectionKind; connectionConfig: Record<string, unknown> } | undefined;
    let sinkSecret: string | null | undefined;
    // M6 slice B (#1149) — the SINK's adapter. Kept rather than discarded (see
    // below) because the sink's ADDRESS can only be resolved by the store that
    // owns it, and that store's adapter never runs.
    let sinkAdapter: ConnectorAdapter | undefined;
    // The id the QUOTA-window writer keys off (#2 L14c). For a paired node this
    // is the SOURCE end: the source adapter is the one that runs, so a
    // `rate_limit` it reports came from the source's connection. Without this a
    // paired node would hand the driver `undefined` and its window write would
    // silently no-op — the fail-open shape the reset-epoch split exists to avoid.
    let dispatchedConnectionId: string | undefined;
    // M5 slice 4a (#1130) — the resolved DATASET pair, for an activity whose
    // catalog entry declares `datasetKinds`. `undefined` for every activity that
    // is not dataset-bound (all of them at 4a — `copy` lands at 4b).
    let datasets: { source: ResolvedDataset; sink?: ResolvedDataset } | undefined;
    // M6 slice B (#1149) — the PHYSICAL addresses those datasets resolved to,
    // stamped on `node.dispatched` so the run log can answer "where did this
    // data go" from itself (§2.1). `undefined` in lockstep with `datasets`.
    let datasetAddresses: { source: DatasetAddress; sink?: DatasetAddress } | undefined;
    if (entry.connectionKinds.length > 0) {
      // M1 — a PAIRED activity is one the CATALOG declares a sink for. Read from
      // the catalog, never inferred from the node: a stray `connectionIds` on a
      // single-connection activity must not change how that activity dispatches
      // (it falls through to the singular path below and fails CONNECTION_MISSING,
      // the same fail-closed posture as a stray `connectionId` on a
      // connection-less activity).
      const sinkKinds = entry.sinkConnectionKinds;
      const paired = sinkKinds !== undefined;
      // Source first, and its failure SHORT-CIRCUITS: a node with both ends
      // misconfigured reports the source only. Deliberate — the alternative is
      // resolving (and decrypting) a sink for a dispatch that cannot happen.
      const resolved = await resolveConnection(
        paired ? command.resolvedConnectionIds?.source : command.resolvedConnectionId,
        entry.connectionKinds,
        node.type,
        ownerId,
        // A paired node carries no `connectionParams` — `validateDoc` refuses the
        // combination (they name no side). Passed explicitly rather than relying
        // on that, so a doc predating the rule cannot bind them to a guessed end.
        paired ? undefined : command.resolvedConnectionParams,
      );
      if ('error' in resolved) {
        yield preflightFailure(
          runId,
          nodeId,
          attemptId,
          resolved,
          paired ? 'source' : undefined,
          'connection',
        );
        return;
      }
      ({ adapter, secret, connectionConfig } = resolved);
      dispatchedConnectionId = paired
        ? command.resolvedConnectionIds?.source
        : command.resolvedConnectionId;
      if (paired) {
        const resolvedSink = await resolveConnection(
          command.resolvedConnectionIds?.sink,
          sinkKinds,
          node.type,
          ownerId,
          undefined,
        );
        if ('error' in resolvedSink) {
          yield preflightFailure(runId, nodeId, attemptId, resolvedSink, 'sink', 'connection');
          return;
        }
        // The sink's adapter never RUNS — the SOURCE adapter is the one that
        // does. It is nonetheless kept (M6 slice B, #1149): resolving the sink's
        // physical address is a question only the sink's own store can answer,
        // and re-fetching it from the registry by `kind` would hand back a
        // `ConnectorAdapter | undefined` that the code would then have to assert
        // away — the same claim, made again with less evidence.
        //
        // The sink otherwise contributes its non-secret config, its `kind` (so
        // the running adapter knows which store it writes to, and can re-validate
        // per spec §8) and its plaintext credential — the last on the
        // `runActivity` side channel, never in `ctx`.
        sink = {
          kind: resolvedSink.connectionKind,
          connectionConfig: resolvedSink.connectionConfig,
        };
        sinkSecret = resolvedSink.secret;
        sinkAdapter = resolvedSink.adapter;
      }
    } else {
      // An EXECUTION activity is connector-dispatched by definition (spec #4),
      // so this is a catalog defect today — but it stays the "future built-in
      // runner" slot. Fail loud rather than falling into `resolveConnection`
      // with an empty allowlist, which would report a confusing connection
      // error for what is really a missing runner.
      yield nodeFailed(runId, nodeId, attemptId, {
        error: `activity '${node.type}' has no executor`,
        kind: 'permanent',
        code: FAILURE_CODES.NO_EXECUTOR,
      });
      return;
    }

    // M5 slice 4a (#1130) — resolve the DATASET pair, AFTER both connections and
    // BEFORE `node.dispatched`.
    //
    // After, because the agreement check needs the connection ids the node bound;
    // before, because this module's load-bearing ordering is that every PURE READ
    // precedes the durable dispatch event, so an address error fails the node
    // while it is still `ready`, with no spurious `node.dispatched` to reconcile
    // on boot. Both halves are deliberate, not incidental placement.
    //
    // Read from the CATALOG, never inferred from the node — `sinkConnectionKinds`'
    // rule verbatim: a node's shape is operator input, so a stray `datasetIds` on
    // an activity that declares none must not change how that activity
    // dispatches. It stays inert, exactly as it has been since M3.
    const datasetKinds = entry.datasetKinds;
    if (datasetKinds !== undefined) {
      // Source first, and it SHORT-CIRCUITS the sink — `resolveConnection`'s
      // stated posture: a node with both ends wrong reports the source only,
      // rather than doing work for a dispatch that cannot happen.
      //
      // TWO independent pairings meet here and must not be conflated, which is
      // why neither is called just `paired`. A node's CONNECTION pairing decides
      // where the bound store id comes from; its DATASET pairing decides whether
      // a refusal may claim an end. A source-only `lookup` (M12) is dataset-
      // UNPAIRED while still being connection-single, and a `copy` is both.
      const connectionPaired = entry.sinkConnectionKinds !== undefined;
      const sinkDatasetKinds = datasetKinds.sink;
      const datasetPaired = sinkDatasetKinds !== undefined;
      const resolvedSourceDs = resolveDataset(
        command.resolvedDatasetIds?.source,
        datasetKinds.source,
        node.type,
        ownerId,
        connectionPaired ? command.resolvedConnectionIds?.source : command.resolvedConnectionId,
      );
      if ('error' in resolvedSourceDs) {
        // Labelled ONLY when the dataset binding is genuinely a pair — M1's rule
        // for the connection ladder, followed here rather than diverged from: an
        // unpaired failure must not claim an end. A source-only activity has no
        // sink dataset for `side:'source'` to contrast with, so the label would
        // point an operator at a second ref that does not exist.
        yield preflightFailure(
          runId,
          nodeId,
          attemptId,
          resolvedSourceDs,
          datasetPaired ? 'source' : undefined,
          'dataset',
        );
        return;
      }
      datasets = { source: resolvedSourceDs.dataset };
      // A SOURCE-ONLY activity (M12 `lookup`) declares no sink kinds, so it has
      // no sink dataset to resolve and its `datasetIds.sink` — which `NodeSchema`
      // still requires today — is inert, on the same "the catalog decides"
      // argument as above.
      if (sinkDatasetKinds !== undefined) {
        const resolvedSinkDs = resolveDataset(
          command.resolvedDatasetIds?.sink,
          sinkDatasetKinds,
          node.type,
          ownerId,
          command.resolvedConnectionIds?.sink,
        );
        if ('error' in resolvedSinkDs) {
          yield preflightFailure(runId, nodeId, attemptId, resolvedSinkDs, 'sink', 'dataset');
          return;
        }
        // The self-copy refusal, checked here because this is the one place both
        // resolved ends coexist. It is a DATA-LOSS guard: an `overwrite` sink
        // DELETEs inside the write transaction while the reader is still
        // streaming the same table, so a self-copy destroys the rows it was asked
        // to move. Unlabelled by side deliberately — neither end is at fault, the
        // PAIR is, and labelling one would send an operator to fix the wrong ref.
        if (resolvedSinkDs.dataset.id === resolvedSourceDs.dataset.id) {
          yield preflightFailure(
            runId,
            nodeId,
            attemptId,
            {
              error: `source and sink name the same dataset '${resolvedSourceDs.dataset.id}' — a copy cannot read and overwrite one address`,
              code: FAILURE_CODES.DATASET_SELF_COPY,
            },
            undefined,
            'dataset',
          );
          return;
        }
        datasets = { source: resolvedSourceDs.dataset, sink: resolvedSinkDs.dataset };
      }

      // M6 slice B (#1149, spec §2.1) — resolve the PHYSICAL address of each
      // end, then re-run the self-copy refusal against the addresses rather
      // than the ids.
      //
      // WHY IT IS A SECOND CHECK and not a replacement for the id-identical one
      // above. They refuse the same fault at different resolutions, and the
      // cheaper one gives the better message: "source and sink name the same
      // dataset 'ds_7'" points at the ref an operator has to change, where the
      // address can only say which table two different refs happen to share.
      // The id check also needs no store I/O, so a node that is obviously
      // self-copying never touches the filesystem to learn it.
      //
      // Placed BEFORE `node.dispatched`, with every other pure read: an
      // unresolvable address fails the node while it is still `ready`, leaving
      // no dispatch event for the boot reconciler to reconcile. The observable
      // consequence is stated rather than hidden — a bad store path on a copy
      // now fails at dispatch with a `dataset_address_*` code instead of inside
      // the adapter with activity events. Same `permanent` verdict, earlier and
      // better named.
      const sourceAddress = await resolveDatasetAddressFor(
        adapter,
        connectionConfig,
        datasets.source,
        secret,
      );
      if ('error' in sourceAddress) {
        yield preflightFailure(
          runId,
          nodeId,
          attemptId,
          sourceAddress,
          datasetPaired ? 'source' : undefined,
          'dataset',
        );
        return;
      }
      datasetAddresses = { source: sourceAddress.address };
      const sinkDataset = datasets.sink;
      if (sinkDataset !== undefined) {
        // The SINK's own adapter, not the running one: a heterogeneous copy
        // writes into a different store, and only that store knows how its
        // address resolves. `sink` is proved present alongside `datasets.sink`
        // by the catalog rule that a declared `datasetKinds.sink` implies
        // `sinkConnectionKinds`; the guard is fail-closed rather than a cast,
        // because a catalog that ever broke that rule must refuse, not resolve
        // the sink's address out of the SOURCE's store.
        if (sinkAdapter === undefined || sink === undefined) {
          yield preflightFailure(
            runId,
            nodeId,
            attemptId,
            {
              error: `activity '${node.type}' declares a sink dataset but bound no sink connection to resolve its address in`,
              code: FAILURE_CODES.DATASET_ADDRESS_UNRESOLVABLE,
            },
            'sink',
            'dataset',
          );
          return;
        }
        const sinkAddress = await resolveDatasetAddressFor(
          sinkAdapter,
          sink.connectionConfig,
          sinkDataset,
          sinkSecret ?? null,
        );
        if ('error' in sinkAddress) {
          yield preflightFailure(runId, nodeId, attemptId, sinkAddress, 'sink', 'dataset');
          return;
        }
        // The PHYSICAL self-copy refusal §3.1 named and could not build: two
        // DIFFERENT dataset rows resolving to one table. Unlabelled by side for
        // the same reason as the id-identical case — the PAIR is at fault, and
        // labelling one end would send an operator to fix the wrong ref.
        if (sameDatasetAddress(sourceAddress.address, sinkAddress.address)) {
          yield preflightFailure(
            runId,
            nodeId,
            attemptId,
            {
              error: `source dataset '${datasets.source.id}' and sink dataset '${sinkDataset.id}' resolve to the same address ${describeDatasetAddress(sourceAddress.address)} — a copy cannot read and overwrite one address`,
              code: FAILURE_CODES.DATASET_SELF_COPY,
            },
            undefined,
            'dataset',
          );
          return;
        }
        datasetAddresses = { source: sourceAddress.address, sink: sinkAddress.address };
      }
    }

    // Resolve config-sink `{$secret}` markers (item 7 / S3) in the PRE-FLIGHT,
    // alongside the connection secret. Spec §4.1 places this AFTER
    // `node.dispatched`, but it is the same PURE-READ class as
    // `resolveConnection` (DB fetch + decrypt) and this module's load-bearing
    // ordering is that EVERY pure read runs before `node.dispatched` — so a
    // config error fails the node while still `ready`, with no spurious durable
    // `node.dispatched`, exactly as a bad connection secret does. Both codes are
    // `permanent`, so the run outcome is identical to the spec's placement; this
    // is the consistent, crash-safe seam. A no-op unless a sink is declared.
    const resolvedSecrets = await resolveConfigSecrets(
      entry.secretSinkFields ?? [],
      command.preparedInput,
      ownerId,
    );
    if ('error' in resolvedSecrets) {
      yield nodeFailed(runId, nodeId, attemptId, {
        error: resolvedSecrets.error,
        kind: 'permanent',
        code: resolvedSecrets.code,
      });
      return;
    }
    const { secretFields } = resolvedSecrets;

    // --- the side effect (node.dispatched durable FIRST, then the adapter) ----
    yield {
      type: 'node.dispatched',
      runId,
      nodeId,
      attemptId,
      idempotent: entry.idempotent,
      // OMITTED, not present-undefined, for every activity that is not
      // dataset-bound — the same honesty rule `ctx.datasets` follows, and here
      // it also keeps a non-copy `node.dispatched` byte-identical to the one
      // this build wrote before the field existed.
      ...(datasetAddresses !== undefined ? { datasetAddresses } : {}),
    };

    const controller = new AbortController();
    const ctx: ActivityContext = {
      runId,
      nodeId,
      attemptId,
      // A multi-activity connector (`fs`, #4 A11) selects its operation from this;
      // single-activity adapters ignore it. It is the node's own `type`.
      activityType: node.type,
      input: command.preparedInput,
      connectionConfig,
      // M1 (#1104) — omitted (not present-undefined) for a single-connection
      // activity, so `'sink' in ctx` stays an honest test of "is this paired".
      ...(sink !== undefined ? { sink } : {}),
      // M5 slice 4a (#1130) — OMITTED, not present-undefined, for every activity
      // that is not dataset-bound, so `'datasets' in ctx` stays an honest test.
      // M1's rule for `sink` directly above, followed rather than re-invented.
      ...(datasets !== undefined ? { datasets } : {}),
      signal: controller.signal,
    };
    const events = await limit(() =>
      runAdapter(
        adapter,
        ctx,
        secret,
        secretFields,
        controller,
        runId,
        nodeId,
        attemptId,
        dispatchedConnectionId,
        sinkSecret,
      ),
    );
    // F4 output/error redaction (item 7 / S3): an ADDITIVE executor-level choke
    // point that switches ON only for a node that resolved a config-sink secret
    // — the NEW plaintext class S3 introduces, which no adapter is guaranteed to
    // redact. When it fires it scrubs EVERY plaintext this node holds (the
    // config-sink values AND the connection `secret`, folded into one pass), so
    // within a config-sink node there is no split where one is scrubbed and the
    // other leaks.
    //
    // It is deliberately GATED on a resolved config sink, NOT run for every node:
    // a connection-only node (every activity until S4) keeps exactly its prior
    // protection — the adapter redacts its own outgoing connection secret
    // (`connectors/http.ts`) — so existing activities pay ZERO cost and see no
    // behaviour change (no new deep-walk over their outputs). The executor layer
    // exists to cover the config-sink plaintext the adapter contract does not; it
    // does not replace the adapter's own connection-secret redaction, it stacks
    // on top of it when a sink is present.
    //
    // M1 (#1104) widens the SWITCH, not the policy: a resolved SINK secret is
    // the other plaintext class no adapter is guaranteed to redact. The source
    // adapter is the one running, and it redacts ITS OWN outgoing secret; it has
    // never seen the sink's, so on a paired node the executor is the only layer
    // that can scrub it (spec §8: "a paired activity resolves two and must
    // redact both"). Single-connection nodes are untouched — `sinkSecret` is
    // `undefined` for every activity in this build.
    const sinkPlaintexts = typeof sinkSecret === 'string' ? [sinkSecret] : [];
    const plaintexts =
      Object.keys(secretFields).length > 0 || sinkPlaintexts.length > 0
        ? [secret, ...Object.values(secretFields), ...sinkPlaintexts]
        : [];
    for (const ev of events)
      yield plaintexts.length > 0 ? redactEventPlaintexts(ev, plaintexts) : ev;
  }

  return {
    async *perform(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
      if (command.type === 'startChild') {
        // #796 (P3b) — real `call_pipeline` child execution. NOTE this branch
        // returns BEFORE `performDispatch`, so it never takes a slot in the
        // global adapter limiter: if it is ever moved under that limiter, N
        // nested calls deadlock the whole server (each child's dispatches would
        // queue behind an ancestor holding a slot while awaiting them).
        //
        // Still never a throw, for exactly the reason P3a's stub gave: the boot
        // reconciler re-emits `startChild` for a `waiting` call node, so a
        // throwing executor makes boot reconcile throw on every restart. Every
        // refusal below is a typed `call.returned{failure}` instead (A9/#516).
        if (deps.childRuns === undefined) {
          yield callFailed(runId, command);
          return;
        }
        const ensured = deps.childRuns.ensure(command, runId);
        if (!ensured.ok) {
          yield callFailed(runId, command);
          return;
        }
        if (ensured.terminal) {
          // Adopting a child that already finished — a crash between its
          // terminalization and the parent's `call.returned`. Resolve the node
          // straight away; there is nothing left to kick, and nothing left to
          // ANNOUNCE either.
          //
          // The second half is a consequence, not a choice, and #1038 read this
          // early return as skipping an announcement that was owed. It cannot:
          // `kick` is below the announcement yield and the driver only resumes
          // this generator once that event is durably appended, so a child can
          // only have RUN if it was announced first. And a row only reaches a
          // terminal status once it has STARTED — every terminal writer needs an
          // already-`running` row, an armed alarm or an open wait, none of which
          // a child has before `kick` calls `startRun` (its only child caller).
          // Hence terminal ⟹ kicked ⟹ announced, and `{terminal: true,
          // announced: false}` has no producer.
          //
          // That is a WHOLE-CODEBASE claim, not a local guarantee: a future path
          // that terminalizes a child row without going through `kick` would
          // reopen #1038. `executor.test.ts` pins the half that lives here —
          // that the kick stays below the yield.
          //
          // #1041 ADDED exactly such a path — the boot sweep of orphaned
          // `pending` children (`reconcile.ts`) terminalizes a child row that
          // was never kicked — and it does NOT reopen #1038, for a reason
          // outside this generator: the sweep fires only when the child's parent
          // has already reached a terminal ROW status, and nothing re-drives a
          // terminal parent (both `listParsedRuns` scans that resume a run —
          // boot reconcile and the S7 lease reclaim — select `running` only). So
          // `ensure` is never called again for that child and this branch is
          // unreachable for it. If a future change did make it reachable,
          // `result()` reads an empty log as `failure` (`child.ts`), which is
          // the fail-safe direction rather than a silent success.
          const { outcome, outputs } = deps.childRuns.result(command.childRunId);
          yield {
            type: 'call.returned',
            runId,
            callNodeId: command.callNodeId,
            attemptId: command.attemptId,
            childRunId: command.childRunId,
            childOutcome: outcome,
            outputs,
          };
          return;
        }
        if (!ensured.announced) {
          // Arm-before-append, the same handshake `timer.waitScheduled` and
          // `externalWait.created` keep: the child ROW exists by now, and the
          // driver's per-yield backpressure means this event is durably
          // appended before the kick below ever runs. So the log can hold a
          // spawned child with no announcement (recoverable — boot re-emits
          // `startChild`), but never an announcement with no child.
          yield {
            type: 'call.started',
            runId,
            callNodeId: command.callNodeId,
            attemptId: command.attemptId,
            childRunId: command.childRunId,
          };
        }
        // No `call.returned` here, and no await: the call node stays `waiting`
        // and the child-return reactor resolves it when the child terminalizes.
        // Awaiting instead would strand a parent whose child PARKS, and would
        // deadlock boot reconcile outright (see `child.ts`'s module doc).
        deps.childRuns.kick(ensured.run);
        return;
      }
      yield* performDispatch(command, runId);
    },
  };
}
