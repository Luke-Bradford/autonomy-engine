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
  openAiReasoningEffort,
  parseAndValidateStructured,
  parseJsonBody,
  resolveModel,
  structuredOutputInstruction,
  structuredValidationFailure,
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
    const input = llmCallConfigSchema.safeParse(ctx.input);
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

    const {
      system,
      messages: turns,
      sampling,
      reasoningEffort,
      structuredOutput,
    } = normalizeLlmRequest(input.data);
    // Chat Completions carries the system instruction as a LEADING `role:system`
    // message (not a top-level param), then the ordered non-system turns. #2 L4b —
    // a structured node appends the schema directive to the system content: OpenAI's
    // `response_format:json_object` REQUIRES the literal token "JSON" in the prompt,
    // which `structuredOutputInstruction` guarantees, and the schema steers the model.
    const systemParts: string[] = [];
    if (system !== undefined) systemParts.push(system);
    if (structuredOutput !== undefined)
      systemParts.push(structuredOutputInstruction(structuredOutput));
    const messages: { role: string; content: string }[] = [];
    if (systemParts.length > 0)
      messages.push({ role: 'system', content: systemParts.join('\n\n') });
    messages.push(...turns);
    const requestBody: Record<string, unknown> = { model, messages };
    if (sampling.maxTokens !== undefined) requestBody.max_tokens = sampling.maxTokens;
    if (sampling.temperature !== undefined) requestBody.temperature = sampling.temperature;
    if (sampling.topP !== undefined) requestBody.top_p = sampling.topP;
    if (sampling.stop !== undefined) requestBody.stop = sampling.stop;
    if (sampling.seed !== undefined) requestBody.seed = sampling.seed;
    // #2 L3 — Chat Completions carries reasoning as a top-level `reasoning_effort`
    // (only reasoning models honor it; a non-reasoning model or a gateway that
    // does not support it rejects/ignores it — best-effort, opt-in). `max` clamps
    // to `high` via the shared helper (OpenAI has no `max` rung). No key when unset.
    // Compatible with structured mode (unlike Anthropic's forced-tool/thinking clash).
    if (reasoningEffort !== undefined) {
      requestBody.reasoning_effort = openAiReasoningEffort(reasoningEffort);
    }
    // #2 L4b — JSON mode. `json_object` (not strict `json_schema`) is the robust
    // choice: strict mode requires `additionalProperties:false` + all-required on
    // EVERY nested object, but the L4a subset permits LOOSE nested `object`/`array`
    // (lowered to opaque `json`), which would 400 under strict. `json_object`
    // guarantees valid JSON with no schema-shape constraints; the strict
    // parse/validate of the RESPONSE (`parseAndValidateStructured`) is the
    // correctness guarantee. Widely supported by OpenAI-compatible gateways.
    if (structuredOutput !== undefined) {
      requestBody.response_format = { type: 'json_object' };
    }

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
    // #2 L4b — STRUCTURED path. Meter FIRST (a 2xx billed, even if the structured
    // payload is invalid), then parse+validate `choices[0].message.content` as JSON
    // against the schema. An absent/empty `choices` or a non-string content yields
    // `undefined`, which `parseAndValidateStructured` rejects (→ `permanent`), so
    // the no-completion case is covered without a separate #461 branch here.
    if (structuredOutput !== undefined) {
      const structuredUsage = (
        parsed.json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
      ).usage;
      yield {
        type: 'metered',
        usage: meterUsage(
          'openai_api',
          model,
          structuredUsage?.prompt_tokens,
          structuredUsage?.completion_tokens,
        ),
      };
      const structuredChoices = (parsed.json as { choices?: unknown }).choices;
      const content =
        Array.isArray(structuredChoices) && structuredChoices.length > 0
          ? (structuredChoices[0] as { message?: { content?: unknown } } | undefined)?.message
              ?.content
          : undefined;
      const validated = parseAndValidateStructured(structuredOutput, content);
      if (!validated.ok) {
        yield structuredValidationFailure('openai_api', validated.reason);
        return;
      }
      yield { type: 'succeeded', outputs: validated.value };
      return;
    }
    // #461 — a present string (even '') is a real completion; anything else is
    // NO completion → fail permanent, sub-classified for diagnostics (#556): an
    // absent/non-array `choices` container is `absent_content`; a present-but-
    // empty `choices:[]` is `empty_completion_set`; a candidate present but its
    // `message.content` non-string/absent is `malformed_block`.
    const choices = (parsed.json as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) {
      yield noCompletionFailure('openai_api', 'absent_content');
      return;
    }
    if (choices.length === 0) {
      yield noCompletionFailure('openai_api', 'empty_completion_set');
      return;
    }
    const first = choices[0];
    const text = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof text !== 'string') {
      yield noCompletionFailure('openai_api', 'malformed_block');
      return;
    }
    // #2 L2 — capture the metering fact before the terminal event. Chat
    // Completions reports `usage.{prompt_tokens, completion_tokens}` (a gateway
    // may omit it → `meterUsage` flags `unknown`).
    const usage = (
      parsed.json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
    ).usage;
    yield {
      type: 'metered',
      usage: meterUsage('openai_api', model, usage?.prompt_tokens, usage?.completion_tokens),
    };
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
