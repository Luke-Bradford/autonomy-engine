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
  noCompletionFailure,
  parseJsonBody,
  resolveModel,
} from './llm-shared.js';

/**
 * The `openai_api` connector adapter: a single non-streaming call to the
 * OpenAI-compatible Chat Completions API (`POST {base}/chat/completions`) using
 * Node's global `fetch` — no paid SDK. The resolved `secret` is the API key,
 * sent as `Authorization: Bearer <key>` (never surfaced). Because `baseUrl`
 * overrides the host, this also drives any OpenAI-compatible gateway (Together,
 * Groq, OpenRouter, a local vLLM, …).
 *
 * There is NO safe universal default model, so a call with neither a node
 * `model` nor a connection default `model` fails `permanent` with a clear
 * message rather than guessing. A 2xx with a readable completion yields
 * `succeeded{ text, stopReason }` from `choices[0]` (`stopReason` via
 * `coerceStopReason`, which keeps the declared `string` type when a gateway
 * omits `finish_reason`); a 2xx carrying NO completion (no `choices`, no
 * `message`, non-string `content`) fails `permanent` via `noCompletionFailure`
 * (#461) rather than manufacturing `text:''`; a non-2xx is mapped by
 * `classifyHttpStatus`.
 */

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export const openaiAdapter: ConnectorAdapter = {
  kind: 'openai_api',
  configSchema: llmConnectionConfigSchema,

  async testConnection(config, secret) {
    const parsed = llmConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, error: `invalid openai_api connection config: ${parsed.error.message}` };
    }
    if (secret === null) {
      return { ok: false, error: 'openai_api connection requires a secret (API key)' };
    }
    const baseUrl = (parsed.data.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    return llmProbeGet(
      `${baseUrl}/models`,
      { Authorization: `Bearer ${secret}` },
      parsed.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    );
  },

  async *runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent> {
    const config = llmConnectionConfigSchema.safeParse(ctx.connectionConfig);
    if (!config.success) {
      yield { type: 'failed', kind: 'permanent', error: 'invalid openai_api connection config' };
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
    if (secret === null) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: 'openai_api connection requires a secret (API key)',
      };
      return;
    }
    const model = resolveModel(input.data, config.data);
    if (model === null) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error:
          'openai_api call has no model (set the node `model` or the connection default `model`)',
      };
      return;
    }

    const messages: { role: string; content: string }[] = [];
    if (input.data.system !== undefined)
      messages.push({ role: 'system', content: input.data.system });
    messages.push({ role: 'user', content: input.data.prompt });
    const requestBody: Record<string, unknown> = { model, messages };
    if (input.data.maxTokens !== undefined) requestBody.max_tokens = input.data.maxTokens;
    if (input.data.temperature !== undefined) requestBody.temperature = input.data.temperature;

    const baseUrl = (config.data.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    const result = await llmPost(
      ctx,
      `${baseUrl}/chat/completions`,
      { Authorization: `Bearer ${secret}` },
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
        error: `openai_api HTTP ${result.status}: ${errorExcerpt(result.bodyText)}`,
      };
      return;
    }
    const parsed = parseJsonBody(result.bodyText);
    if (!parsed.ok) {
      yield parsed.event;
      return;
    }
    const choice = (parsed.json as { choices?: unknown }).choices;
    const first = Array.isArray(choice) ? choice[0] : undefined;
    const text = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
    // #461 — a present string (even '') is a real completion; anything else
    // (no choices, no message, non-string/null content) is NO completion → fail.
    if (typeof text !== 'string') {
      yield noCompletionFailure('openai_api');
      return;
    }
    yield {
      type: 'succeeded',
      outputs: {
        text,
        stopReason: coerceStopReason(
          (first as { finish_reason?: unknown } | undefined)?.finish_reason,
        ),
      },
    };
  },
};
