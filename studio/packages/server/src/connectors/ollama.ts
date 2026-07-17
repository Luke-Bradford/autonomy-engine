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
  noCompletionFailure,
  normalizeLlmRequest,
  parseJsonBody,
  resolveModel,
} from './llm-shared.js';

/**
 * The `ollama` connector adapter: a single non-streaming call to a local (or
 * self-hosted) Ollama server's chat endpoint (`POST {base}/api/chat` with
 * `stream:false`). Ollama runs locally and needs NO credential, so `secret` is
 * normally `null`; if a Connection nonetheless carries one (e.g. a reverse
 * proxy in front of Ollama enforces a bearer token) it is sent as
 * `Authorization: Bearer <secret>` and never surfaced.
 *
 * Like `openai_api`, there is no safe default model — a call with no resolvable
 * `model` fails `permanent`. A 2xx with a readable completion yields
 * `succeeded{ text, stopReason }` from the response's `message.content` /
 * `done_reason` (the latter via `coerceStopReason`, shared with the other two
 * adapters since #457); a 2xx with no `message.content` string fails `permanent`
 * via `noCompletionFailure` (#461) rather than succeeding with `text:''`.
 */

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';

export const ollamaAdapter: ConnectorAdapter = {
  kind: 'ollama',
  configSchema: llmConnectionConfigSchema,

  async testConnection(config, secret) {
    const parsed = llmConnectionConfigSchema.safeParse(config);
    if (!parsed.success) {
      return { ok: false, error: `invalid ollama connection config: ${parsed.error.message}` };
    }
    const baseUrl = (parsed.data.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    return llmProbeGet(
      `${baseUrl}/api/tags`,
      secret !== null ? { Authorization: `Bearer ${secret}` } : {},
      parsed.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    );
  },

  async *runActivity(ctx: ActivityContext, secret: string | null): AsyncIterable<ActivityEvent> {
    const config = llmConnectionConfigSchema.safeParse(ctx.connectionConfig);
    if (!config.success) {
      yield { type: 'failed', kind: 'permanent', error: 'invalid ollama connection config' };
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
    const model = resolveModel(input.data, config.data);
    if (model === null) {
      yield {
        type: 'failed',
        kind: 'permanent',
        error: 'ollama call has no model (set the node `model` or the connection default `model`)',
      };
      return;
    }

    const { system, messages: turns, sampling } = normalizeLlmRequest(input.data);
    // Ollama's `/api/chat` carries the system instruction as a LEADING
    // `role:system` message; sampling lives under `options` (`num_predict` is
    // its name for max output tokens).
    const messages: { role: string; content: string }[] = [];
    if (system !== undefined) messages.push({ role: 'system', content: system });
    messages.push(...turns);
    const options: Record<string, unknown> = {};
    if (sampling.temperature !== undefined) options.temperature = sampling.temperature;
    if (sampling.maxTokens !== undefined) options.num_predict = sampling.maxTokens;
    if (sampling.topP !== undefined) options.top_p = sampling.topP;
    if (sampling.stop !== undefined) options.stop = sampling.stop;
    if (sampling.seed !== undefined) options.seed = sampling.seed;
    const requestBody: Record<string, unknown> = { model, messages, stream: false };
    if (Object.keys(options).length > 0) requestBody.options = options;

    const baseUrl = (config.data.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    const result = await llmPost(
      ctx,
      `${baseUrl}/api/chat`,
      secret !== null ? { Authorization: `Bearer ${secret}` } : {},
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
        error: `ollama HTTP ${result.status}: ${errorExcerpt(result.bodyText)}`,
      };
      return;
    }
    const parsed = parseJsonBody(result.bodyText);
    if (!parsed.ok) {
      yield parsed.event;
      return;
    }
    const message = (parsed.json as { message?: { content?: unknown } }).message;
    const text = message?.content;
    // #461 — a present string (even '') is a real completion; a missing message
    // or non-string content is NO completion → fail rather than succeed with ''.
    if (typeof text !== 'string') {
      yield noCompletionFailure('ollama');
      return;
    }
    const doneReason = (parsed.json as { done_reason?: unknown }).done_reason;
    yield {
      type: 'succeeded',
      outputs: {
        text,
        stopReason: coerceStopReason(doneReason),
      },
    };
  },
};
