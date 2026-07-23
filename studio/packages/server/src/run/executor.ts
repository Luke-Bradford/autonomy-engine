import pLimit from 'p-limit';
import {
  AGENT_CLI_CONNECTION_KIND,
  catalog as sharedCatalog,
  collectSecretSinkMarkers,
  computeCostEstimate,
  containsSecretMarker,
  resolveDocNode,
  FAILURE_CODES,
  findLlmMessagesRowIndex,
  LLM_CALL_ACTIVITY_TYPE,
  llmCallConfigSchema,
  normalizeLlmRequest,
  parseConnectionPriceTable,
  resolvePrice,
  type ActivityCatalog,
  type EngineEvent,
  type FailureKind,
  type Node,
} from '@autonomy-studio/shared';
import { getRun } from '../repo/runs.js';
import { getConnection } from '../repo/connections.js';
import { getConnectionQuotaResetEpoch } from '../repo/connection-quota.js';
import { getSecretByRef, getSecretByName } from '../repo/secrets.js';
import { decrypt } from '../secrets/secrets.js';
import { deepRedactRecord, deepRedactSecrets, redactSecrets } from '../connectors/redact.js';
import type { Db } from '../repo/types.js';
import type { ConnectorRegistry } from '../connectors/registry.js';
import { toEngineFailure } from '../connectors/error-kind.js';
import type { ActivityContext, ConnectorAdapter } from '../connectors/types.js';
import type { DocResolver, Executor, ExecutorCommand } from './driver.js';

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
 * `node.dispatched` is not gated (it is cheap + must be durable first). Within a
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
  },
): EngineEvent {
  return { type: 'node.failed', runId, nodeId, attemptId, ...failure };
}

/**
 * Item 7 / S3 — scrub every held plaintext from an outbound adapter event before
 * it becomes durable. Only the value-bearing shapes can carry a leak: a
 * `node.output` (both its `name` AND `value` — an adapter could build either from
 * a resolved secret), a `node.succeeded` outputs map, and a `node.failed` message
 * (a string). Every other event type (`node.dispatched`, `call.returned`) carries
 * no adapter value and passes through untouched. Deep for structured values,
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
      }
  > {
    // #2 L13a — `connectionId` is the value the reducer resolved from the node's
    // (possibly `${}`) connectionId against the run env, threaded on the
    // `dispatchNode` command. The executor never reads `node.connectionId`
    // directly: that raw field may be a `${}` template it has no run env to
    // resolve. `undefined` here ⟺ the node carried no connectionId at all; a
    // `${}` that resolved to '' is a bound-but-empty ref → CONNECTION_NOT_FOUND
    // below, distinct from CONNECTION_MISSING.
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
    // #2 L13b — gate + merge the node's resolved `connectionParams` over the
    // connection's static `config`. Two refusals, both `permanent` (placed with
    // the other config-shape checks, BEFORE the L14c transient gate, for the
    // same reason it sits after them: a genuine misconfig must surface its
    // permanent error, never a spurious transient):
    //   (i) every bound key must be on the connection's declared `parameters`
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
    return { adapter, secret, connectionConfig };
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
  ): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    // #2 L5 — the per-connection price-table override, parsed ONCE per dispatch
    // (fail-safe: a malformed override → null → the built-in table is used, and
    // a bad price config never fails the node — pricing is best-effort).
    const priceOverride = parseConnectionPriceTable(ctx.connectionConfig);
    try {
      for await (const ev of adapter.runActivity(ctx, secret, secretFields)) {
        if (ev.type === 'output') {
          events.push({ type: 'node.output', runId, nodeId, name: ev.name, value: ev.value });
        } else if (ev.type === 'metered') {
          // #2 L2 — a per-response metering FACT (non-terminal, like `output`):
          // stamp the captured usage into the durable log as `activity.metered`,
          // ordered BEFORE the terminal `succeeded`. The reducer folds it inert;
          // L6 SUMS these events for the run-cost projection. Optional token fields
          // are omitted (not sent as `undefined`) so the stored event matches the
          // schema's `.optional()` shape exactly.
          //
          // #2 L5 — resolve the unit price for (provider, model) against the
          // price table (override ⊕ built-in) and stamp it AT capture. FAIL-CLOSED:
          // an unpriced model leaves ALL price fields absent (never a zero), and
          // `costEstimate` is stamped ONLY when both token counts are present —
          // equivalently `meteringStatus === 'metered'` (meterUsage sets that iff
          // both counts are valid) — so its presence ⟺ a trustworthy full cost.
          const { usage } = ev;
          // #2 L14 — a subscription/CLI response (`meteringStatus:'unpriced'`) has
          // NO per-token dollar price BY DESIGN (a flat/covered seat pays for it).
          // Suppress price resolution entirely so ALL four price fields stay absent
          // — even if the (provider, model) WOULD match a priced built-in entry.
          // Stamping a manufactured per-token cost onto a subscription call would
          // misreport spend (the same fail-open shape #473 / the merge-gate forbid).
          // The usage counts are still stamped below (usage is a fact); only the
          // price is withheld, and L6 folds `unpriced` into its own non-gap bucket.
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
                        costEstimate: computeCostEstimate(
                          usage.inputTokens,
                          usage.outputTokens,
                          price,
                        ),
                      }
                    : {}),
                };
          events.push({
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
          });
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
        } else if (ev.type === 'succeeded') {
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
    if (entry.connectionKinds.length > 0) {
      const resolved = await resolveConnection(
        command.resolvedConnectionId,
        entry.connectionKinds,
        node.type,
        ownerId,
        command.resolvedConnectionParams,
      );
      if ('error' in resolved) {
        // Most pre-flight failures are PERMANENT (a config typo does not self-heal);
        // the #2 L14c admission gate is the one transient case, carrying its own
        // `kind:'transient'` + `retryAfterSeconds` so it flows through the L7 retry
        // path exactly like an adapter-reported `rate_limit`.
        yield nodeFailed(runId, nodeId, attemptId, {
          error: resolved.error,
          kind: resolved.kind ?? 'permanent',
          code: resolved.code,
          ...(resolved.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: resolved.retryAfterSeconds }
            : {}),
        });
        return;
      }
      ({ adapter, secret, connectionConfig } = resolved);
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
        command.resolvedConnectionId,
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
    const plaintexts =
      Object.keys(secretFields).length > 0 ? [secret, ...Object.values(secretFields)] : [];
    for (const ev of events)
      yield plaintexts.length > 0 ? redactEventPlaintexts(ev, plaintexts) : ev;
  }

  return {
    async *perform(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
      if (command.type === 'startChild') {
        // P3a defers `call_pipeline` (sub-pipeline) EXECUTION to P3b. Yield a
        // loud `call.returned{failure}` — NOT a throw and NOT a hang: throwing
        // would leave the node `waiting`, and the boot reconciler re-emits
        // `startChild` for a `waiting` call node, so a throwing executor would
        // make boot reconcile itself throw on every restart. A failure result
        // terminalizes the call node (its unhandled failure fails the run),
        // leaving no `waiting` node behind. `childRunId` is echoed so the
        // reducer's deterministic-child-id identity check passes.
        yield {
          type: 'call.returned',
          runId,
          callNodeId: command.callNodeId,
          attemptId: command.attemptId,
          childRunId: command.childRunId,
          childOutcome: 'failure',
          outputs: {},
        };
        return;
      }
      yield* performDispatch(command, runId);
    },
  };
}
