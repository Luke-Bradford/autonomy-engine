import type { z } from 'zod';
import type { ConnectionKind, MeteringStatus } from '@autonomy-studio/shared';

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
 * What an adapter streams. `output`, `metered`, `captured`, and `agentTelemetry`
 * are observability only (partial progress / a per-response metering fact / a
 * per-response prompt-completion capture fact / an `agent_task` subprocess
 * telemetry fact); exactly one terminal `succeeded`/`failed` ends the stream. The
 * executor maps these to engine events (`node.output` / `activity.metered` /
 * `activity.captured` / `activity.agentTelemetry` / `node.succeeded` /
 * `node.failed`).
 */
export type ActivityEvent =
  | { type: 'output'; name: string; value: unknown }
  | { type: 'metered'; usage: LlmUsage }
  | { type: 'captured'; capture: LlmCapture }
  | { type: 'agentTelemetry'; telemetry: AgentTelemetry }
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
   */
  runActivity(
    ctx: ActivityContext,
    secret: string | null,
    secretFields?: Readonly<Record<string, string>>,
  ): AsyncIterable<ActivityEvent>;
}
