import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  buildCapture,
  coerceStopReason,
  httpStatusFailure,
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
  runStructuredWithRepair,
  runTextWithTools,
  structuredEcho,
  structuredOutputInstruction,
  toolWireParameters,
} from './llm-shared.js';
import type { LlmToolChoice, LlmTurn, ToolCallRequest, ToolRoundOutcome } from './llm-shared.js';

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

/**
 * #2 L10a — extract a Chat Completions response message's `tool_calls` as
 * normalized `ToolCallRequest`s, in provider order (ALL are answered in the one
 * round-trip). `function.arguments` arrives as a JSON STRING — parsed here; an
 * unparseable string is passed through RAW so the shared args validator rejects
 * it with a readable reason (→ an error tool_result the model can recover
 * from), never a silent drop. Non-string `id`/`name` surface as `null`.
 */
function extractToolCalls(message: unknown): ToolCallRequest[] {
  const tcs = (message as { tool_calls?: unknown } | undefined)?.tool_calls;
  if (!Array.isArray(tcs)) return [];
  return tcs.map((tc) => {
    const id = (tc as { id?: unknown }).id;
    const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
    let args: unknown = fn?.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // keep the raw string — `executeLocalTool`'s validation names the defect
      }
    }
    return {
      id: typeof id === 'string' ? id : null,
      name: typeof fn?.name === 'string' ? fn.name : null,
      args,
    };
  });
}

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
    const baseUrl = (config.data.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const headers = { Authorization: `Bearer ${secret}` };
    const timeoutMs = config.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

    // Chat Completions carries the system instruction as a LEADING `role:system`
    // message (not a top-level param). #2 L4b — a structured node appends the schema
    // directive to the system content: `response_format:json_object` REQUIRES the
    // literal token "JSON" in the prompt, which `structuredOutputInstruction`
    // guarantees, and the schema steers the model.
    const systemParts: string[] = [];
    if (system !== undefined) systemParts.push(system);
    if (structuredOutput !== undefined)
      systemParts.push(structuredOutputInstruction(structuredOutput));
    const systemContent = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

    // Assemble the wire body for a set of (non-system) turns. Only `messages`
    // changes across L4c repair calls, so the static scaffold is rebuilt from the
    // passed turns each call. Sampling + reasoning apply in BOTH modes;
    // `response_format` only in structured mode (so text mode is byte-identical to
    // pre-L4c).
    const buildBody = (msgTurns: LlmTurn[]): Record<string, unknown> => {
      const messages: { role: string; content: string }[] = [];
      if (systemContent !== undefined) messages.push({ role: 'system', content: systemContent });
      messages.push(...msgTurns);
      const body: Record<string, unknown> = { model, messages };
      if (sampling.maxTokens !== undefined) body.max_tokens = sampling.maxTokens;
      if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
      if (sampling.topP !== undefined) body.top_p = sampling.topP;
      if (sampling.stop !== undefined) body.stop = sampling.stop;
      if (sampling.seed !== undefined) body.seed = sampling.seed;
      // #2 L3 — top-level `reasoning_effort` (reasoning models only; others
      // ignore/reject — best-effort, opt-in). `max`→`high` (OpenAI has no `max`
      // rung). Compatible with structured mode (no Anthropic-style clash).
      if (reasoningEffort !== undefined)
        body.reasoning_effort = openAiReasoningEffort(reasoningEffort);
      // #2 L4b — `json_object` (not strict `json_schema`): the L4a subset permits
      // LOOSE nested `object`/`array` which would 400 under strict; `json_object`
      // guarantees valid JSON with no shape constraints, and the strict parse/
      // validate of the RESPONSE (`parseAndValidateStructured`) is the correctness
      // guarantee. Widely supported by OpenAI-compatible gateways.
      if (structuredOutput !== undefined) body.response_format = { type: 'json_object' };
      return body;
    };

    // #2 L4c — STRUCTURED path with bounded internal repair. Each call meters (a
    // 2xx billed even if invalid), parses+validates `choices[0].message.content`;
    // an absent/empty `choices` or non-string content yields `undefined`, which
    // `parseAndValidateStructured` rejects → the loop re-prompts before
    // terminalizing `permanent`. The no-completion case is covered here without a
    // separate #461 branch.
    if (structuredOutput !== undefined) {
      yield* runStructuredWithRepair('openai_api', turns, async (msgTurns) => {
        const res = await llmPost(ctx, url, headers, buildBody(msgTurns), timeoutMs);
        if (res.type === 'failed') return { type: 'terminal', event: res.event };
        if (res.status < 200 || res.status >= 300) {
          return {
            type: 'terminal',
            event: httpStatusFailure(
              'openai_api',
              res.status,
              res.bodyText,
              res.retryAfterHeader,
              Date.now(),
            ),
          };
        }
        const body = parseJsonBody(res.bodyText);
        if (!body.ok) return { type: 'terminal', event: body.event };
        const u = (
          body.json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
        ).usage;
        const usage = meterUsage('openai_api', model, u?.prompt_tokens, u?.completion_tokens);
        const choices = (body.json as { choices?: unknown }).choices;
        const content =
          Array.isArray(choices) && choices.length > 0
            ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content
            : undefined;
        return {
          type: 'validated',
          usage,
          result: parseAndValidateStructured(structuredOutput, content),
          echo: structuredEcho(content),
        };
      });
      return;
    }

    // #2 L10a — LOCAL TOOLS path (text mode only; the config coupling forbids
    // tools+structured). `toolChoice:'none'` falls through to the plain text
    // path with NO tools on the wire. Unlike Anthropic there is no
    // reasoning-vs-forced-choice clash: `reasoning_effort` is a sibling knob,
    // kept in both calls.
    const tools = input.data.tools;
    const authorChoice = input.data.toolChoice ?? 'auto';
    if (tools !== undefined && authorChoice !== 'none') {
      const wireTools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          // Explicit-required + closed (`toolWireParameters`): the wire says
          // exactly what the local args validator enforces (#594 alignment).
          parameters: toolWireParameters(t.parameters),
        },
      }));
      const buildToolBody = (
        msgs: readonly unknown[],
        // `'none'` never reaches here (the guard above falls through to the
        // plain text path); typed total so the generator's choice threads as-is.
        choice: LlmToolChoice,
      ): Record<string, unknown> => {
        const body: Record<string, unknown> = { model, messages: msgs };
        if (sampling.maxTokens !== undefined) body.max_tokens = sampling.maxTokens;
        if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
        if (sampling.topP !== undefined) body.top_p = sampling.topP;
        if (sampling.stop !== undefined) body.stop = sampling.stop;
        if (sampling.seed !== undefined) body.seed = sampling.seed;
        if (reasoningEffort !== undefined)
          body.reasoning_effort = openAiReasoningEffort(reasoningEffort);
        body.tools = wireTools;
        body.tool_choice = choice;
        return body;
      };
      // The conversation value `C` is the WIRE messages array (leading system
      // included); the continuation appends the response's RAW assistant
      // message (with its `tool_calls`) + one `role:'tool'` result per call id
      // — the shape Chat Completions requires.
      const initial: readonly unknown[] =
        systemContent !== undefined
          ? [{ role: 'system', content: systemContent }, ...turns]
          : [...turns];
      yield* runTextWithTools<readonly unknown[]>(
        'openai_api',
        tools,
        initial,
        authorChoice,
        async (conv, choice): Promise<ToolRoundOutcome<readonly unknown[]>> => {
          const started = Date.now();
          const res = await llmPost(ctx, url, headers, buildToolBody(conv, choice), timeoutMs);
          const latencyMs = Date.now() - started;
          // First-exchange capture semantics (#2 L9a): request = the author's
          // turns; the generator emits only the round-0 capture (#605 owns
          // continuation-turn representation).
          const captureOf = (completionText?: string) =>
            buildCapture({
              provider: 'openai_api',
              model,
              latencyMs,
              turns,
              system,
              completionText,
            });
          if (res.type === 'failed') {
            return { type: 'terminal', event: res.event, capture: captureOf() };
          }
          if (res.status < 200 || res.status >= 300) {
            return {
              type: 'terminal',
              event: httpStatusFailure(
                'openai_api',
                res.status,
                res.bodyText,
                res.retryAfterHeader,
                Date.now(),
              ),
              capture: captureOf(),
            };
          }
          const parsed = parseJsonBody(res.bodyText);
          if (!parsed.ok) {
            return { type: 'terminal', event: parsed.event, capture: captureOf() };
          }
          const u = (
            parsed.json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
          ).usage;
          const usage = meterUsage('openai_api', model, u?.prompt_tokens, u?.completion_tokens);
          const choices = (parsed.json as { choices?: unknown }).choices;
          const first =
            Array.isArray(choices) && choices.length > 0
              ? (choices[0] as { message?: unknown; finish_reason?: unknown })
              : undefined;
          // Tool calls FIRST: a tool-calls-only response carries `content:null`,
          // which the text branch below would misread as `malformed_block`.
          const calls = extractToolCalls(first?.message);
          if (calls.length > 0) {
            // A tool call without a string `id` is a malformed provider
            // response: the continuation's `role:'tool'` message REQUIRES
            // `tool_call_id`, so shipping `''` would only trade this clear
            // local diagnostic for an opaque provider 400. Fail loud instead
            // (`permanent` — a response-shape defect a retry won't fix).
            if (calls.some((c) => c.id === null)) {
              return {
                type: 'terminal',
                event: {
                  type: 'failed',
                  kind: 'permanent',
                  error:
                    'openai_api returned a tool call without a string id — ' +
                    'malformed tool-call response',
                },
                capture: captureOf(),
              };
            }
            const rawMessage = first!.message;
            return {
              type: 'toolUse',
              usage,
              capture: captureOf(),
              calls,
              buildNext: (results) => [
                ...conv,
                rawMessage,
                ...results.map((r) => ({
                  role: 'tool',
                  // Non-null by the malformed-response gate above.
                  tool_call_id: r.id ?? '',
                  content: r.resultText,
                })),
              ],
            };
          }
          if (!Array.isArray(choices)) {
            return {
              type: 'terminal',
              event: noCompletionFailure('openai_api', 'absent_content'),
              capture: captureOf(),
            };
          }
          if (choices.length === 0) {
            return {
              type: 'terminal',
              event: noCompletionFailure('openai_api', 'empty_completion_set'),
              capture: captureOf(),
            };
          }
          const text = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
          if (typeof text !== 'string') {
            return {
              type: 'terminal',
              event: noCompletionFailure('openai_api', 'malformed_block'),
              capture: captureOf(),
            };
          }
          return {
            type: 'text',
            usage,
            capture: captureOf(text),
            succeeded: {
              type: 'succeeded',
              outputs: { text, stopReason: coerceStopReason(first?.finish_reason) },
            },
          };
        },
      );
      return;
    }

    // TEXT path.
    const started = Date.now();
    const result = await llmPost(ctx, url, headers, buildBody(turns), timeoutMs);
    const latencyMs = Date.now() - started;
    // #2 L9a — the prompt/completion CAPTURE fact, emitted before EVERY post-request
    // terminal. `system` is the LOGICAL system instruction (not `systemContent`,
    // which folds in the structured-mode scaffold — text mode has none anyway).
    const captureOf = (completionText?: string): ActivityEvent => ({
      type: 'captured',
      capture: buildCapture({
        provider: 'openai_api',
        model,
        latencyMs,
        turns,
        system,
        completionText,
      }),
    });
    if (result.type === 'failed') {
      yield captureOf();
      yield result.event;
      return;
    }
    if (result.status < 200 || result.status >= 300) {
      yield captureOf();
      yield httpStatusFailure(
        'openai_api',
        result.status,
        result.bodyText,
        result.retryAfterHeader,
        Date.now(),
      );
      return;
    }
    const parsed = parseJsonBody(result.bodyText);
    if (!parsed.ok) {
      yield captureOf();
      yield parsed.event;
      return;
    }
    // #461 — a present string (even '') is a real completion; anything else is
    // NO completion → fail permanent, sub-classified for diagnostics (#556): an
    // absent/non-array `choices` container is `absent_content`; a present-but-
    // empty `choices:[]` is `empty_completion_set`; a candidate present but its
    // `message.content` non-string/absent is `malformed_block`.
    const choices = (parsed.json as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) {
      yield captureOf();
      yield noCompletionFailure('openai_api', 'absent_content');
      return;
    }
    if (choices.length === 0) {
      yield captureOf();
      yield noCompletionFailure('openai_api', 'empty_completion_set');
      return;
    }
    const first = choices[0];
    const text = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
    if (typeof text !== 'string') {
      yield captureOf();
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
    yield captureOf(text);
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
