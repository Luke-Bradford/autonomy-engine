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
  parseAndValidateStructured,
  parseJsonBody,
  resolveModel,
  structuredOutputInstruction,
  structuredValidationFailure,
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

    const {
      system,
      messages: turns,
      sampling,
      reasoningEffort,
      structuredOutput,
    } = normalizeLlmRequest(input.data);
    // Ollama's `/api/chat` carries the system instruction as a LEADING
    // `role:system` message; sampling lives under `options` (`num_predict` is
    // its name for max output tokens). #2 L4b — a structured node appends the
    // schema directive to system (belt-and-suspenders alongside the native
    // `format` below; harmless if `format` alone already constrains the model).
    const systemParts: string[] = [];
    if (system !== undefined) systemParts.push(system);
    if (structuredOutput !== undefined)
      systemParts.push(structuredOutputInstruction(structuredOutput));
    const messages: { role: string; content: string }[] = [];
    if (systemParts.length > 0)
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    messages.push(...turns);
    const options: Record<string, unknown> = {};
    if (sampling.temperature !== undefined) options.temperature = sampling.temperature;
    if (sampling.maxTokens !== undefined) options.num_predict = sampling.maxTokens;
    if (sampling.topP !== undefined) options.top_p = sampling.topP;
    if (sampling.stop !== undefined) options.stop = sampling.stop;
    if (sampling.seed !== undefined) options.seed = sampling.seed;
    const requestBody: Record<string, unknown> = { model, messages, stream: false };
    if (Object.keys(options).length > 0) requestBody.options = options;
    // #2 L4b — Ollama's NATIVE structured output: the TOP-LEVEL `format` accepts a
    // JSON Schema and constrains decoding to it. Ollama is lenient about schema
    // shape (unlike OpenAI strict json_schema), so the L4a subset — including its
    // loose nested `object`/`array` — passes through as-is. The strict parse/validate
    // of the response is still the correctness guarantee (a model may ignore `format`).
    if (structuredOutput !== undefined) requestBody.format = structuredOutput;
    // #2 L3 — Ollama's `/api/chat` takes reasoning as the TOP-LEVEL `think` param
    // (NOT under `options`), which accepts a boolean OR a level string, so our
    // enum passes through verbatim. Best-effort per the spec ("ollama/others:
    // best-effort or ignored"): Ollama documents `low|medium|high` levels (e.g.
    // gpt-oss); `max` is NOT a documented Ollama level, so `think:'max'` is
    // best-effort and may be ignored or rejected by a given model. A thinking
    // model separates its reasoning trace; a non-thinking model ignores the
    // field. No key when unset, so a node with no `reasoningEffort` is
    // byte-identical to pre-L3.
    if (reasoningEffort !== undefined) requestBody.think = reasoningEffort;

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
    // #2 L4b — STRUCTURED path. Meter FIRST (a 2xx billed, even if invalid), then
    // parse+validate `message.content` as JSON against the schema. An absent message
    // or a non-string content yields `undefined`, which `parseAndValidateStructured`
    // rejects (→ `permanent`), covering the no-completion case here too.
    if (structuredOutput !== undefined) {
      const structuredCounts = parsed.json as {
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      yield {
        type: 'metered',
        usage: meterUsage(
          'ollama',
          model,
          structuredCounts.prompt_eval_count,
          structuredCounts.eval_count,
        ),
      };
      const structuredMessage = (parsed.json as { message?: { content?: unknown } }).message;
      const validated = parseAndValidateStructured(structuredOutput, structuredMessage?.content);
      if (!validated.ok) {
        yield structuredValidationFailure('ollama', validated.reason);
        return;
      }
      yield { type: 'succeeded', outputs: validated.value };
      return;
    }
    // #461 — a present string (even '') is a real completion; anything else is
    // NO completion → fail rather than succeed with ''. Sub-classified for
    // diagnostics (#556): an absent/non-object `message` is `absent_content`; a
    // present message whose `content` is non-string/absent is `malformed_block`.
    // ollama has no `empty_completion_set` — its response is a single message,
    // not a candidate set (see `NoCompletionReason`).
    const message = (parsed.json as { message?: { content?: unknown } }).message;
    if (typeof message !== 'object' || message === null) {
      yield noCompletionFailure('ollama', 'absent_content');
      return;
    }
    const text = message.content;
    if (typeof text !== 'string') {
      yield noCompletionFailure('ollama', 'malformed_block');
      return;
    }
    // #2 L2 — capture the metering fact before the terminal event. Ollama reports
    // token counts at the TOP LEVEL (`prompt_eval_count`/`eval_count`), not under
    // a `usage` object; a model still warming up may omit them → `unknown`.
    const counts = parsed.json as { prompt_eval_count?: unknown; eval_count?: unknown };
    yield {
      type: 'metered',
      usage: meterUsage('ollama', model, counts.prompt_eval_count, counts.eval_count),
    };
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
