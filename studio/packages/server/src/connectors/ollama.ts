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
  runStructuredWithRepair,
  structuredEcho,
  structuredOutputInstruction,
} from './llm-shared.js';
import type { LlmTurn } from './llm-shared.js';

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
    const baseUrl = (config.data.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/api/chat`;
    const headers: Record<string, string> =
      secret !== null ? { Authorization: `Bearer ${secret}` } : {};
    const timeoutMs = config.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

    // Ollama's `/api/chat` carries the system instruction as a LEADING
    // `role:system` message. #2 L4b — a structured node appends the schema directive
    // to system (belt-and-suspenders alongside the native `format`; harmless if
    // `format` alone already constrains the model).
    const systemParts: string[] = [];
    if (system !== undefined) systemParts.push(system);
    if (structuredOutput !== undefined)
      systemParts.push(structuredOutputInstruction(structuredOutput));
    const systemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    // Assemble the wire body for a set of (non-system) turns. Only `messages`
    // changes across L4c repair calls, so the static scaffold is rebuilt from the
    // passed turns each call. Sampling (under `options`) + `think` apply in BOTH
    // modes; `format` only in structured mode (so text mode is byte-identical to
    // pre-L4c).
    const buildBody = (msgTurns: LlmTurn[]): Record<string, unknown> => {
      const messages: { role: string; content: string }[] = [];
      if (systemContent !== undefined) messages.push({ role: 'system', content: systemContent });
      messages.push(...msgTurns);
      const options: Record<string, unknown> = {};
      if (sampling.temperature !== undefined) options.temperature = sampling.temperature;
      if (sampling.maxTokens !== undefined) options.num_predict = sampling.maxTokens;
      if (sampling.topP !== undefined) options.top_p = sampling.topP;
      if (sampling.stop !== undefined) options.stop = sampling.stop;
      if (sampling.seed !== undefined) options.seed = sampling.seed;
      const body: Record<string, unknown> = { model, messages, stream: false };
      if (Object.keys(options).length > 0) body.options = options;
      // #2 L4b — Ollama's NATIVE structured output: the TOP-LEVEL `format` accepts a
      // JSON Schema and constrains decoding. Ollama is lenient about schema shape
      // (unlike OpenAI strict json_schema), so the L4a subset — including its loose
      // nested `object`/`array` — passes through as-is; the strict parse/validate of
      // the response is still the correctness guarantee (a model may ignore `format`).
      if (structuredOutput !== undefined) body.format = structuredOutput;
      // #2 L3 — reasoning is the TOP-LEVEL `think` param (NOT under `options`),
      // accepting a boolean OR level string, so our enum passes through verbatim.
      // Best-effort ("ollama/others: best-effort or ignored"): `max` is not a
      // documented Ollama level and may be ignored/rejected. No key when unset, so
      // a node with no `reasoningEffort` is byte-identical to pre-L3.
      if (reasoningEffort !== undefined) body.think = reasoningEffort;
      return body;
    };

    // #2 L4c — STRUCTURED path with bounded internal repair. Each call meters (a
    // 2xx billed even if invalid), parses+validates `message.content`; an absent
    // message or non-string content yields `undefined`, which
    // `parseAndValidateStructured` rejects → the loop re-prompts before
    // terminalizing `permanent`. Covers the no-completion case here too.
    if (structuredOutput !== undefined) {
      yield* runStructuredWithRepair('ollama', turns, async (msgTurns) => {
        const res = await llmPost(ctx, url, headers, buildBody(msgTurns), timeoutMs);
        if (res.type === 'failed') return { type: 'terminal', event: res.event };
        if (res.status < 200 || res.status >= 300) {
          return {
            type: 'terminal',
            event: {
              type: 'failed',
              kind: classifyHttpStatus(res.status),
              error: `ollama HTTP ${res.status}: ${errorExcerpt(res.bodyText)}`,
            },
          };
        }
        const body = parseJsonBody(res.bodyText);
        if (!body.ok) return { type: 'terminal', event: body.event };
        const counts = body.json as { prompt_eval_count?: unknown; eval_count?: unknown };
        const usage = meterUsage('ollama', model, counts.prompt_eval_count, counts.eval_count);
        const content = (body.json as { message?: { content?: unknown } }).message?.content;
        return {
          type: 'validated',
          usage,
          result: parseAndValidateStructured(structuredOutput, content),
          echo: structuredEcho(content),
        };
      });
      return;
    }

    // TEXT path.
    const result = await llmPost(ctx, url, headers, buildBody(turns), timeoutMs);
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
