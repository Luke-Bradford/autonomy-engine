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
 * The `ollama` connector adapter: a single non-streaming call to a local (or
 * self-hosted) Ollama server's chat endpoint (`POST {base}/api/chat` with
 * `stream:false`). Ollama runs locally and needs NO credential, so `secret` is
 * normally `null`; if a Connection nonetheless carries one (e.g. a reverse
 * proxy in front of Ollama enforces a bearer token) it is sent as
 * `Authorization: Bearer <secret>` and never surfaced.
 *
 * Like `openai_api`, there is no safe default model — a call with no resolvable
 * `model` fails `permanent`. A 2xx yields `succeeded{ text, stopReason }` from
 * the response's `message.content` / `done_reason` (the latter via
 * `coerceStopReason`, shared with the other two adapters since #457).
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
    const input = llmRequestInputSchema.safeParse(ctx.input);
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

    const messages: { role: string; content: string }[] = [];
    if (input.data.system !== undefined)
      messages.push({ role: 'system', content: input.data.system });
    messages.push({ role: 'user', content: input.data.prompt });
    const options: Record<string, unknown> = {};
    if (input.data.temperature !== undefined) options.temperature = input.data.temperature;
    if (input.data.maxTokens !== undefined) options.num_predict = input.data.maxTokens;
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
    const doneReason = (parsed.json as { done_reason?: unknown }).done_reason;
    yield {
      type: 'succeeded',
      outputs: {
        text: typeof text === 'string' ? text : '',
        stopReason: coerceStopReason(doneReason),
      },
    };
  },
};
