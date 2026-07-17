import { z } from 'zod';
import type { ConnectionKind } from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorErrorKind } from './types.js';
import { redactSecrets } from './redact.js';

/**
 * P3b — shared machinery for the LLM connector adapters (`anthropic_api`,
 * `openai_api`, `ollama`). All three are a single JSON POST to a provider's
 * chat endpoint with the SAME failure taxonomy and the SAME timeout/abort
 * discipline as the `http` adapter; only the request/response SHAPE differs.
 * This module owns everything shape-independent so each adapter stays thin and
 * every adapter classifies failures identically.
 *
 * SECRET DISCIPLINE (deferred req b): the provider API key is the Connection's
 * `secret` (resolved just-in-time from `secretRef` and passed as a separate
 * argument), NEVER part of the non-secret `connectionConfig`. The adapters send
 * it in a request header and never surface it in an output; a failure's `error`
 * carries only the RESPONSE body (which never contains the key we sent) OR a
 * network/runtime error message — and the LATTER can embed an outgoing header
 * value (Node's header-validation `TypeError` quotes the bad value verbatim), so
 * every echoed error is passed through `redactSecrets` against the outgoing
 * header values first. So the "config is non-secret for every kind" assumption
 * still holds for these secret-bearing kinds; no config-schema change is needed.
 */

/** Default per-request timeout (ms) for an LLM call — bounds a hung provider. */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/** The non-secret Connection config common to every LLM adapter. */
export const llmConnectionConfigSchema = z.object({
  /** Provider base URL override (self-hosted / gateway / local). */
  baseUrl: z.string().optional(),
  /** Default model, used when the node's activity config sets none. */
  model: z.string().optional(),
  /** Per-request timeout in ms (whole exchange). Defaults to 120s. */
  timeoutMs: z.number().int().positive().optional(),
});

/** The per-activity `llm_call` settings, read from the node's prepared `input`. */
export const llmRequestInputSchema = z.object({
  prompt: z.string().min(1),
  system: z.string().optional(),
  /** Overrides the connection's default `model` for this node. */
  model: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
});

export type LlmRequestInput = z.infer<typeof llmRequestInputSchema>;

/**
 * Classify an HTTP status into the connector error taxonomy. Unlike the `http`
 * adapter — where a 4xx/5xx is real DATA the pipeline branches on — an LLM call
 * that returns non-2xx produced NO completion, so it is a genuine failure:
 * 401/403 → `auth` (bad key), 429 → `rate_limit`, 5xx → `transient` (retry
 * candidate), any other non-2xx → `permanent` (a request that won't succeed as-is).
 */
export function classifyHttpStatus(status: number): ConnectorErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  return 'permanent';
}

/**
 * Resolve the model for a call: the node's `input.model` wins, then the
 * connection's default `config.model`, then the adapter's built-in default (only
 * `anthropic_api` has a safe universal default). `null` when none resolves —
 * the caller fails the node `permanent` with a clear "no model" message rather
 * than guessing a provider-specific id.
 */
export function resolveModel(
  input: LlmRequestInput,
  config: { model?: string },
  fallback?: string,
): string | null {
  // An empty string is "absent", not a real model — otherwise `?? ` would pick
  // it and the adapter would POST an empty model instead of the clear local
  // "no model" failure.
  const pick = (v?: string): string | undefined =>
    v !== undefined && v.length > 0 ? v : undefined;
  return pick(input.model) ?? pick(config.model) ?? fallback ?? null;
}

/** A completed HTTP exchange (any status) OR a terminal failure event. */
export type LlmFetchResult =
  | { type: 'response'; status: number; bodyText: string }
  | { type: 'failed'; event: Extract<ActivityEvent, { type: 'failed' }> };

/**
 * Perform one JSON POST bounded by a whole-exchange timeout, mirroring the
 * `http` adapter's abort/timeout classification: the run's own signal aborting
 * → `cancelled`; the timeout firing → `transient`; a malformed request
 * (`TypeError`) → `permanent`; any other network error → `transient`. Returns
 * the completed response's status + body text for the adapter to map, or a
 * ready-to-yield `failed` event. It never throws for an expected error.
 */
export async function llmPost(
  ctx: ActivityContext,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<LlmFetchResult> {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  if (ctx.signal.aborted) controller.abort();
  else ctx.signal.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    clearTimeout(timer);
    return { type: 'response', status: res.status, bodyText };
  } catch (err) {
    // The run's own cancel wins over a coincident timeout.
    if (ctx.signal.aborted) {
      return {
        type: 'failed',
        event: { type: 'failed', kind: 'cancelled', error: 'llm request aborted' },
      };
    }
    if (timedOut) {
      return {
        type: 'failed',
        event: {
          type: 'failed',
          kind: 'transient',
          error: `llm request timed out after ${timeoutMs}ms`,
        },
      };
    }
    const headerValues = Object.values(headers);
    if (err instanceof TypeError) {
      return {
        type: 'failed',
        event: {
          type: 'failed',
          kind: 'permanent',
          error: redactSecrets(err.message, headerValues),
        },
      };
    }
    return {
      type: 'failed',
      event: {
        type: 'failed',
        kind: 'transient',
        error: redactSecrets(err instanceof Error ? err.message : String(err), headerValues),
      },
    };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Parse a completed 2xx body as JSON, or return a `permanent` failure event for
 * a malformed provider response. Bounded so a huge/garbage error body is
 * truncated before it lands in a durable event.
 */
export function parseJsonBody(
  bodyText: string,
): { ok: true; json: unknown } | { ok: false; event: Extract<ActivityEvent, { type: 'failed' }> } {
  try {
    return { ok: true, json: JSON.parse(bodyText) };
  } catch {
    return {
      ok: false,
      event: {
        type: 'failed',
        kind: 'permanent',
        error: 'provider returned a non-JSON response body',
      },
    };
  }
}

/**
 * #461 — the single failure event for a 2xx response that carries NO readable
 * completion. The completion IS `llm_call`'s whole product; a provider that
 * returns 200 but no completion structure (`{}`, `choices:[]`, a non-array
 * `content`, zero text blocks) produced no product, and coercing that to
 * `succeeded{text:''}` flows a manufactured-empty result downstream silently —
 * the same fail-open shape the engine forbids elsewhere ("an absent fact must
 * never be manufactured as a benign default").
 *
 * `permanent`, NOT `transient`: a 2xx means transport + server succeeded, so an
 * unreadable BODY is a response-SHAPE problem a retry of the identical request
 * won't fix — the same class as `parseJsonBody`'s non-JSON-2xx `permanent`.
 * (`transient` is reserved for 5xx / timeout / network — see `classifyHttpStatus`
 * and `llmPost`.) Retry policy never re-runs it (`retryEligible` gates on
 * `transient`).
 *
 * A PRESENT-but-EMPTY completion (an explicit `content:''`, or an anthropic
 * `[{type:'text',text:''}]`) is a REAL result and still succeeds — `stopReason`
 * (e.g. `content_filter`, `length`) carries why and downstream can branch on it.
 * Only structural ABSENCE fails.
 *
 * `kind` names the adapter so the durable `error` is traceable to a provider,
 * matching the `<kind> HTTP <status>` errors (the generic `parseJsonBody`
 * message is the one exception, and names a unique symptom instead).
 */
/**
 * The three LLM adapter kinds — narrower than the full `ConnectionKind` union so
 * passing a non-LLM kind (`agent_cli`, `http`) to an LLM-only helper is a compile
 * error, not a convention. Derived via `Extract` so it tracks the source enum.
 */
export type LlmConnectionKind = Extract<ConnectionKind, 'anthropic_api' | 'openai_api' | 'ollama'>;

export function noCompletionFailure(
  kind: LlmConnectionKind,
): Extract<ActivityEvent, { type: 'failed' }> {
  return {
    type: 'failed',
    kind: 'permanent',
    error: `${kind} returned a 2xx response with no completion`,
  };
}

/** A short, safe excerpt of a non-2xx response body for a failure `error`. */
export function errorExcerpt(bodyText: string): string {
  const trimmed = bodyText.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

/** Sentinel for "no readable stop reason" — see `coerceStopReason` for why. */
const STOP_REASON_UNKNOWN = 'unknown';

/**
 * The single answer to "what goes in `llm_call`'s `stopReason` output" (#457).
 *
 * WHY IT MATTERS: the catalog declares `llm_call.outputs` as `[text: string,
 * stopReason: string]`. That declaration is inert metadata on its own, but
 * `canvasStore` seeds every palette-created node's `config.outputs` from it, so
 * for those nodes it already IS the runtime contract (`outputContract` reads the
 * node's own `config.outputs`; #456/F13b would make it the default for nodes
 * made via API/import/CLI too). The reducer's `validateOutputs` type-checks each
 * declared output at `node.succeeded`, and `matchesType(null, 'string')` is
 * false — so yielding `null` here terminalizes the node as a FAILURE with
 * `output 'stopReason' is not of declared type 'string'`: a diagnostic about the
 * ADAPTER's untruth, blamed on the author's node.
 *
 * All three LLM adapters route through this one function so the catalog has a
 * single, honest counterparty. Each provider names the field differently
 * (Anthropic `stop_reason`, OpenAI `finish_reason`, Ollama `done_reason`) and
 * each can omit it on a shape the adapter does not anticipate; a value the
 * provider DID send is passed through verbatim — it is not ours to reinterpret
 * (cross-provider normalization is spec #2's I6, still open).
 *
 * The sentinel is deliberately NOT `'stop'`: that is a real OpenAI
 * `finish_reason`, so it would make an unreadable response indistinguishable
 * from a normal completion for any downstream
 * `${nodes.x.output.stopReason} == 'stop'` branch — and it is absent from
 * Anthropic's vocabulary, so it would invent a value that provider never emits.
 * `unknown` appears in no first-party provider's documented vocabulary. (A
 * bespoke OpenAI-compatible gateway or local runner can of course put any string
 * in the field; passthrough is still right — we report what we were told.)
 */
export function coerceStopReason(value: unknown): string {
  return typeof value === 'string' ? value : STOP_REASON_UNKNOWN;
}

/**
 * A bounded liveness/credential probe for the "test connection" UI: a GET to a
 * provider's cheap list endpoint (models / tags). A 2xx proves reachability +
 * a working credential; a 401/403 means the credential is bad/missing; anything
 * else (or a network error) is surfaced as not-ok without leaking the secret
 * (which we only ever SEND, never read back).
 */
export async function llmProbeGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `authentication failed (HTTP ${res.status})` };
    }
    if (res.status >= 400) {
      return { ok: false, error: `provider probe failed (HTTP ${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: redactSecrets(
        err instanceof Error ? err.message : String(err),
        Object.values(headers),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}
