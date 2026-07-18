import { z } from 'zod';
import type { ConnectionKind } from '@autonomy-studio/shared';
import {
  llmCallConfigSchema,
  normalizeLlmRequest,
  parseAndValidateStructured,
  structuredOutputInstruction,
  validateStructuredOutput,
} from '@autonomy-studio/shared';
import type {
  LlmCallConfig,
  LlmOutputSchema,
  LlmSampling,
  NormalizedLlmRequest,
  ReasoningEffort,
  StructuredValidationResult,
} from '@autonomy-studio/shared';
import type { ActivityContext, ActivityEvent, ConnectorErrorKind, LlmUsage } from './types.js';
import { redactSecrets } from './redact.js';

// #2 L1 — the `llm_call` config schema + its normalization are the SSOT in
// `@autonomy-studio/shared`; re-exported here so each adapter imports its LLM
// machinery from ONE module. See `shared/src/catalog/llm-config.ts`. #2 L4b adds
// the runtime structured parse/validate helpers (`shared/src/catalog/llm-structured.ts`).
export {
  llmCallConfigSchema,
  normalizeLlmRequest,
  parseAndValidateStructured,
  structuredOutputInstruction,
  validateStructuredOutput,
};
export type {
  LlmCallConfig,
  LlmOutputSchema,
  LlmSampling,
  NormalizedLlmRequest,
  ReasoningEffort,
  StructuredValidationResult,
};

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
  input: { model?: string },
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
 * The three LLM adapter kinds — narrower than the full `ConnectionKind` union so
 * passing a non-LLM kind (`agent_cli`, `http`) to an LLM-only helper is a compile
 * error, not a convention. Derived via `Extract` so it tracks the source enum.
 */
export type LlmConnectionKind = Extract<ConnectionKind, 'anthropic_api' | 'openai_api' | 'ollama'>;

/**
 * #556 — the sub-reason a 2xx response carried no readable completion, for
 * DIAGNOSTICS only. All three are the SAME `permanent` retry class (see
 * `noCompletionFailure`); the distinction is which shape failed, so an operator
 * reading a durable `error` can tell a provider RESPONSE-SHAPE change apart from
 * a single corrupt block without re-deriving it from the raw body:
 *
 * - `absent_content` — the completion container is structurally missing or the
 *   wrong type (anthropic non-array `content`, openai non-array `choices`,
 *   ollama absent/non-object `message`). Usually a provider API change.
 * - `empty_completion_set` — the container is present but holds no candidate
 *   completion (an empty `content`/`choices` array, or anthropic tool_use-only
 *   blocks). A well-formed response that simply produced no text.
 * - `malformed_block` — a candidate IS present but its text field is the wrong
 *   type (an anthropic `{type:'text', text:<non-string>}`, an openai/ollama
 *   non-string `message.content`). Usually a single corrupt block.
 *
 * ollama has no `empty_completion_set` case — its response is a single message,
 * not a candidate set — so it only ever reports `absent_content`/`malformed_block`.
 * A shared taxonomy need not be surjective per adapter.
 */
export type NoCompletionReason = 'absent_content' | 'malformed_block' | 'empty_completion_set';

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
 * message is the one exception, and names a unique symptom instead). `reason`
 * (#556) sub-classifies the shape failure for diagnostics — the retry class is
 * `permanent` for EVERY reason, so no downstream behaviour reads it.
 */
export function noCompletionFailure(
  kind: LlmConnectionKind,
  reason: NoCompletionReason,
): Extract<ActivityEvent, { type: 'failed' }> {
  return {
    type: 'failed',
    kind: 'permanent',
    error: `${kind} returned a 2xx response with no completion (${reason})`,
  };
}

/**
 * #2 L4b — the single failure event for a `structured` `llm_call` whose 2xx
 * response produced no VALID structured completion: no forced-tool block
 * (Anthropic), a non-string / unparseable-JSON completion (OpenAI/Ollama), or a
 * payload that fails the schema (missing field, wrong type, out-of-enum). Like
 * `noCompletionFailure` it is `permanent` — a 2xx means transport + server
 * succeeded, so an unusable structured body is a response-content problem the
 * identical request won't fix (retry policy gates on `transient`). `kind` names
 * the provider so the durable `error` is traceable, matching the `<kind> HTTP
 * <status>` / `noCompletionFailure` errors.
 *
 * #2 L4c — this is the terminal `runStructuredWithRepair` emits ONLY after every
 * internal repair sub-call has also failed; the FIRST invalid response now
 * triggers a bounded repair re-prompt (same attempt) instead of terminalizing.
 */
export function structuredValidationFailure(
  kind: LlmConnectionKind,
  reason: string,
): Extract<ActivityEvent, { type: 'failed' }> {
  return {
    type: 'failed',
    kind: 'permanent',
    error: `${kind} structured output invalid: ${reason}`,
  };
}

/**
 * #2 L4c — how many INTERNAL repair sub-calls a structured `llm_call` makes after
 * a 2xx response that parsed but produced no schema-valid structured output. `1`
 * = up to ONE repair (≤2 total provider calls per attempt).
 *
 * A CONSTANT, deliberately NOT an author knob: `LlmCallConfig` declares no repair
 * field, and a run REPLAYS from its immutable event log (never by re-calling), so
 * this value never needs version-pinning — changing it alters only how many calls
 * a LIVE dispatch makes, never a past run's recorded outcome (its `metered` +
 * terminal events are already frozen). Kept in ONE place so all three adapters
 * bound repair identically, mirroring how `meterUsage` is the single completeness
 * decision.
 */
export const DEFAULT_STRUCTURED_REPAIRS = 1;

/** A non-system conversation turn — the provider-agnostic shape the loop threads. */
export type LlmTurn = { role: 'user' | 'assistant'; content: string };

/**
 * #2 L4c — the provider-agnostic outcome of ONE structured provider call, mapped
 * by each adapter's `doCall` closure for `runStructuredWithRepair` to drive:
 *
 * - `terminal` — a transport/HTTP/non-JSON failure. NOT repaired: a 5xx/timeout/
 *   cancel is the engine retry policy's job (it gates on `transient`), and a
 *   non-2xx / non-JSON body is not a structured-conformance problem a re-prompt
 *   fixes. The loop yields this event verbatim and stops.
 * - `validated` — a completed 2xx that BILLED (`usage`) whose structured payload
 *   was strict-validated (`result`). `echo` is a bounded, always-non-empty textual
 *   echo of what the model produced, fed into the repair turn on failure.
 */
export type StructuredCallOutcome =
  | { type: 'terminal'; event: Extract<ActivityEvent, { type: 'failed' }> }
  | { type: 'validated'; usage: LlmUsage; result: StructuredValidationResult; echo: string };

/**
 * #2 L4c — a bounded, ALWAYS-NON-EMPTY textual echo of a structured response's
 * payload, to feed back into a repair sub-call so the model sees what it got
 * wrong. A parsed object (Anthropic's forced-tool `input`) is JSON-stringified; a
 * raw completion string (OpenAI/Ollama `message.content`) passes through; an
 * absent / non-stringifiable payload (the no-block or non-string cases, which are
 * now repairable too) becomes a placeholder. NEVER empty: the echo rides the
 * repair turn as `assistant` content (or folded into a `user` turn), and an empty
 * assistant turn is itself an Anthropic 400. Bounded via `errorExcerpt` so a huge
 * payload cannot bloat the repair request or a durable message.
 */
export function structuredEcho(payload: unknown): string {
  let text: string | undefined;
  if (typeof payload === 'string') text = payload;
  else if (payload !== undefined && payload !== null) {
    try {
      // A plain provider JSON value never throws, but a BigInt / circular value
      // would — fall back to the placeholder rather than crash the repair call.
      text = JSON.stringify(payload);
    } catch {
      text = undefined;
    }
  }
  if (text === undefined || text.length === 0) {
    return '(the response contained no valid structured output)';
  }
  return errorExcerpt(text);
}

/**
 * #2 L4c — build the message turns for a structured repair sub-call: the prior
 * turns plus a critique naming the schema failure and asking for a corrected
 * result, with the invalid response echoed back.
 *
 * ROLE ALTERNATION: Anthropic's Messages API requires strictly-alternating
 * user/assistant turns (OpenAI/Ollama are lenient). A v2 `messages[]` may legally
 * END on an `assistant` turn, so appending `assistant`(echo) + `user`(critique)
 * unconditionally would yield `…assistant, assistant, user` and 400 the very
 * repair it is meant to power. So: if the turns already end on `assistant`, the
 * echo is FOLDED into the single appended `user` turn (`…assistant → user`);
 * otherwise the invalid response becomes its own `assistant` turn before the
 * `user` critique (`…user → assistant → user`). Either shape alternates, so every
 * provider accepts the repair request.
 */
export function buildRepairTurns(turns: LlmTurn[], reason: string, echo: string): LlmTurn[] {
  const critique =
    'Your previous response did not satisfy the required structured output schema. ' +
    `Validation error: ${reason}. ` +
    'Respond again with a corrected result that conforms to the schema, and output only that result.';
  const last = turns[turns.length - 1];
  if (last !== undefined && last.role === 'assistant') {
    return [
      ...turns,
      { role: 'user', content: `${critique}\n\nYour previous (invalid) output was:\n${echo}` },
    ];
  }
  return [...turns, { role: 'assistant', content: echo }, { role: 'user', content: critique }];
}

/**
 * #2 L4c — drive a structured `llm_call` with bounded INTERNAL repair. `doCall`
 * performs ONE provider call for the given turns (rebuilding the wire body — the
 * `system` param + structured-mode scaffold — from the non-system turns each
 * time) and maps its result to a `StructuredCallOutcome`.
 *
 * The loop yields the `metered` FACT for EVERY billed call (repair calls bill too
 * — spec: an `activity.metered` per provider response, including repair + failed-
 * but-billed calls), then: a valid result → `succeeded`; an invalid result with
 * repairs remaining → append a repair critique and re-call; an invalid result
 * with none remaining → `structuredValidationFailure` (`permanent`). A `terminal`
 * outcome (transport/HTTP/non-JSON) is yielded verbatim and stops the loop, never
 * repaired.
 *
 * It stays inside ONE engine attempt (the adapter passes the same `attemptId`
 * context to every `llmPost`) and emits EXACTLY ONE terminal, so the node
 * terminalizes once — repair is a sub-call, not a new attempt. A run cancelled
 * between calls is caught by the next `llmPost` (it re-checks `ctx.signal.aborted`
 * at entry and returns a `cancelled` terminal), so no repair fires after abort.
 */
export async function* runStructuredWithRepair(
  provider: LlmConnectionKind,
  initialTurns: LlmTurn[],
  doCall: (turns: LlmTurn[]) => Promise<StructuredCallOutcome>,
): AsyncIterable<ActivityEvent> {
  let turns = initialTurns;
  for (let repairIndex = 0; repairIndex <= DEFAULT_STRUCTURED_REPAIRS; repairIndex++) {
    const outcome = await doCall(turns);
    if (outcome.type === 'terminal') {
      yield outcome.event;
      return;
    }
    yield { type: 'metered', usage: outcome.usage };
    if (outcome.result.ok) {
      yield { type: 'succeeded', outputs: outcome.result.value };
      return;
    }
    if (repairIndex < DEFAULT_STRUCTURED_REPAIRS) {
      turns = buildRepairTurns(turns, outcome.result.reason, outcome.echo);
      continue;
    }
    yield structuredValidationFailure(provider, outcome.result.reason);
    return;
  }
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
 * #2 L3 — lower the portable `reasoningEffort` to OpenAI's `reasoning_effort`
 * vocabulary. Anthropic (`output_config.effort`) and Ollama (`think`) both accept
 * the full `low|medium|high|max` enum verbatim, so ONLY OpenAI needs a mapping:
 * its canonical levels are `low|medium|high` (some newer models also accept
 * `minimal`/`xhigh`, but never `max`), so `max` clamps DOWN to the strongest
 * universally-valid level, `high`. Clamping (not dropping) preserves the author's
 * "maximum reasoning" intent on the provider that lacks a `max` rung. This is the
 * single place that decides the OpenAI lowering, mirroring how `meterUsage` is the
 * single place that classifies usage completeness.
 */
export function openAiReasoningEffort(effort: ReasoningEffort): 'low' | 'medium' | 'high' {
  return effort === 'max' ? 'high' : effort;
}

/** A token count is valid only if it is a non-negative integer. */
function coerceTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * #2 L2 — assemble the metering FACT for one provider response into the shared
 * `LlmUsage` shape (→ the executor's `activity.metered` event). Each adapter maps
 * its provider's token field names (Anthropic `input_tokens`/`output_tokens`,
 * OpenAI `prompt_tokens`/`completion_tokens`, Ollama `prompt_eval_count`/
 * `eval_count`) to the two raw candidates; this is the single place that decides
 * completeness so all three classify identically.
 *
 * WHATEVER IS PRESENT IS KEPT (usage is a fact, never discarded): each token
 * count is stamped iff it is a valid non-negative integer. `meteringStatus` is
 * `metered` ONLY when BOTH counts are valid — a well-formed pair the L6 cost
 * projection can trust; otherwise `unknown` (a provider omitted `usage`, sent a
 * partial count, or a malformed value), while any single valid count still lands.
 * A response reporting `{input:10}` only records `inputTokens:10` + `unknown`, so
 * the completeness gap is visible rather than a manufactured zero.
 */
export function meterUsage(
  provider: LlmConnectionKind,
  model: string,
  inputRaw: unknown,
  outputRaw: unknown,
): LlmUsage {
  const inputTokens = coerceTokenCount(inputRaw);
  const outputTokens = coerceTokenCount(outputRaw);
  const usage: LlmUsage = {
    provider,
    model,
    meteringStatus: inputTokens !== undefined && outputTokens !== undefined ? 'metered' : 'unknown',
  };
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  return usage;
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
