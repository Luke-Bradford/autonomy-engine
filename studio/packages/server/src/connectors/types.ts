import type { z } from 'zod';
import type { ConnectionKind } from '@autonomy-studio/shared';

/**
 * P3 — the CONNECTOR ADAPTER contract (target-architecture "connector model").
 * A connector kind is a plugin: given a Connection's non-secret `config` and its
 * just-in-time-resolved `secret`, it runs an activity and STREAMS results. The
 * adapter is the ONLY place a plaintext secret is used — the executor fetches +
 * decrypts it at dispatch and passes it here as a separate argument; it never
 * enters `ActivityContext` (which may be logged) or any persisted event.
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
  /** The node's prepared (substituted) config. Secret-free by construction. */
  input: Record<string, unknown>;
  /** The bound Connection's non-secret `config`. */
  connectionConfig: Record<string, unknown>;
  /** Aborts in-flight work (run cancel / server shutdown). */
  signal: AbortSignal;
}

/**
 * What an adapter streams. `output` is observability only (partial progress);
 * exactly one terminal `succeeded`/`failed` ends the stream. The executor maps
 * these to engine events (`node.output` / `node.succeeded` / `node.failed`).
 */
export type ActivityEvent =
  | { type: 'output'; name: string; value: unknown }
  | { type: 'succeeded'; outputs: Record<string, unknown> }
  | { type: 'failed'; kind: ConnectorErrorKind; error: string };

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
  /** Run one activity, streaming progress then exactly one terminal event. */
  runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent>;
}
