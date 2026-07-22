import { z } from 'zod';
import type { ConnectionKind } from '@autonomy-studio/shared';
import {
  MAX_RETRY_INTERVAL_SECONDS,
  evalToolExpression,
  llmCallConfigSchema,
  normalizeLlmRequest,
  parseAndValidateStructured,
  structuredOutputInstruction,
  toolWireParameters,
  validateStructuredOutput,
} from '@autonomy-studio/shared';
import type {
  LlmCallConfig,
  LlmOutputSchema,
  LlmSampling,
  LlmToolChoice,
  LlmToolDef,
  NormalizedLlmRequest,
  ReasoningEffort,
  StructuredValidationResult,
} from '@autonomy-studio/shared';
import type {
  ActivityContext,
  ActivityEvent,
  ConnectorErrorKind,
  LlmCapture,
  LlmUsage,
  ToolCallTelemetry,
} from './types.js';
import { redactSecrets } from './redact.js';
import { sha256Hex } from '../util/hash.js';

// #2 L1 — the `llm_call` config schema + its normalization are the SSOT in
// `@autonomy-studio/shared`; re-exported here so each adapter imports its LLM
// machinery from ONE module. See `shared/src/catalog/llm-config.ts`. #2 L4b adds
// the runtime structured parse/validate helpers (`shared/src/catalog/llm-structured.ts`).
export {
  llmCallConfigSchema,
  normalizeLlmRequest,
  parseAndValidateStructured,
  structuredOutputInstruction,
  toolWireParameters,
  validateStructuredOutput,
};
export type {
  LlmCallConfig,
  LlmOutputSchema,
  LlmSampling,
  LlmToolChoice,
  LlmToolDef,
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

/**
 * A completed HTTP exchange (any status) OR a terminal failure event.
 *
 * #2 L7 — the `response` variant surfaces the raw `Retry-After` header (or
 * `null`). It is discarded for a 2xx, but on a 429/503 the adapter feeds it
 * through `httpStatusFailure` → `parseRetryAfter` so the retry alarm waits the
 * PROVIDER-instructed time instead of the static `policy.retryIntervalSeconds`.
 */
export type LlmFetchResult =
  | { type: 'response'; status: number; bodyText: string; retryAfterHeader: string | null }
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
    // `Headers.get` is case-insensitive and returns `null` when absent — the exact
    // shape `parseRetryAfter` expects (L7). Captured for every status; only a
    // retryable failure ever reads it.
    return {
      type: 'response',
      status: res.status,
      bodyText,
      retryAfterHeader: res.headers.get('retry-after'),
    };
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

// ---------------------------------------------------------------------------
// #2 L10a/L10b — local tool execution + the BOUNDED tool loop.
//
// The tool CONTRACT (`LlmToolDef` — pure, args-only expressions) is shared
// (`catalog/llm-config.ts`); this block is the driver half: validate the
// model's arguments, evaluate the expression, and drive the bounded tool
// loop (`maxToolIterations` round-trips, absent = 1 — the L10a single
// round-trip) inside ONE engine attempt (the spec's "opaque driver-internal"
// model), with per-executed-call `toolCalled` telemetry and between-rounds
// cancellation. MCP + security policy are L10c.
// ---------------------------------------------------------------------------

/**
 * #2 L10a — the ceiling for one tool result's serialized length. A tool result
 * rides the continuation request (billed input) and, transitively, durable
 * capture/telemetry surfaces — an unbounded expression result (a large mapped
 * array) must not bloat either. Over-cap is an ERROR result the model sees
 * (fail-closed and explicit), never a silent truncation.
 */
export const MAX_TOOL_RESULT_CHARS = 32_000;

/** One tool call as the MODEL requested it, provider-normalized by the adapter.
 *  `id` is the provider's call id (`null` where the provider has none — Ollama);
 *  `name` is `null` for a structurally malformed call (no readable name). */
export interface ToolCallRequest {
  id: string | null;
  name: string | null;
  args: unknown;
}

/** One executed tool call's result, ready for the provider's tool_result shape.
 *  `isError:true` carries a diagnostic the MODEL can recover from in its final
 *  text — a tool-level defect is never a node failure (the node fails only on
 *  transport/shape/budget grounds, same as text mode). */
export interface ToolCallResult {
  id: string | null;
  name: string;
  resultText: string;
  isError: boolean;
}

export type LocalToolExecution = { ok: true; resultText: string } | { ok: false; message: string };

/**
 * #2 L10a — execute ONE local tool call: validate the model-supplied arguments
 * against the tool's declared `parameters` (REUSING `validateStructuredOutput`
 * — strict types, unknown keys stripped, missing-required fails, optionals
 * normalized present-null, the exact #594 contract the wire schema advertises
 * via `toolWireParameters`), then evaluate the pure args-only expression
 * (`evalToolExpression`) and JSON-serialize the result.
 *
 * Every defect returns `{ok:false}` with a bounded message FOR THE MODEL
 * (invalid args, an evaluation throw, an unserializable `undefined`/BigInt
 * result, an over-cap result) — the caller feeds it back as an error
 * tool_result. Expression-error messages are client-safe by construction
 * (`SubstituteError` never echoes resolved values) and the env carries no
 * secrets, so no redaction pass is needed here.
 */
export function executeLocalTool(def: LlmToolDef, rawArgs: unknown): LocalToolExecution {
  const validated = validateStructuredOutput(def.parameters, rawArgs);
  if (!validated.ok) {
    return {
      ok: false,
      message: `invalid arguments for tool '${def.name}': ${errorExcerpt(validated.reason)}`,
    };
  }
  let result: unknown;
  try {
    result = evalToolExpression(def.expression, validated.value);
  } catch (err) {
    return {
      ok: false,
      message: `tool '${def.name}' evaluation failed: ${errorExcerpt(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }
  let text: string | undefined;
  try {
    // `JSON.stringify(undefined)` IS `undefined` (not a throw) — both the
    // throw (BigInt/circular) and the undefined case fold to "unserializable".
    text = JSON.stringify(result);
  } catch {
    text = undefined;
  }
  if (text === undefined) {
    return { ok: false, message: `tool '${def.name}' produced an unserializable result` };
  }
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    return {
      ok: false,
      message:
        `tool '${def.name}' result is too large ` +
        `(${text.length} chars, max ${MAX_TOOL_RESULT_CHARS})`,
    };
  }
  return { ok: true, resultText: text };
}

/**
 * #2 L10a — execute EVERY tool call of one provider response, in provider
 * order. A provider may emit several calls in a single response (Anthropic
 * parallel tool_use blocks, OpenAI `tool_calls[]`); all are executed under the
 * SAME single round-trip — the budget counts provider EXCHANGES, not calls —
 * and each gets exactly one result (a continuation missing any id is a provider
 * 400). An unknown name or a nameless (malformed) call yields an error result
 * the model sees, never a node failure.
 */
export function executeToolCalls(
  tools: readonly LlmToolDef[],
  calls: readonly ToolCallRequest[],
): ToolCallResult[] {
  return calls.map((call) => {
    if (call.name === null) {
      return {
        id: call.id,
        name: '',
        resultText: 'malformed tool call: no tool name',
        isError: true,
      };
    }
    const def = tools.find((t) => t.name === call.name);
    if (def === undefined) {
      return {
        id: call.id,
        name: call.name,
        resultText: `unknown tool '${call.name}'`,
        isError: true,
      };
    }
    const exec = executeLocalTool(def, call.args);
    return exec.ok
      ? { id: call.id, name: call.name, resultText: exec.resultText, isError: false }
      : { id: call.id, name: call.name, resultText: exec.message, isError: true };
  });
}

/**
 * #2 L10b — build the telemetry fact for ONE executed tool call (the
 * `activity.toolCalled` payload minus the executor-stamped ids). Shape only,
 * never text: args are measured over their JSON serialization (key order
 * as-received from the provider — cross-call hash equality is serialization-
 * order-sensitive; unserializable args measure 0), the result over the
 * verbatim `resultText` (error results included — the model sees them). Hashes
 * are OMITTED at 0 chars — fail-closed, never `hash('')` (the #473 lesson);
 * they are `sha256` FINGERPRINTS, not a redaction guarantee (see the
 * `activity.toolCalled` schema doc; #605's keyed-HMAC hardening covers them).
 * `toolName` is the EXECUTED name (`''` for a nameless malformed call).
 */
export function toolCallTelemetry(
  round: number,
  call: ToolCallRequest,
  result: ToolCallResult,
): ToolCallTelemetry {
  let argsJson: string;
  try {
    // `JSON.stringify(undefined)` IS `undefined` (not a throw) — both the
    // throw (BigInt/circular) and the undefined case fold to "measures 0",
    // matching `executeLocalTool`'s serialization guard.
    argsJson = JSON.stringify(call.args) ?? '';
  } catch {
    argsJson = '';
  }
  return {
    round,
    toolName: result.name,
    ...(call.id !== null ? { callId: call.id } : {}),
    argsChars: argsJson.length,
    ...(argsJson.length > 0 ? { argsHash: sha256Hex(argsJson) } : {}),
    resultChars: result.resultText.length,
    ...(result.resultText.length > 0 ? { resultHash: sha256Hex(result.resultText) } : {}),
    isError: result.isError,
  };
}

/**
 * #2 L10a — the provider-agnostic outcome of ONE provider call in a tool flow,
 * mapped by each adapter's `doCall` closure for `runTextWithTools` to drive:
 *
 * - `terminal`  — a transport/HTTP/non-JSON/no-completion failure, yielded
 *   verbatim (the engine retry policy owns transient-ness). `capture` (when the
 *   exchange got far enough to stamp one) preserves the L9a capture-before-
 *   terminal invariant.
 * - `text`      — a completed exchange with a readable text completion: the
 *   billed `usage`, the optional capture fact, and the ready `succeeded` event
 *   (the adapter maps text/stopReason exactly as its plain text path does).
 * - `toolUse`   — the model requested tool call(s): the billed `usage`, the
 *   normalized `calls`, and `buildNext(results)` — the adapter-owned
 *   continuation builder (provider turn shapes are NOT provider-agnostic:
 *   Anthropic replays raw content blocks + tool_result blocks, OpenAI appends
 *   the assistant tool_calls message + role:'tool' messages, Ollama similar) —
 *   returning the next conversation value `C`.
 */
export type ToolRoundOutcome<C> =
  | {
      type: 'terminal';
      event: Extract<ActivityEvent, { type: 'failed' }>;
      capture?: LlmCapture;
    }
  | {
      type: 'text';
      usage: LlmUsage;
      capture?: LlmCapture;
      succeeded: Extract<ActivityEvent, { type: 'succeeded' }>;
    }
  | {
      type: 'toolUse';
      usage: LlmUsage;
      capture?: LlmCapture;
      calls: ToolCallRequest[];
      buildNext: (results: ToolCallResult[]) => C;
    };

/**
 * #2 L10a/L10b — drive a text-mode `llm_call` WITH declared tools through its
 * BOUNDED tool loop, inside ONE engine attempt with EXACTLY ONE terminal (the
 * spec's opaque driver-internal loop — resumable event-modeled loops are a
 * separate sub-spec, not v1).
 *
 * Flow, per exchange: call → (billed → `metered`) → text? → `succeeded` ·
 * toolUse? → execute ALL requested calls locally (`executeToolCalls` — pure,
 * args-only), emit one `toolCalled` telemetry fact per executed call, continue
 * with the adapter-built tool-result conversation. `maxRounds` (the author's
 * `maxToolIterations`, absent = 1 — the L10a single round-trip) bounds how many
 * tool ROUND-TRIPS one attempt may spend: a toolUse response with the budget
 * spent fails `permanent` — after its `metered` (the exchange was billed; the
 * fact is kept regardless of the terminal that follows).
 *
 * CANCELLATION (#2 L10b): `signal` is re-checked after each billed toolUse
 * exchange, BEFORE executing its tools — an aborted run yields a `cancelled`
 * terminal with NO post-abort tool execution and NO post-abort telemetry.
 * `executeToolCalls` is synchronous + pure, so no other abort window exists
 * inside the loop; an abort during the provider call is `llmPost`'s (entry
 * re-check + in-flight abort), exactly as the repair loop is.
 *
 * CHOICE DOWNGRADE (load-bearing): every continuation call passes `auto`,
 * whatever the author's `toolChoice` — a `required` call that stayed forced on
 * continuations could NEVER produce the final text and would fail every
 * `required` node on the budget unconditionally.
 *
 * CAPTURE (#2 L9a): exactly ONE `captured` fact per attempt, for the FIRST
 * exchange (request = the author's turns; completion omitted unless the first
 * response was text) — emitted before any terminal, preserving the
 * capture-precedes-terminal invariant. Continuation exchanges carry provider-
 * specific tool turns `LlmCapture.request` cannot represent; their capture is
 * #605's structured-capture plumbing, not silently hashed wrong here.
 *
 * Metering mirrors the plain text path: every completed-2xx outcome (`text`/
 * `toolUse`) is metered; a `terminal` outcome is not (the text path's existing
 * posture for failed exchanges).
 */
export async function* runTextWithTools<C>(
  provider: LlmConnectionKind,
  tools: readonly LlmToolDef[],
  initial: C,
  initialChoice: LlmToolChoice,
  doCall: (conv: C, choice: LlmToolChoice) => Promise<ToolRoundOutcome<C>>,
  maxRounds: number = 1,
  signal?: AbortSignal,
): AsyncIterable<ActivityEvent> {
  let conv = initial;
  let choice = initialChoice;
  for (let round = 0; ; round++) {
    const outcome = await doCall(conv, choice);
    const firstExchange = round === 0;
    if (outcome.type === 'terminal') {
      if (firstExchange && outcome.capture !== undefined) {
        yield { type: 'captured', capture: outcome.capture };
      }
      yield outcome.event;
      return;
    }
    yield { type: 'metered', usage: outcome.usage };
    if (firstExchange && outcome.capture !== undefined) {
      yield { type: 'captured', capture: outcome.capture };
    }
    if (outcome.type === 'text') {
      yield outcome.succeeded;
      return;
    }
    // Abort is checked BEFORE budget exhaustion: when a run is cancelled while
    // its final (budget-exhausting) exchange was in flight, `cancelled` is the
    // truer terminal for operator intent than `permanent` — either way exactly
    // one terminal, no retry, no further billing.
    if (signal?.aborted === true) {
      yield { type: 'failed', kind: 'cancelled', error: 'llm tool loop aborted' };
      return;
    }
    if (round >= maxRounds) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error:
          `${provider} requested another tool call after the tool budget ` +
          `was exhausted (maxToolIterations: ${maxRounds})`,
      };
      return;
    }
    const results = executeToolCalls(tools, outcome.calls);
    for (const [i, result] of results.entries()) {
      yield { type: 'toolCalled', call: toolCallTelemetry(round, outcome.calls[i]!, result) };
    }
    conv = outcome.buildNext(results);
    choice = 'auto';
  }
}

/**
 * #2 L7 — the ceiling for a provider's `Retry-After` hint. It IS the policy
 * `retryIntervalSeconds` ceiling (imported, not re-declared — one SSOT in
 * `pipeline.ts`): a provider hint feeds the SAME retry-alarm `dueAt` an author-set
 * interval does, so honouring a hint larger than any interval the schema would
 * ACCEPT would let a provider (or a garbage header) park a node for longer than an
 * operator ever could. Clamping here bounds that blast radius without needing the
 * reducer to re-validate a runtime value.
 */
export const MAX_RETRY_AFTER_SECONDS = MAX_RETRY_INTERVAL_SECONDS;

/**
 * #2 L7 — clamp a candidate `Retry-After` seconds value onto the usable range.
 * `< 1` (a zero/negative delta, or an HTTP-date already in the past) → `undefined`:
 * "retry immediately" against a provider that is actively throttling us is a hot
 * loop, so the caller falls back to `policy.retryIntervalSeconds` (floor 30s)
 * instead. A non-finite value is likewise rejected. Above the ceiling clamps DOWN.
 */
function clampRetryAfter(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds < 1) return undefined;
  return Math.min(Math.trunc(seconds), MAX_RETRY_AFTER_SECONDS);
}

/**
 * #2 L7 — parse an RFC-9110 `Retry-After` header into a bounded seconds hint for
 * the retry alarm, or `undefined` when it carries nothing usable (absent header,
 * a past date, a zero/garbage value) — in which case the driver falls back to the
 * node's `policy.retryIntervalSeconds`. Two legal forms:
 *  - **delta-seconds** — a non-negative integer (`Retry-After: 120`). What the
 *    first-party Anthropic/OpenAI APIs send.
 *  - **HTTP-date** — an absolute instant (`Retry-After: Wed, 21 Oct 2015 …`);
 *    converted to a delta from `nowMs` and rounded UP (never retry a hair early).
 *
 * `nowMs` is passed in (not read here) so the parse is a pure, unit-testable
 * function; the adapter supplies `Date.now()` at capture time. The value is
 * captured once, frozen onto the durable `node.failed` event, and folded
 * deterministically on replay — the clock is read exactly once, impurely, in the
 * adapter, never in the reducer.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  // delta-seconds: a bare non-negative integer (a decimal like `120.5` is neither
  // a valid delta-seconds nor a date, so it falls through to `undefined`).
  if (/^\d+$/.test(trimmed)) return clampRetryAfter(Number(trimmed));
  // HTTP-date: absolute instant → delta from now, rounded up.
  const whenMs = Date.parse(trimmed);
  if (Number.isNaN(whenMs)) return undefined;
  return clampRetryAfter(Math.ceil((whenMs - nowMs) / 1000));
}

/**
 * #2 L7 — the SINGLE builder for a non-2xx LLM response's terminal `failed`
 * event, so all three adapters classify (and now carry retry-after) identically.
 * `provider` is the connection-kind label for the `<provider> HTTP <status>`
 * message (matching `noCompletionFailure`/`structuredValidationFailure`); the
 * event's own `kind` comes from `classifyHttpStatus`.
 *
 * The parsed `retryAfterSeconds` hint is attached ONLY when the failure is
 * RETRYABLE (`rate_limit`/`transient`): a `permanent`/`auth` failure never
 * retries (`retryEligible` gates on the engine's `transient`), so a `Retry-After`
 * riding a 400/401 is meaningless and carrying it would be misleading noise. An
 * absent/useless header simply omits the field → the driver uses the policy
 * interval.
 *
 * Returns the BARE `failed` event; the structured-path callers
 * (`runStructuredWithRepair`'s `doCall`) wrap it in `{type:'terminal', event}`
 * themselves, exactly as they do today with the inline construction.
 */
export function httpStatusFailure(
  provider: LlmConnectionKind,
  status: number,
  bodyText: string,
  retryAfterHeader: string | null,
  nowMs: number,
): Extract<ActivityEvent, { type: 'failed' }> {
  const kind = classifyHttpStatus(status);
  const event: Extract<ActivityEvent, { type: 'failed' }> = {
    type: 'failed',
    kind,
    error: `${provider} HTTP ${status}: ${errorExcerpt(bodyText)}`,
  };
  if (kind === 'rate_limit' || kind === 'transient') {
    const retryAfterSeconds = parseRetryAfter(retryAfterHeader, nowMs);
    if (retryAfterSeconds !== undefined) event.retryAfterSeconds = retryAfterSeconds;
  }
  return event;
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
 * #2 L9a — assemble the debugging CAPTURE fact for one provider response into the
 * shared `LlmCapture` shape (→ the executor's `activity.captured` event). ONE per
 * provider response, mirroring `meterUsage`/`activity.metered`.
 *
 * REDACTED BY CONSTRUCTION — carries NO raw text: each message/system/completion
 * yields `{ chars, contentHash }` (length + `sha256` fingerprint), the spec's
 * "log hash/length/token-count, not text" default. `chars` is UTF-16 string
 * length (a length metric, not a grapheme count); the token-count half lives on
 * `activity.metered`. `contentHash` is a drift/reproducibility fingerprint, NOT a
 * redaction guarantee (see `sha256Hex`).
 *
 * FAIL-CLOSED on absence: `system` is omitted when no system instruction was sent,
 * and `completion` is omitted when `completionText` is undefined (a failure before
 * a readable completion) — an absent completion is ABSENT, never `hash('')`, which
 * would manufacture a benign fact.
 */
export function buildCapture(args: {
  provider: LlmConnectionKind;
  model: string;
  latencyMs: number;
  turns: LlmTurn[];
  system?: string;
  completionText?: string;
}): LlmCapture {
  const { provider, model, latencyMs, turns, system, completionText } = args;
  const capture: LlmCapture = {
    provider,
    model,
    latencyMs,
    request: {
      messageCount: turns.length,
      messages: turns.map((t) => ({
        role: t.role,
        chars: t.content.length,
        contentHash: sha256Hex(t.content),
      })),
    },
  };
  if (system !== undefined) {
    capture.request.system = { chars: system.length, contentHash: sha256Hex(system) };
  }
  if (completionText !== undefined) {
    capture.completion = { chars: completionText.length, contentHash: sha256Hex(completionText) };
  }
  return capture;
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
