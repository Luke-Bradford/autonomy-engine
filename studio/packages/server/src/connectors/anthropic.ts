import { z } from 'zod';
import type { ActivityContext, ActivityEvent, ConnectorAdapter } from './types.js';
import {
  DEFAULT_LLM_TIMEOUT_MS,
  buildCapture,
  coerceStopReason,
  llmCallConfigSchema,
  llmConnectionConfigSchema,
  llmProbeGet,
  meterUsage,
  noCompletionFailure,
  normalizeLlmRequest,
  postJsonAndParse,
  resolveModel,
  runStructuredWithRepair,
  runTextWithTools,
  structuredEcho,
  toolWireParameters,
  validateStructuredOutput,
} from './llm-shared.js';
import type { NoCompletionReason, ToolCallRequest, ToolRoundOutcome } from './llm-shared.js';

/** The forced-tool name a structured `llm_call` requires Anthropic to call. */
const STRUCTURED_TOOL_NAME = 'structured_output';

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

/**
 * #2 L4b — locate the forced `structured_output` tool_use block's `input` in a
 * Messages API response. Returns `{ found:false }` when the response carries no
 * such block (a model that answered with text instead of calling the tool, or a
 * malformed `content`); `{ found:true, input }` otherwise (the raw `input` — the
 * shared `validateStructuredOutput` decides whether it is a usable object). The
 * `input` of a `tool_use` block is already a PARSED object (unlike OpenAI/Ollama,
 * which return the JSON as a string in `message.content`), so no text-parse here.
 */
function findStructuredToolInput(
  json: unknown,
): { found: false } | { found: true; input: unknown } {
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return { found: false };
  for (const b of content) {
    if (
      typeof b === 'object' &&
      b !== null &&
      (b as { type?: unknown }).type === 'tool_use' &&
      (b as { name?: unknown }).name === STRUCTURED_TOOL_NAME
    ) {
      return { found: true, input: (b as { input?: unknown }).input };
    }
  }
  return { found: false };
}

/**
 * #2 L10a — extract every `tool_use` block of a Messages API response as a
 * normalized `ToolCallRequest`, in provider order (Anthropic emits parallel
 * tool_use blocks by default — ALL are answered in the one round-trip). A block
 * with a non-string `name`/`id` is still surfaced (`null` fields) so the shared
 * executor can answer it with an error tool_result rather than silently
 * dropping a block the continuation would then 400 on. `input` is already a
 * PARSED object on this provider; `executeLocalTool`'s args validation decides
 * whether it is usable.
 */
function extractToolUses(json: unknown): ToolCallRequest[] {
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const calls: ToolCallRequest[] = [];
  for (const b of content) {
    if (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use') {
      const id = (b as { id?: unknown }).id;
      const name = (b as { name?: unknown }).name;
      calls.push({
        id: typeof id === 'string' ? id : null,
        name: typeof name === 'string' ? name : null,
        args: (b as { input?: unknown }).input,
      });
    }
  }
  return calls;
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
    const { system, messages, sampling, reasoningEffort, structuredOutput } = normalizeLlmRequest(
      input.data,
    );
    const baseUrl = (config.data.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;
    const headers = {
      'x-api-key': secret,
      'anthropic-version': config.data.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
    };
    const timeoutMs = config.data.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

    // #648 — ONE wire-body builder for all three paths (text / structured L4c /
    // tools L10a); previously the system/temperature/top_p/stop stanza was
    // duplicated per path. The Messages API takes `system` as a top-level param
    // (not a message) and has no `seed` (dropped, documented #2 L1). Tools +
    // tool_choice travel as ONE `toolWire` group so a `tool_choice` without
    // `tools` (a provider 400) is unrepresentable. `allowThinking` carries each
    // path's reasoning posture — see the callers for why a forced choice
    // precludes the adaptive-thinking surface.
    const buildBody = (
      msgs: readonly unknown[],
      opts: { toolWire?: { tools: unknown[]; choice: unknown }; allowThinking: boolean },
    ): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        model,
        max_tokens: sampling.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: msgs,
      };
      if (opts.toolWire !== undefined) {
        body.tools = opts.toolWire.tools;
        body.tool_choice = opts.toolWire.choice;
      }
      if (system !== undefined) body.system = system;
      if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
      if (sampling.topP !== undefined) body.top_p = sampling.topP;
      if (sampling.stop !== undefined) body.stop_sequences = sampling.stop;
      // #2 L3 — reasoning effort. The MODERN Messages-API surface is adaptive
      // thinking + `output_config.effort`; the older `thinking:{enabled,budget_tokens}`
      // is REMOVED (HTTP 400) on every current model, including the DEFAULT_MODEL
      // `claude-opus-4-8`. Both keys are emitted together: `output_config.effort` sets
      // the depth, `thinking:{adaptive}` turns reasoning ON (omitting it leaves Opus
      // 4.8 non-thinking, making effort inert). CAVEAT: thinking tokens count against
      // `max_tokens` (default 1024). Only fires when the author opted in, so a node
      // with no `reasoningEffort` is byte-identical to a pre-L3 request.
      if (reasoningEffort !== undefined && opts.allowThinking) {
        body.thinking = { type: 'adaptive' };
        body.output_config = { effort: reasoningEffort };
      }
      return body;
    };

    // #648 — the Messages API reports `usage.{input_tokens, output_tokens}`;
    // `meterUsage` records whatever is a valid non-negative integer and flags
    // completeness. Previously extracted inline per path.
    const usageOf = (json: unknown) => {
      const u = (json as { usage?: { input_tokens?: unknown; output_tokens?: unknown } }).usage;
      return meterUsage('anthropic_api', model, u?.input_tokens, u?.output_tokens);
    };

    // #2 L4b/L4c — STRUCTURED output via FORCED tool use: one tool whose
    // `input_schema` is the node's `outputSchema`, forced with `tool_choice`. This
    // is the robust, model-agnostic Anthropic structured mechanism (the newer
    // `output_config.format` is model-gated), and it makes a `tool_use`-only
    // response the COMPLETION rather than a no-completion (superseding the text-mode
    // note in `extractText`). A forced `tool_choice` precludes the adaptive-thinking
    // reasoning surface on the Messages API, so structured mode intentionally does
    // NOT emit `thinking`/`output_config` even when `reasoningEffort` is set (the
    // two are mutually exclusive here; reasoning stays available in text mode and on
    // the other providers). L4c wraps the call in a bounded internal repair loop:
    // `runStructuredWithRepair` rebuilds the body from the (possibly repair-extended)
    // turns each call, meters every billed call, re-prompts on an invalid/absent
    // forced-tool result, and terminalizes `permanent` only once repairs run out —
    // all inside ONE attempt.
    if (structuredOutput !== undefined) {
      // A forced `tool_choice` precludes the adaptive-thinking reasoning
      // surface, so structured mode never emits `thinking`/`output_config`
      // (`allowThinking:false`); only `messages` changes across repair calls,
      // so the static scaffold is rebuilt with the passed turns.
      const structuredWire = {
        tools: [
          {
            name: STRUCTURED_TOOL_NAME,
            description: 'Emit the required structured result as this tool call.',
            input_schema: structuredOutput,
          },
        ],
        choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
      };
      yield* runStructuredWithRepair('anthropic_api', messages, async (turns) => {
        const res = await postJsonAndParse(
          ctx,
          'anthropic_api',
          url,
          headers,
          buildBody(turns, { toolWire: structuredWire, allowThinking: false }),
          timeoutMs,
        );
        if (!res.ok) return { type: 'terminal', event: res.event };
        // Meter FIRST (a 2xx billed, even if the structured payload is invalid —
        // spec: `activity.metered` on failed-but-billed calls); the loop yields it
        // before deciding succeed / repair / terminal.
        const usage = usageOf(res.json);
        const tool = findStructuredToolInput(res.json);
        // A missing forced-tool block is now REPAIRABLE (fold into an invalid
        // result) rather than an immediate terminal — a model that answered with
        // text instead of the tool may correct on a re-prompt.
        if (!tool.found) {
          return {
            type: 'validated',
            usage,
            result: {
              ok: false,
              reason: `response carried no ${STRUCTURED_TOOL_NAME} tool_use block`,
            },
            echo: structuredEcho(undefined),
          };
        }
        return {
          type: 'validated',
          usage,
          result: validateStructuredOutput(structuredOutput, tool.input),
          echo: structuredEcho(tool.input),
        };
      });
      return;
    }

    // #2 L10a — LOCAL TOOLS path (text mode only; the config coupling forbids
    // tools+structured). `toolChoice:'none'` deliberately falls through to the
    // plain text path with NO tools on the wire — semantically "tools off",
    // with zero wire-surface difference from an undeclared-tools node.
    const tools = input.data.tools;
    const authorChoice = input.data.toolChoice ?? 'auto';
    if (tools !== undefined && authorChoice !== 'none') {
      // A FORCED tool_choice (`required` → `{type:'any'}`) precludes the
      // adaptive-thinking surface, exactly as the structured path's forced
      // `{type:'tool'}` does — so a `required` flow suppresses `thinking`/
      // `output_config` for the WHOLE attempt (one rule per node; enabling it
      // only on the downgraded continuation would split one node's reasoning
      // posture across calls). An `auto` flow keeps reasoning as text mode does.
      const suppressThinking = authorChoice === 'required';
      const localTools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Explicit-required + closed (`toolWireParameters`): the wire says
        // exactly what the local args validator enforces (#594 alignment).
        input_schema: toolWireParameters(t.parameters),
      }));
      // The conversation value `C` is the WIRE messages array: the initial
      // author turns are valid wire messages, and the continuation replays the
      // response's RAW content blocks (preserving any thinking blocks, which
      // Anthropic requires intact during tool use) + the tool_result turn.
      // `'none'` never reaches the per-round `choice` (the guard above falls
      // through to the plain text path) — the ternary maps it to `auto` for
      // type totality.
      yield* runTextWithTools<readonly unknown[]>(
        'anthropic_api',
        tools,
        messages,
        authorChoice,
        async (conv, choice): Promise<ToolRoundOutcome<readonly unknown[]>> => {
          const res = await postJsonAndParse(
            ctx,
            'anthropic_api',
            url,
            headers,
            buildBody(conv, {
              toolWire: {
                tools: localTools,
                choice: { type: choice === 'required' ? 'any' : 'auto' },
              },
              allowThinking: !suppressThinking,
            }),
            timeoutMs,
          );
          // First-exchange capture semantics (#2 L9a): request = the author's
          // turns. The generator emits only the round-0 capture; continuation
          // exchanges carry tool turns `LlmCapture` cannot represent (#605).
          // Emitted for EVERY post-request outcome — a terminal carries the
          // capture alongside its event.
          const captureOf = (completionText?: string) =>
            buildCapture({
              provider: 'anthropic_api',
              model,
              latencyMs: res.latencyMs,
              turns: messages,
              system,
              completionText,
            });
          if (!res.ok) {
            return { type: 'terminal', event: res.event, capture: captureOf() };
          }
          const usage = usageOf(res.json);
          const calls = extractToolUses(res.json);
          if (calls.length > 0) {
            // A `tool_use` block without a string `id` is a malformed provider
            // response: the continuation's `tool_result` REQUIRES `tool_use_id`,
            // so shipping `''` would only trade this clear local diagnostic for
            // an opaque provider 400. Fail loud instead (same class as the
            // malformed-block no-completion failures; a retry of the identical
            // request won't fix a response-shape defect → `permanent`).
            if (calls.some((c) => c.id === null)) {
              return {
                type: 'terminal',
                event: {
                  type: 'failed',
                  kind: 'permanent',
                  error:
                    'anthropic_api returned a tool_use block without a string id — ' +
                    'malformed tool-call response',
                },
                capture: captureOf(),
              };
            }
            const responseContent = (res.json as { content: unknown[] }).content;
            return {
              type: 'toolUse',
              usage,
              capture: captureOf(),
              calls,
              buildNext: (results) => [
                ...conv,
                { role: 'assistant', content: responseContent },
                {
                  role: 'user',
                  content: results.map((r) => ({
                    type: 'tool_result',
                    // Non-null by the malformed-response gate above.
                    tool_use_id: r.id ?? '',
                    content: r.resultText,
                    ...(r.isError ? { is_error: true } : {}),
                  })),
                },
              ],
            };
          }
          const extracted = extractText(res.json);
          if ('reason' in extracted) {
            return {
              type: 'terminal',
              event: noCompletionFailure('anthropic_api', extracted.reason),
              capture: captureOf(),
            };
          }
          return {
            type: 'text',
            usage,
            capture: captureOf(extracted.text),
            succeeded: {
              type: 'succeeded',
              outputs: {
                text: extracted.text,
                stopReason: coerceStopReason((res.json as { stop_reason?: unknown }).stop_reason),
              },
            },
          };
        },
        // #2 L10b — the author's tool round-trip budget (absent → the generator's
        // default of 1, the L10a single round-trip — one SSOT for the rule) +
        // the run signal (between-rounds cancellation).
        input.data.maxToolIterations,
        ctx.signal,
      );
      return;
    }

    // TEXT path — no tools on the wire, reasoning allowed (see `buildBody` for
    // the L3 adaptive-thinking surface).
    const result = await postJsonAndParse(
      ctx,
      'anthropic_api',
      url,
      headers,
      buildBody(messages, { allowThinking: true }),
      timeoutMs,
    );
    // #2 L9a — the prompt/completion CAPTURE fact, emitted before EVERY post-request
    // terminal (success + each failure) so the debugging capture is not success-only.
    // `completionText` is passed ONLY on success — a failure omits `completion`
    // (fail-closed: an absent completion is absent, never a hash of '').
    const captureOf = (completionText?: string): ActivityEvent => ({
      type: 'captured',
      capture: buildCapture({
        provider: 'anthropic_api',
        model,
        latencyMs: result.latencyMs,
        turns: messages,
        system,
        completionText,
      }),
    });
    if (!result.ok) {
      yield captureOf();
      yield result.event;
      return;
    }
    const extracted = extractText(result.json);
    if ('reason' in extracted) {
      yield captureOf();
      yield noCompletionFailure('anthropic_api', extracted.reason);
      return;
    }
    // #2 L2 — capture the metering fact before the terminal event.
    yield { type: 'metered', usage: usageOf(result.json) };
    yield captureOf(extracted.text);
    yield {
      type: 'succeeded',
      outputs: {
        text: extracted.text,
        stopReason: coerceStopReason((result.json as { stop_reason?: unknown }).stop_reason),
      },
    };
  },
};
