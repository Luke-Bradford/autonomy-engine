import { z } from 'zod';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  classifyHttpStatus,
  coerceStopReason,
  errorExcerpt,
  llmCallConfigSchema,
  llmConnectionConfigSchema,
  llmPost,
  llmProbeGet,
  meterUsage,
  noCompletionFailure,
  normalizeLlmRequest,
  parseJsonBody,
  resolveModel,
} from './llm-shared.js';
import type { NoCompletionReason } from './llm-shared.js';

/**
 * The `anthropic_api` connector adapter: a single non-streaming call to the
 * Anthropic Messages API (`POST /v1/messages`) using Node's global `fetch` — no
 * paid SDK. The resolved `secret` is the API key, sent as the `x-api-key`
 * header (never surfaced in outputs or errors); the `llm_call` activity supplies
 * `prompt` / `system` / `model` / `maxTokens` / `temperature`.
 *
 * A completed 2xx response with a text completion yields `succeeded{ text,
 * stopReason }` — `text` is the concatenation of the response's `text`-type
 * content blocks; `stopReason` is the API's `stop_reason` via `coerceStopReason`
 * (which keeps the declared `string` type when the field is absent). A 2xx with
 * NO text completion (absent/non-array `content`, or zero text blocks) fails
 * `permanent` via `noCompletionFailure` (#461) rather than succeeding with
 * `text:''`. A non-2xx is a real failure (no completion), mapped by
 * `classifyHttpStatus`. The whole exchange is bounded by a timeout
 * (default 120s, overridable via `config.timeoutMs`) so a hung provider can
 * never permanently hold a worker-pool slot.
 */

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
/** The Messages API REQUIRES max_tokens; used when the node sets none. */
const DEFAULT_MAX_TOKENS = 1024;
/** The default model when neither the node nor the connection specifies one. */
const DEFAULT_MODEL = 'claude-opus-4-8';

const anthropicConnectionConfigSchema = llmConnectionConfigSchema.extend({
  /** The `anthropic-version` header value. Defaults to `2023-06-01`. */
  anthropicVersion: z.string().optional(),
});

/**
 * Concatenate the `text`-type content blocks of a Messages API response, or
 * `null` when the response carries NO text completion (#461): a non-array
 * `content` (absent/malformed), an empty array, or an array with zero
 * text-type blocks whose `text` is a string (a tool_use-only response, or a
 * malformed `{type:'text', text: <non-string>}` block — text-mode `llm_call`
 * sends no tools, so this is treated as no-completion and revisited at L4b/L10). A
 * present text block whose text is `''` is a REAL (if empty) completion and
 * returns `''`, NOT `null`.
 */
function extractText(json: unknown): { text: string } | { reason: NoCompletionReason } {
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return { reason: 'absent_content' };
  const textBlocks = content.filter(
    (b): b is { type: string; text: string } =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string',
  );
  // ≥1 VALID text block is a real completion — a mix of valid + malformed/tool_use
  // blocks still succeeds on the valid text (unchanged behaviour). Only zero valid
  // text blocks is a no-completion, sub-classified for diagnostics (#556): a
  // `type:'text'` block with a NON-string `text` is a single corrupt block
  // (`malformed_block`); an empty array or tool_use-only response produced no text
  // candidate (`empty_completion_set`).
  if (textBlocks.length > 0) return { text: textBlocks.map((b) => b.text).join('') };
  const hasMalformedTextBlock = content.some(
    (b) =>
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: unknown }).type === 'text' &&
      typeof (b as { text?: unknown }).text !== 'string',
  );
  return { reason: hasMalformedTextBlock ? 'malformed_block' : 'empty_completion_set' };
}

export const anthropicAdapter: ConnectorAdapter = {
  kind: 'anthropic_api',
  configSchema: anthropicConnectionConfigSchema,

  async testConnection(config, secret) {
    const parsed = anthropicConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return {
        ok: false,
        error: `invalid anthropic_api connection config: ${parsed.error.message}`,
      };
    }
    if (secret === null) {
      return { ok: false, error: 'anthropic_api connection requires a secret (API key)' };
    }
    const baseUrl = (parsed.data.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    return llmProbeGet(
      `${baseUrl}/v1/models`,
      {
        'x-api-key': secret,
        'anthropic-version': parsed.data.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      },
      parsed.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    );
  },

  async *runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent> {
    const config = anthropicConnectionConfigSchema.safeParse(ctx.connectionConfig);
    if (!config.success) {
      yield { type: 'failed', kind: 'permanent', error: 'invalid anthropic_api connection config' };
      return;
    }
    const input = llmCallConfigSchema.safeParse(ctx.input);
    if (!input.success) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: `invalid llm_call activity config: ${input.error.message}`,
      };
      return;
    }
    // The API key is required — fail loud (and BEFORE any request) rather than
    // send an unauthenticated call the provider would reject anyway.
    if (secret === null) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: 'anthropic_api connection requires a secret (API key)',
      };
      return;
    }

    // The `DEFAULT_MODEL` fallback makes this non-null; the `?? DEFAULT_MODEL`
    // narrows the `string | null` return to `string` for `meterUsage` (which
    // needs a resolved model) without changing behaviour.
    const model = resolveModel(input.data, config.data, DEFAULT_MODEL) ?? DEFAULT_MODEL;
    const { system, messages, sampling, reasoningEffort } = normalizeLlmRequest(input.data);
    const baseUrl = (config.data.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    // The Messages API takes `system` as a top-level param (not a message), so
    // the normalized system string lands here; sampling maps to Anthropic's
    // names (`top_p`, `stop_sequences`), and it has no `seed`, so that knob is
    // dropped for this provider (documented asymmetry, #2 L1).
    const requestBody: Record<string, unknown> = {
      model,
      max_tokens: sampling.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    if (system !== undefined) requestBody.system = system;
    if (sampling.temperature !== undefined) requestBody.temperature = sampling.temperature;
    if (sampling.topP !== undefined) requestBody.top_p = sampling.topP;
    if (sampling.stop !== undefined) requestBody.stop_sequences = sampling.stop;
    // #2 L3 — reasoning effort. The MODERN Messages-API surface is adaptive
    // thinking + `output_config.effort`; the older `thinking:{enabled,budget_tokens}`
    // is REMOVED (HTTP 400) on every current model, including the DEFAULT_MODEL
    // `claude-opus-4-8` — so the spec's "extended-thinking budget" prose (dated
    // 2026-07-14) is lowered to the current wire mechanism. Both keys are emitted
    // together: `output_config.effort` sets the depth, `thinking:{adaptive}` turns
    // reasoning ON (omitting it leaves Opus 4.8 non-thinking, making effort inert).
    // CAVEAT: thinking tokens count against `max_tokens` (default 1024) — an author
    // pairing a high effort with a low `maxTokens` may get a truncated/short answer;
    // raise `maxTokens` accordingly. Only fires when the author opted in, so a node
    // with no `reasoningEffort` is byte-identical to a pre-L3 request. (An older
    // model that predates `output_config`/adaptive rejects this with a clear
    // provider 400 — a genuine permanent failure, not a silent wrong result.)
    if (reasoningEffort !== undefined) {
      requestBody.thinking = { type: 'adaptive' };
      requestBody.output_config = { effort: reasoningEffort };
    }

    const result = await llmPost(
      ctx,
      `${baseUrl}/v1/messages`,
      {
        'x-api-key': secret,
        'anthropic-version': config.data.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
      },
      requestBody,
      config.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    );
    if (result.type === 'failed') {
      yield result.event;
      return;
    }
    if (result.status < 200 || result.status >= 300) {
      yield {
        type: 'failed',
        kind: classifyHttpStatus(result.status),
        error: `anthropic_api HTTP ${result.status}: ${errorExcerpt(result.bodyText)}`,
      };
      return;
    }
    const parsed = parseJsonBody(result.bodyText);
    if (!parsed.ok) {
      yield parsed.event;
      return;
    }
    const extracted = extractText(parsed.json);
    if ('reason' in extracted) {
      yield noCompletionFailure('anthropic_api', extracted.reason);
      return;
    }
    // #2 L2 — capture the metering fact before the terminal event. The Messages
    // API reports `usage.{input_tokens, output_tokens}`; `meterUsage` records
    // whatever is a valid non-negative integer and flags completeness.
    const usage = (parsed.json as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })
      .usage;
    yield {
      type: 'metered',
      usage: meterUsage('anthropic_api', model, usage?.input_tokens, usage?.output_tokens),
    };
    yield {
      type: 'succeeded',
      outputs: {
        text: extracted.text,
        stopReason: coerceStopReason((parsed.json as { stop_reason?: unknown }).stop_reason),
      },
    };
  },
};
