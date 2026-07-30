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
  unsupportedParamRefusal,
  validateStructuredOutput,
} from './llm-shared.js';
import type { NoCompletionReason, ToolCallRequest, ToolRoundOutcome } from './llm-shared.js';
import { unsupportedAnthropicParams } from './anthropic-models.js';

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
/**
 * The Messages API REQUIRES max_tokens; used when the node sets none.
 *
 * #708 — raised from 1024 when `DEFAULT_MODEL` moved to Opus 5, and the two
 * MUST move together. `max_tokens` is a hard cap on TOTAL output — thinking
 * tokens and response text combined — and Opus 5 thinks BY DEFAULT (omitting
 * `thinking` runs adaptive, at the API's default `high` effort, where "Claude
 * almost always thinks"). Opus 4.8 did the opposite: omitting `thinking` meant
 * no thinking, so 1024 was 1024 tokens of answer.
 *
 * Left at 1024, the flip would have failed SILENTLY and destructively: thinking
 * consumes the budget, the response comes back truncated or text-free with
 * `stop_reason: "max_tokens"`, `extractText` sees no text block and returns
 * null, and the node terminalizes `empty_completion_set` as a PERMANENT
 * failure — on a pipeline that worked the day before, with nothing in the
 * error naming the real cause.
 *
 * WHY 4096 AND NOT THE ~16000 USUALLY RECOMMENDED FOR NON-STREAMING: that
 * guidance is calibrated to the Anthropic SDK's own ~10-minute timeout envelope.
 * This connector is non-streaming with a **120s** whole-exchange budget
 * (`DEFAULT_LLM_TIMEOUT_MS`), so the two numbers are COUPLED and 16000 does not
 * fit inside it: 16000 output tokens at any plausible Opus-5 standard-speed rate
 * is 2-6 minutes of generation. Exceeding the budget is far worse than
 * truncating, because `llmPost` aborts and `usageOf` is only ever reached after
 * a 2xx parse — so the provider generates and BILLS tokens this process can never
 * count, and the failure is classified `transient`, which is retry-eligible, so
 * the engine re-issues the whole call and buys another generation.
 *
 * #725 made that spend VISIBLE rather than silent: the timeout failure now carries
 * a `spendFact`, so the executor mints an `activity.metered{unknown}` and L6 reads
 * the run's cost as INCOMPLETE instead of summing a total that quietly omits the
 * call. The bound below is still an upper bound, though — visible unaccounted
 * spend is a diagnosis, not a fix, and each retry adds another one.
 *
 * 4096 is the largest round budget that finishes inside 120s even pessimistically
 * (~40 tok/s → ~102s), while being 4x the old cap so adaptive thinking has room
 * before it starves the answer. It also happens to be the output ceiling of the
 * legacy `claude-3-*` ids, which are API-active until 2026-04 and which an
 * operator may still name explicitly — at 16000 those would have started
 * returning a 400, classified `permanent`, on a pipeline that worked the day
 * before.
 *
 * The residual risk is the ORIGINAL one, merely made much less likely: a
 * thinking-heavy prompt can still truncate. That failure is at least loud and
 * un-retried (`empty_completion_set`, `permanent`) rather than silent and
 * billed. Raising the budget further needs streaming or a token-scaled timeout,
 * not a bigger constant — tracked in #725.
 *
 * #724 — THIS BUDGET NOW BINDS ON ALL THREE PATHS, not just text. Deleting
 * `allowThinking` means a node that sets `reasoningEffort` puts thinking in
 * competition with the STRUCTURED path's forced `tool_use` block and with the
 * `toolChoice:'required'` flow, where it previously could not. The structured
 * case is the sharpest: an exhausted budget yields no complete `tool_use` block,
 * L4c spends a REPAIR call under the identical budget, and only then
 * terminalizes `permanent` — two billed calls for one budget problem. That is
 * why BOTH invalid shapes now carry the response's `stop_reason` (see the
 * structured `doCall`): the diagnosis has to name the budget, because either
 * symptom otherwise looks like a disobedient model. The `required` tools path
 * shares the exposure but degrades better (a bad call becomes an error
 * `tool_result` and the flow downgrades to `auto`).
 *
 * Note this is a CAP, not a spend: tokens are billed as generated, so a short
 * answer still costs a short answer. The real cost increase is the thinking
 * itself, which is the model default now and is not something `max_tokens` can
 * opt out of.
 */
const DEFAULT_MAX_TOKENS = 4096;
/** The default model when neither the node nor the connection specifies one. */
const DEFAULT_MODEL = 'claude-opus-5';

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

    // #727 — PREFLIGHT: refuse locally when the AUTHOR set a parameter the
    // RESOLVED model has removed, before issuing a request the provider would
    // 400. Placed after `resolveModel` + `normalizeLlmRequest` and before the
    // structured / tools / text branch, so all three dispatch paths are covered
    // by one check.
    //
    // This is necessarily a DISPATCH-time check, not an author-time Zod
    // refinement: `resolveModel` takes the model from the node, ELSE the
    // connection's default, ELSE `DEFAULT_MODEL` — and the latter two are
    // invisible to node-config validation. A node that sets only `temperature`
    // and names no model resolves to `claude-opus-5`, which rejects it.
    //
    // `testConnection` needs no equivalent: it is a GET to `/v1/models` with no
    // sampling or reasoning body at all.
    const refusal = unsupportedParamRefusal(
      'anthropic_api',
      model,
      unsupportedAnthropicParams(model, {
        hasTemperature: sampling.temperature !== undefined,
        hasTopP: sampling.topP !== undefined,
        hasReasoningEffort: reasoningEffort !== undefined,
      }),
    );
    if (refusal !== null) {
      yield refusal;
      return;
    }

    // #648 — ONE wire-body builder for all three paths (text / structured L4c /
    // tools L10a); previously the system/temperature/top_p/stop stanza was
    // duplicated per path. The Messages API takes `system` as a top-level param
    // (not a message) and has no `seed` (dropped, documented #2 L1). Tools +
    // tool_choice travel as ONE `toolWire` group so a `tool_choice` without
    // `tools` (a provider 400) is unrepresentable.
    //
    // #724 — there is no longer a per-path reasoning posture. An `allowThinking`
    // flag used to let the two FORCED-`tool_choice` callers suppress the
    // reasoning keys; it is deleted, so the reasoning surface is now a pure
    // function of whether the author set `reasoningEffort`, identically on all
    // three paths.
    const buildBody = (
      msgs: readonly unknown[],
      opts: { toolWire?: { tools: unknown[]; choice: unknown } } = {},
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
      // thinking + `output_config.effort`. The older `thinking:{enabled,budget_tokens}`
      // is REMOVED (HTTP 400) on the DEFAULT_MODEL `claude-opus-5` and on Opus
      // 4.8/4.7 and Sonnet 5 — NOT on literally every model an operator can name
      // here: it is deprecated-but-functional on Opus 4.6/Sonnet 4.6 and is still
      // the ONLY way to get thinking on Sonnet 4.5/Haiku 4.5. This connector
      // never emits it on any model, which is correct for all of them.
      //
      // Both keys are emitted together: `output_config.effort` sets the depth,
      // `thinking:{adaptive}` selects the adaptive surface.
      //
      // #708 — that used to read "omitting it leaves Opus 4.8 non-thinking,
      // making effort inert", which was true of Opus 4.8 and is NOT true of the
      // current default. On Opus 5 an omitted `thinking` runs ADAPTIVE anyway, so
      // emitting `{type:'adaptive'}` is equivalent to the model default rather
      // than the thing that switches reasoning on. It stays emitted because it is
      // still load-bearing on **Opus 4.8/4.7, Opus 4.6 and Sonnet 4.6**, which a
      // node or connection may select by name and which do NOT think when
      // `thinking` is omitted. (Sonnet 5 is NOT in that list — like Opus 5 it
      // runs adaptive on omission, so the emit is a no-op there. Opus 4.6 was
      // absent from this list until #724 — it needs the explicit
      // `{type:'adaptive'}` exactly as 4.8/4.7 do.)
      //
      // CAVEAT: thinking tokens count against `max_tokens` — see the
      // DEFAULT_MAX_TOKENS note, which is now load-bearing rather than advisory.
      // Only fires when the author opted in, so a node with no `reasoningEffort`
      // is byte-identical to a pre-L3 request.
      //
      // #727 — a model with NO adaptive surface (`claude-sonnet-4-5`,
      // `claude-haiku-4-5`) would 400 on both keys. The dispatch preflight
      // refuses that combination before this builder is ever reached, so this
      // emit is unconditional on the author's opt-in alone.
      if (reasoningEffort !== undefined) {
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
    // note in `extractText`).
    //
    // #724 — structured mode now emits `thinking`/`output_config` exactly as text
    // mode does when the author set `reasoningEffort`. It used to SUPPRESS them,
    // on the stated grounds that "a forced `tool_choice` precludes the
    // adaptive-thinking surface". That was FALSE: forcing tool use errors only
    // under MANUAL extended thinking (`thinking:{type:'enabled'}`), while
    // "adaptive thinking supports forced tool use" — and this connector only ever
    // emits `{type:'adaptive'}`, so there was never a 400 to avoid. The
    // suppression was additionally INERT on the Opus 5 default, which thinks on an
    // omitted `thinking` anyway. Net effect of the deletion: `reasoningEffort` is
    // HONOURED here instead of being silently ignored.
    //
    // The premise holds on the FIRST-PARTY Messages API, which is the qualifier
    // that matters: on Amazon Bedrock, Claude Sonnet 5 with a forced `tool_choice`
    // does require `thinking:{type:'disabled'}`. Reachable only via a proxied
    // `baseUrl`, and the capability sets do not cover it (Bedrock ids carry an
    // `anthropic.` prefix), so the preflight is not the remedy — a Bedrock-aware
    // connection kind would be. Noted so the premise reads as scoped rather than
    // universal.
    //
    // #751 turned "do not cover" from an inability into a CHOICE, which is why the
    // wording changed: once ids are normalised before lookup, a prefix rule became
    // possible, was considered, and was REJECTED on the strength of this
    // paragraph. This preflight has no first-party gate, so such a rule would aim
    // its entire effect at the one surface named here as out of scope.
    //
    // Safe against the API's thinking-REPLAY rule (thinking blocks must come back
    // intact alongside a replayed `tool_use`, and a rebuilt message 400s): this
    // path never replays a `tool_use` block at all — `buildRepairTurns` echoes the
    // invalid result as PLAIN TEXT turns — so the rule is not engaged here.
    //
    // L4c wraps the call in a bounded internal repair loop:
    // `runStructuredWithRepair` rebuilds the body from the (possibly repair-extended)
    // turns each call, meters every billed call, re-prompts on an invalid/absent
    // forced-tool result, and terminalizes `permanent` only once repairs run out —
    // all inside ONE attempt.
    if (structuredOutput !== undefined) {
      // Only `messages` changes across repair calls, so the static scaffold is
      // rebuilt with the passed turns.
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
          model,
          url,
          headers,
          buildBody(turns, { toolWire: structuredWire }),
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
        //
        // #724 — the `stop_reason` is CARRIED INTO the reason string on BOTH
        // invalid shapes, and it is the reasoning change that makes it
        // load-bearing. `max_tokens` caps thinking and the `tool_use` block
        // TOGETHER, so a node that sets `reasoningEffort` now has thinking
        // competing for the same budget here. When it exhausts, the block comes
        // back either ABSENT (no `tool_use` at all) or TRUNCATED (a `tool_use`
        // whose `input` is short of the schema) — and the two take different
        // code paths, which is why annotating only the first was not enough:
        //
        //   absent    → `!tool.found` below → "carried no ... tool_use block"
        //   truncated → `validateStructuredOutput` → "category: expected string,
        //               received undefined"
        //
        // The truncated shape is the SHARPER of the two, because its message
        // reads like a schema defect and blames the model outright. Both now
        // carry the stop reason, so `max_tokens` names the real cause in the
        // repair critique and in the durable error. Either shape costs two
        // billed calls (the repair re-issues under the same budget) before
        // terminalizing `permanent`.
        //
        // Annotated unconditionally rather than only on `max_tokens`: an
        // `end_turn` is equally diagnostic (the model finished and simply got the
        // schema wrong), and a value-dependent annotation would make the absence
        // of the note ambiguous between "not truncated" and "not annotated".
        const stopReason = coerceStopReason((res.json as { stop_reason?: unknown }).stop_reason);
        if (!tool.found) {
          return {
            type: 'validated',
            usage,
            result: {
              ok: false,
              reason:
                `response carried no ${STRUCTURED_TOOL_NAME} tool_use block ` +
                `(stop_reason: ${stopReason})`,
            },
            echo: structuredEcho(undefined),
          };
        }
        const validated = validateStructuredOutput(structuredOutput, tool.input);
        return {
          type: 'validated',
          usage,
          result: validated.ok
            ? validated
            : { ok: false, reason: `${validated.reason} (stop_reason: ${stopReason})` },
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
      // #724 — a `required` flow used to suppress `thinking`/`output_config` for
      // the whole attempt, on the same false premise the structured path carried
      // (see the note there). Both flows now keep reasoning exactly as text mode
      // does, so there is no longer a per-choice posture to compute — and no risk
      // of splitting one node's posture across the downgraded continuation,
      // because there is only one rule.
      //
      // The replay rule IS engaged on this path (unlike the structured one), and
      // is already satisfied: the continuation below replays the response's RAW
      // content blocks, so thinking blocks travel back intact as the API
      // requires during tool use. The `auto` flow has emitted thinking every
      // round since L10a shipped, so this extends a proven mechanism rather than
      // introducing one.
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
            model,
            url,
            headers,
            buildBody(conv, {
              toolWire: {
                tools: localTools,
                choice: { type: choice === 'required' ? 'any' : 'auto' },
              },
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
                  spendFact: usage,
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
              event: {
                ...noCompletionFailure('anthropic_api', extracted.reason),
                spendFact: usage,
              },
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
      model,
      url,
      headers,
      buildBody(messages),
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
      yield {
        ...noCompletionFailure('anthropic_api', extracted.reason),
        spendFact: usageOf(result.json),
      };
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
