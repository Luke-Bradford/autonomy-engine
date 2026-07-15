import { z } from 'zod';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  classifyHttpStatus,
  coerceStopReason,
  errorExcerpt,
  llmConnectionConfigSchema,
  llmPost,
  llmProbeGet,
  llmRequestInputSchema,
  parseJsonBody,
  resolveModel,
} from './llm-shared.js';

/**
 * The `anthropic_api` connector adapter: a single non-streaming call to the
 * Anthropic Messages API (`POST /v1/messages`) using Node's global `fetch` — no
 * paid SDK. The resolved `secret` is the API key, sent as the `x-api-key`
 * header (never surfaced in outputs or errors); the `llm_call` activity supplies
 * `prompt` / `system` / `model` / `maxTokens` / `temperature`.
 *
 * A completed 2xx response yields `succeeded{ text, stopReason }` — `text` is
 * the concatenation of the response's `text`-type content blocks; `stopReason`
 * is the API's `stop_reason` via `coerceStopReason` (which keeps the declared
 * `string` type when the field is absent). A non-2xx is a real failure (no completion),
 * mapped by `classifyHttpStatus`. The whole exchange is bounded by a timeout
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

/** Concatenate the `text`-type content blocks of a Messages API response. */
function extractText(json: unknown): string {
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text',
    )
    .map((b) => b.text)
    .join('');
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
    const input = llmRequestInputSchema.safeParse(ctx.input);
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

    const model = resolveModel(input.data, config.data, DEFAULT_MODEL);
    const baseUrl = (config.data.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    const requestBody: Record<string, unknown> = {
      model,
      max_tokens: input.data.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: input.data.prompt }],
    };
    if (input.data.system !== undefined) requestBody.system = input.data.system;
    if (input.data.temperature !== undefined) requestBody.temperature = input.data.temperature;

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
    yield {
      type: 'succeeded',
      outputs: {
        text: extractText(parsed.json),
        stopReason: coerceStopReason((parsed.json as { stop_reason?: unknown }).stop_reason),
      },
    };
  },
};
