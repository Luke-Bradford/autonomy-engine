import type { z } from 'zod';
import type {
  ConnectionKind,
  DatasetColumn,
  DatasetKind,
  MeteringStatus,
  WarningCode,
} from '@autonomy-studio/shared';

/**
 * P3 — the CONNECTOR ADAPTER contract (target-architecture "connector model").
 * A connector kind is a plugin: given a Connection's non-secret `config` and its
 * just-in-time-resolved `secret`, it runs an activity and STREAMS results. The
 * adapter is the ONLY place a plaintext secret is used — the executor fetches +
 * decrypts it at dispatch and passes it here as a separate argument; it never
 * enters `ActivityContext` (which may be logged) or any persisted event.
 *
 * A SECOND secret channel (item 7 / S3, the unified secret model): a config
 * field declared a secret SINK (`ActivityCatalogEntry.secretSinkFields`) may
 * carry a `{ "$secret": "<name>" }` marker, which the executor resolves at
 * dispatch into `secretFields` — the optional third `runActivity` argument,
 * keyed by CONFIG PATH (e.g. `secretHeaders.X-Api-Key`) → plaintext. Like
 * `secret`, it is a separate arg, NEVER merged into `ctx.input`/`preparedInput`
 * or any event; `ctx.input` retains only the inert `{$secret:name}` MARKER (a
 * name, safe to log). An adapter that declares no sink ignores it.
 */

/**
 * The PROVIDER-facing error taxonomy (mined + review). It classifies WHY an
 * activity failed, in the terms a provider actually reports.
 * - `auth`      — bad/again-needed credentials (a `secret` problem).
 * - `rate_limit`— throttled by the provider; a backoff-retry candidate.
 * - `transient` — network blip / 5xx / timeout; a retry candidate.
 * - `permanent` — a request that will never succeed as-is (bad input, 4xx-ish).
 * - `cancelled` — aborted via the `AbortSignal` (run cancel / shutdown).
 *
 * This is NOT the engine's taxonomy: the executor maps every kind onto the
 * 3-valued `FailureKind` (the reducer's retry-decision axis) via
 * `error-kind.ts::toEngineFailure`, keeping the narrowed-away detail in
 * `node.failed.code`. The kind is a FIELD on the event — never formatted into
 * the message (#1 F0). Retry itself is still not wired (F2b).
 */
export type ConnectorErrorKind = 'auth' | 'rate_limit' | 'transient' | 'permanent' | 'cancelled';

/**
 * The read-only context an adapter runs against. Contains NO secret material —
 * the plaintext secret is a SEPARATE argument to `runActivity`/`testConnection`,
 * so `ctx` is safe to log. `input` is the node's already-`${}`-substituted config
 * (`preparedInput`, secrets stripped upstream at `resolveRunParams`).
 */
/**
 * M5 slice 4a (#1130) — one end of a dataset-bound dispatch, already resolved:
 * the row existed, the run owns it, its `kind` is one the activity declares, and
 * its store is the connection the node bound for that side.
 *
 * A PROJECTION of `Dataset`, not the row: `ownerId`/`resourceId`/timestamps are
 * server bookkeeping an adapter has no business reading, and `connectionId` is
 * omitted because the executor has already proved it equals the bound
 * connection — carrying it would invite an adapter to re-derive a store from it
 * and bypass the resolution that made it safe.
 *
 * `columns` is the DECLARED schema and is carried for the authoring-side rules
 * that need it (slice 4b's `onError:'null'` vs `nullable:false` refusal, which
 * needs the target's nullability). It is emphatically NOT the sink's write
 * column list: spec §7 gates the node's MAPPING against the store's ACTUAL
 * columns and says in as many words that the declared schema is deliberately not
 * the gate, because a stale declaration must neither block a copy that would
 * succeed nor bless one that would fail. `writeSqliteDatasetRows` discovers the
 * real columns itself; feeding it these would conflate schemas (1) and (3).
 */
export interface ResolvedDataset {
  readonly id: string;
  readonly name: string;
  readonly kind: DatasetKind;
  /** The dataset's kind-specific, NON-SECRET options. Re-validated by the adapter. */
  readonly config: Record<string, unknown>;
  /** The DECLARED schema (spec §7 schema (1)) — an authoring aid, never the drift gate. */
  readonly columns: DatasetColumn[];
}

export interface ActivityContext {
  runId: string;
  nodeId: string;
  attemptId: string;
  /**
   * The dispatched node's activity `type` (the catalog key). Most adapters serve
   * ONE activity and ignore it, but a connector that serves MORE THAN ONE
   * activity type through a single adapter — the registry is keyed by connection
   * KIND, so one `fs` connection backs both `file_read` and `file_write` (#4
   * A11) — selects its operation from this field. Non-secret (it is `Node.type`,
   * already public), safe to log.
   */
  activityType: string;
  /** The node's prepared (substituted) config. Secret-free by construction. */
  input: Record<string, unknown>;
  /** The bound Connection's non-secret `config`. */
  connectionConfig: Record<string, unknown>;
  /**
   * M1 (#1104) — the SINK end of a PAIRED activity's connection pair (an
   * activity the catalog declares `sinkConnectionKinds` for, first `copy` at
   * M5). `connectionConfig` above is then the SOURCE end, and the SOURCE
   * adapter is the one running — it reads from its own store and writes to this
   * one, which is what makes a heterogeneous copy expressible at all.
   *
   * NOTE the name collision, which is why this doc is explicit: "sink" elsewhere
   * in this module and in the executor (`secretSinkFields`,
   * `resolveConfigSecrets`) means a config SECRET sink — an unrelated concept.
   * This is the data sink.
   *
   * `kind` is carried, not just the config: the running adapter is the SOURCE's
   * and has no other way to know which store it is writing to, and no adapter's
   * `configSchema` validates this end (the usual validation boundary does not
   * apply to a connection whose adapter is not running). Spec §8 requires a
   * file-backed sink to re-validate at dispatch rather than assume the stored
   * connection is well-formed; that is only possible with the kind in hand.
   *
   * `undefined` for every single-connection activity — which is all of them at
   * M1. The six existing adapters ignore it.
   */
  sink?: { kind: ConnectionKind; connectionConfig: Record<string, unknown> };
  /**
   * M5 slice 4a (#1130, data-movement spec §3) — the resolved DATASETS this
   * dispatch addresses, for an activity whose catalog entry declares
   * `datasetKinds`. A connection says WHICH STORE; a dataset says WHERE IN IT.
   *
   * OMITTED entirely (not present-undefined) for every activity that is not
   * dataset-bound, so `'datasets' in ctx` stays an honest test — M1's stated
   * rule for `sink`, kept rather than restated differently.
   *
   * `sink` is optional within it because M12's `lookup` reads a source only; the
   * catalog's `datasetKinds` is the SSOT for which sides an activity has, and
   * this shape mirrors it.
   *
   * Why the sink's facts arrive across TWO keys — `sink` above (the store's
   * connection) and `datasets.sink` here (the address in it). They are two
   * different resolutions with two different lifetimes: the connection is
   * decrypted and readiness-gated, the dataset is a plain row. Folding the
   * dataset inside `sink` would also make `'sink' in ctx` mean two things at
   * once, and would have to grow a second meaning again for a source-only
   * reader that has no sink connection at all.
   */
  datasets?: { source: ResolvedDataset; sink?: ResolvedDataset };
  /** Aborts in-flight work (run cancel / server shutdown). */
  signal: AbortSignal;
}

/**
 * A metering FACT for ONE provider response (#2 L2). Non-secret telemetry —
 * `provider` (the Connection kind) + resolved `model` + token counts. Token
 * counts are OPTIONAL: a provider may omit `usage` or report a partial/malformed
 * count, in which case whatever WAS reported is kept and `meteringStatus` is
 * `unknown` (never discard a captured fact). `metered` means a full, well-formed
 * pair. Prices are NOT here — they arrive at L5 (see `activity.metered`).
 */
export interface LlmUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  meteringStatus: MeteringStatus;
}

/**
 * A debugging CAPTURE fact for ONE `llm_call` provider response (#2 L9a): the
 * prompt/completion SHAPE (hash + length, NO raw text) + provider-call latency.
 * The "redacted" default the spec's telemetry-vs-content hardening prescribes.
 * The executor stamps `runId`/`nodeId`/`attemptId` onto the durable
 * `activity.captured` event; the adapter supplies the rest. `completion` is
 * OMITTED (not null) when no completion text was extracted — fail-closed.
 */
export interface LlmCapture {
  provider: string;
  model: string;
  latencyMs: number;
  request: {
    messageCount: number;
    system?: { chars: number; contentHash: string };
    messages: { role: 'user' | 'assistant'; chars: number; contentHash: string }[];
  };
  completion?: { chars: number; contentHash: string };
}

/**
 * A subprocess TELEMETRY fact for ONE `agent_task` attempt (#2 L11a): the agent-
 * CLI child's exit code + a `summary` outcome classification + wall-clock latency
 * + the stdout SHAPE (chars + `sha256` fingerprint, NO raw text — the same
 * telemetry-vs-content discipline as `LlmCapture`). The executor stamps
 * `runId`/`nodeId`/`attemptId` onto the durable `activity.agentTelemetry` event;
 * the adapter supplies the rest. `signal` is OMITTED (not null) when the child was
 * not signalled; `outputHash` is OMITTED when `outputChars === 0` — fail-closed,
 * never `hash('')`.
 */
export interface AgentTelemetry {
  latencyMs: number;
  exitCode: number | null;
  summary: 'completed' | 'timedOut' | 'aborted' | 'killed' | 'signalled' | 'spawnFailed';
  signal?: string;
  outputChars: number;
  outputHash?: string;
}

/**
 * A telemetry FACT for ONE executed local tool call inside an `llm_call` tool
 * loop (#2 L10b): the 0-based provider-exchange `round` that requested it, the
 * EXECUTED tool name (`''` for a nameless malformed call), the provider call id
 * (absent where the provider has none — Ollama), the args/result SHAPE (chars +
 * `sha256`, NO raw text — the `LlmCapture` telemetry-vs-content discipline;
 * hashes ABSENT at 0 chars, never `hash('')`), and whether the fed-back result
 * was an ERROR tool_result. The executor stamps `runId`/`nodeId`/`attemptId`
 * onto the durable `activity.toolCalled` event; the loop supplies the rest.
 */
export interface ToolCallTelemetry {
  round: number;
  toolName: string;
  callId?: string;
  argsChars: number;
  argsHash?: string;
  resultChars: number;
  resultHash?: string;
  isError: boolean;
}

/**
 * What an adapter streams. `output`, `metered`, `captured`, `agentTelemetry`,
 * `toolCalled` and `warned` are observability only (partial progress / a
 * per-response metering fact / a per-response prompt-completion capture fact /
 * an `agent_task` subprocess telemetry fact / an executed-tool-call fact / a
 * non-fatal advisory); exactly one terminal `succeeded`/`failed` ends the
 * stream. The executor maps these to engine events (`node.output` /
 * `activity.metered` / `activity.captured` / `activity.agentTelemetry` /
 * `activity.toolCalled` / `activity.warned` / `node.succeeded` / `node.failed`).
 *
 * ONE terminal can mint TWO engine events (#725): a `failed` carrying a
 * `spendFact` yields an `activity.metered` BEFORE its `node.failed`, because a
 * failure that abandoned a billed exchange is itself a metering fact and the
 * paths that discover it cannot yield an event of their own.
 */
export type ActivityEvent =
  | { type: 'output'; name: string; value: unknown }
  | { type: 'metered'; usage: LlmUsage }
  | { type: 'captured'; capture: LlmCapture }
  | { type: 'agentTelemetry'; telemetry: AgentTelemetry }
  | { type: 'toolCalled'; call: ToolCallTelemetry }
  /**
   * #1101 — an ADAPTER-minted advisory, mapped to the durable `activity.warned`
   * by the executor (which stamps the ids and nothing else). Non-terminal and
   * folded inert, like the telemetry facts above; it never decides an outcome.
   *
   * A second producer of that event, and deliberately so. The first (#750) is
   * DERIVED in the executor from a `succeeded` payload, which can only ever
   * describe a success and only facts that survive into `outputs`. Neither holds
   * here: an `agent_cli` transcript clipped at the byte cap is known before the
   * outcome, and on the `llm_call` CLI shape (whose outputs are the shared
   * `[text, stopReason]`) and on a structured `agent_task` (whose outputs are
   * schema-derived) there is no outputs key to carry it. The adapter is the only
   * layer that holds the fact, so it is the layer that states it.
   *
   * `code` is typed against the `WARNING_CODES` SSOT here, on the PRODUCER side —
   * the durable field is an open string by back-compat contract, so this is where
   * "no producer hand-spells a durable identifier" is enforced. `reason` is the
   * human sentence for the run feed and MUST name no child content: no redaction
   * pass inspects it (`redactEventPlaintexts` passes the variant through).
   */
  | { type: 'warned'; code: WarningCode; reason: string }
  | { type: 'succeeded'; outputs: Record<string, unknown> }
  | {
      type: 'failed';
      kind: ConnectorErrorKind;
      error: string;
      /**
       * #2 L7 — a provider-instructed backoff hint (whole seconds), parsed from a
       * `Retry-After` header on a retryable non-2xx (429/503). Optional: only the
       * LLM adapters set it, and only on a `rate_limit`/`transient` failure. The
       * executor plumbs it onto `node.failed`, whence the reducer feeds it to the
       * retry alarm's `dueAt` (overriding `policy.retryIntervalSeconds`). Ignored
       * for any failure the engine will not retry.
       */
      retryAfterSeconds?: number;
      /**
       * #2 L2 / #725 — the metering FACT for a provider exchange this failure
       * DISCARDED. The executor mints an `activity.metered` from it, ordered before
       * the `node.failed` (the same slot relative to the TERMINAL that the success
       * path's `metered` holds; on the text/tool paths a `captured` event sits
       * between them, so it is not the same slot relative to `captured`). This is
       * what makes "an `activity.metered` per provider response, including
       * failed-but-billed calls" (`llm-shared.ts`) hold on the failure paths of the
       * three HTTP LLM adapters.
       *
       * `agent_cli` upholds the FAILURE-PATH half of it as of #797, but WITHOUT
       * this field: that adapter is itself a generator, so it yields its `metered`
       * fact directly before the terminal rather than riding one. It also marks on
       * weaker evidence than the rule below — a spawned subprocess, not a returned
       * response — and at INVOCATION rather than per-response granularity. See
       * `cliSpendFact` in `agent.ts` for both arguments in full.
       *
       * It exists because the two doors below cannot yield the event themselves:
       * `postJsonAndParse` is a plain function, and the parsed-but-no-completion
       * terminals are built by `noCompletionFailure` inside driver closures whose
       * outcome type carries only the event. Riding the failure means every driver
       * (`runStructuredWithRepair`, `runTextWithTools`, the plain text paths)
       * relays it VERBATIM with no change of its own — the same reason
       * `ToolRoundOutcome.terminal.capture` rides its terminal.
       *
       * SET ONLY WHERE A RESPONSE DEMONSTRABLY CAME BACK — i.e. an exchange
       * completed, so the provider billed for it:
       * - a 2xx that PARSED but carried no usable completion (the truncation case
       *   `DEFAULT_MAX_TOKENS` is pinned against) — the token counts are right there
       *   in the body and were being thrown away → a FULL `metered` fact.
       * - an unparseable 2xx — a body arrived but we could not read it, so the
       *   counts are lost → `meteringStatus:'unknown'`.
       *
       * ABSENT means "we cannot show that anything was billed", and that is
       * load-bearing rather than lazy: marking a call that never reached the
       * provider manufactures a cost GAP for spend that never happened, which is the
       * mirror image of the hole this closes. So a 4xx, a malformed-request
       * `TypeError`, a cancel, a connect-level network error — and, deliberately, a
       * TIMEOUT — are all unmarked. The timeout is #725's headline case and the one
       * that hurts to leave: see `llmPost` for the measurement showing a timeout
       * cannot distinguish a >120s generation from a dropped SYN, and why guessing
       * is worse than the gap.
       */
      spendFact?: LlmUsage;
    };

export interface ConnectorAdapter {
  /** The Connection kind this adapter handles (unique key in the registry). */
  kind: ConnectionKind;
  /** Zod schema for the Connection's non-secret `config`. */
  configSchema: z.ZodType;
  /** Liveness/credential probe for the "test connection" UI. */
  testConnection(
    config: Record<string, unknown>,
    secret: string | null,
  ): Promise<{ ok: boolean; error?: string }>;
  /**
   * Run one activity, streaming progress then exactly one terminal event.
   * `secretFields` (item 7 / S3) carries dispatch-resolved config-sink secrets
   * keyed by config path; optional + backward-compatible (an adapter with no
   * declared sink omits/ignores it). NEVER echo a resolved value back into an
   * output or error message — the executor scrubs them defensively, but the
   * adapter is the first line (see the http adapter, S4).
   *
   * `sinkSecret` (M1 #1104) is the plaintext credential for `ctx.sink` — the
   * SINK end of a PAIRED activity, decrypted at dispatch into this side channel
   * exactly as `secret` is for the source, and never placed in `ctx` or an
   * event. Optional + backward-compatible: `undefined` for every
   * single-connection activity, and the six existing adapters ignore it. The
   * executor redacts it out of this node's events as a backstop (a paired
   * activity resolves two plaintexts, and the SOURCE adapter's own redaction
   * cannot know about the other one).
   */
  runActivity(
    ctx: ActivityContext,
    secret: string | null,
    secretFields?: Readonly<Record<string, string>>,
    sinkSecret?: string | null,
  ): AsyncIterable<ActivityEvent>;
}
