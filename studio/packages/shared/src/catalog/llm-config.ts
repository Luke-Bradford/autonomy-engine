import { z } from 'zod';
import { isAddressableOutputName, type Output, type OutputType } from '../schemas/pipeline.js';

/**
 * #2 L1 — the `llm_call` activity config v2 (the rich model) + its provider-
 * agnostic normalization. This is the SINGLE SOURCE OF TRUTH for the config
 * shape, read by TWO independent sites: the catalog entry (`registry.ts`, for
 * the authoring UI's palette metadata) and the three server adapters
 * (`anthropic`/`openai`/`ollama`, for live request validation). Before L1 those
 * two sites duplicated an inline `z.object`; unifying them here is the same
 * shared→server pattern `http_request` uses for `httpSecretHeadersSchema`.
 * L3 lands `reasoningEffort` (below) on this same schema.
 *
 * `${}` in message `content` needs NO code here: `content` is a plain string,
 * and the engine's config-tree substitution (`engine/params.ts::substitute`)
 * already descends into arrays/objects, so a `${params.x}` inside a
 * `messages[].content` is resolved before dispatch and validated at save-time by
 * the same `validateRefs` tree walk.
 */

/** A role-tagged message. `content` carries the inert `${}` pass (resolved upstream). */
export const llmMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

export type LlmMessage = z.infer<typeof llmMessageSchema>;

/**
 * #2 L3 — the cross-provider reasoning-effort vocabulary. This is the SSOT enum
 * the spec's config v2 pins (`low|medium|high|max`); it is deliberately NARROWER
 * than any single provider's native set (Anthropic's `effort` also accepts
 * `xhigh`) so a pipeline author writes ONE portable knob and each adapter lowers
 * it to that provider's wire shape (see `llm-shared.ts`).
 */
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high', 'max']);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * #2 L4a — the output MODE. `text` (the default when absent, for back-compat with
 * every pre-L4a `llm_call`) yields the catalog's `[text, stopReason]` contract;
 * `structured` yields typed fields derived from `outputSchema`.
 */
export const outputModeSchema = z.enum(['text', 'structured']);
export type OutputMode = z.infer<typeof outputModeSchema>;

/**
 * #2 L4a — one restricted property in a structured `outputSchema`. Only the
 * TOP-LEVEL property TYPES are addressable (`${nodes.x.output.<name>}` is a single
 * segment, #6 E7), so only they must map cleanly to an `OutputType`; nested
 * `object`/`array` shape is kept deliberately LOOSE (it lowers to the opaque
 * `json` type) — L4a does not type-check inside a nested field. `.strict()` is
 * what enforces the subset: it rejects `oneOf`/`anyOf`/`allOf`/`$ref`/
 * `patternProperties` and any other JSON-Schema keyword outside this closed set,
 * so "restricted subset" is enforced by construction, not by an allow-list of
 * rejections that could miss one.
 */
const llmOutputPropertySchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean', 'object', 'array']),
    description: z.string().optional(),
    // Present for enum-typed scalars — kept as opaque values; the base `type`
    // still decides the lowered OutputType.
    enum: z.array(z.unknown()).optional(),
    // Nested shape for `array`/`object` — LOOSE by design (lowers to `json`).
    items: z.unknown().optional(),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  })
  .strict();

/**
 * #2 L4a — the restricted `outputSchema` SUBSET a `structured` `llm_call`
 * declares. An OBJECT root with a NON-EMPTY set of named properties, each an
 * addressable identifier (so it can lower into `config.outputs` and be referenced
 * as `${nodes.x.output.<name>}`), an optional `required` list that must name only
 * declared properties, and `additionalProperties` that — if present — must be
 * `false` (addressable fields need a closed object). `.strict()` rejects every
 * other JSON-Schema keyword (oneOf/anyOf/$ref/…), which is what makes this a
 * SUBSET rather than "arbitrary JSON Schema".
 *
 * This is the SINGLE source of the subset rules: the save-time validator
 * (`engine/params.ts::validateLlmCallOutput`) parses through it for readable
 * diagnostics, and the lowering pass (`catalog/lower.ts::lowerLlmStructuredOutputs`)
 * uses `.safeParse(...).success` as its "valid schema" gate — so "what saves" and
 * "what lowers" can never disagree about the subset.
 */
export const llmOutputSchemaSchema = makeRestrictedSchemaSubset('a structured outputSchema');

/**
 * #2 L10a — the restricted-subset FACTORY behind `llmOutputSchemaSchema`,
 * extracted so a tool's `parameters` declaration (`llmToolDefSchema` below)
 * enforces the IDENTICAL subset rules with correctly-worded diagnostics (`noun`
 * appears in the ≥1-property message — a tool-parameters defect must not read
 * "outputSchema"). One factory, so the two surfaces can never drift on what the
 * subset admits.
 */
function makeRestrictedSchemaSubset(noun: string) {
  return z
    .object({
      type: z.literal('object'),
      properties: z.record(z.string(), llmOutputPropertySchema),
      required: z.array(z.string()).optional(),
      // Only an explicit `false` is legal — `true`/an object/omitted-but-open would
      // let a non-addressable field slip past the declared contract. Absent is the
      // common case (closed is the implied default for a declared contract here).
      additionalProperties: z.literal(false).optional(),
      // Benign JSON-Schema metadata accepted at the root (a real exported schema
      // commonly carries these, and the PROPERTY schema already allows `description`
      // — accepting them here keeps root and property symmetric so a hand-written or
      // imported schema is not 400'd for a doc string). They do not affect lowering.
      description: z.string().optional(),
      title: z.string().optional(),
    })
    .strict()
    .superRefine((schema, ctx) => {
      const names = Object.keys(schema.properties);
      if (names.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['properties'],
          message: `${noun} must declare at least one property`,
        });
      }
      for (const name of names) {
        if (!isAddressableOutputName(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['properties', name],
            message:
              `property name '${name}' is not addressable: a ` +
              '${nodes.<id>.output.<name>} reference takes a single identifier segment',
          });
        }
      }
      for (const r of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, r)) {
          ctx.addIssue({
            code: 'custom',
            path: ['required'],
            message: `required names an undeclared property '${r}'`,
          });
        }
      }
    });
}

export type LlmOutputSchema = z.infer<typeof llmOutputSchemaSchema>;

/**
 * #2 L4a — the `outputMode`↔`outputSchema` COUPLING rule, extracted as a reusable
 * `superRefine` body so the DISPATCH schema (`llmCallConfigSchema`) and the
 * save-time SURFACE schema (`llmStructuredOutputSurfaceSchema`) enforce ONE rule
 * from one place (Zod `.pick`/`.merge` drop `.refine`s, so the two would silently
 * diverge without this — the same reason `refuseDuplicateNames` was extracted in
 * `schemas/pipeline.ts`). `structured` REQUIRES a schema; any other mode (incl.
 * absent = text) FORBIDS one — which also gives text-mode's "reject a stray
 * outputSchema" for free.
 */
function refineOutputModeCoupling(
  c: { outputMode?: OutputMode; outputSchema?: unknown },
  ctx: z.RefinementCtx,
): void {
  const structured = c.outputMode === 'structured';
  if (structured && c.outputSchema === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputSchema'],
      message: "outputMode:'structured' requires an outputSchema",
    });
  }
  if (!structured && c.outputSchema !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['outputSchema'],
      message: "outputSchema is only valid with outputMode:'structured'",
    });
  }
}

/**
 * #2 L4a — the exact `{ outputMode, outputSchema }` SLICE of a node's config that
 * the save-time validator and the lowering pass read. NON-STRICT: a real
 * `node.config` carries many other keys (`prompt`/`messages`/`outputs`/…), so this
 * only picks the two L4a fields and applies the coupling rule; everything else
 * passes through untouched.
 */
export const llmStructuredOutputSurfaceSchema = z
  .object({
    outputMode: outputModeSchema.optional(),
    outputSchema: llmOutputSchemaSchema.optional(),
  })
  .superRefine(refineOutputModeCoupling);

export type LlmStructuredOutputSurface = z.infer<typeof llmStructuredOutputSurfaceSchema>;

// ---------------------------------------------------------------------------
// #2 L10a — the LOCAL TOOL contract (`ToolDef`) + the tools config surface.
//
// T11 (foundation-overview, binding): "define `ToolDef`; MVP tools are
// read-only/pure". A v1 tool is pure BY CONSTRUCTION: its `expression` is a
// whole-value `${...}` in the inert expression language (side-effect-free
// closed function catalog), evaluated against an env that binds ONLY
// `${tool.args.*}` — the model-supplied, schema-validated call arguments. No
// run state, no I/O, no secrets can reach it. Side-effecting tools are the
// deferred event-modeled resumable-loop sub-spec, not this surface.
//
// The `tools` subtree is DEFERRED-EVAL: `${tool.args.x}` has no value until the
// model calls the tool inside the adapter, so the reducer's dispatch-prep
// substitution SKIPS the subtree (`reduce.ts::prepInput`) and save-time ref
// validation scans each `expression` with the `tool` root context-scoped
// (`params.ts::scanLlmToolRefs`). Everything else in a ToolDef is
// authoring-STATIC — which is why `${` anywhere in tool metadata is refused
// outright (it would ship to the provider as a silent inert literal).
// ---------------------------------------------------------------------------

/**
 * #2 L10a — the author's tool-choice knob, provider-mapped by the adapters:
 * `auto` (default — the model decides), `required` (the first call forces a
 * tool call; the internal continuation call always downgrades to `auto`, else
 * the forced choice could never yield a final text), `none` (tools are not sent
 * at all — the plain text path, byte-identical to an undeclared-tools node).
 * Ollama has no forced-choice wire surface, so `required` is best-effort there
 * (tools are sent; the model decides) — the same posture as the L3 reasoning
 * knob.
 */
export const llmToolChoiceSchema = z.enum(['auto', 'required', 'none']);
export type LlmToolChoice = z.infer<typeof llmToolChoiceSchema>;

/**
 * #2 L10a — one local tool definition. `parameters` reuses the SAME restricted
 * schema subset as structured output (via `makeRestrictedSchemaSubset`), so the
 * model-facing argument contract and the local argument VALIDATOR
 * (`validateStructuredOutput`, reused for args) can never disagree about shape.
 * v1 requires ≥1 parameter: with an args-only env, a zero-arg expression can
 * only compute a constant the author could have inlined in the prompt.
 *
 * `.strict()` — a ToolDef is a closed contract; an unknown key is a typo or a
 * feature (`mcpServers`-era config) this build does not implement, and passing
 * it through would silently drop authored intent.
 */
export const llmToolDefSchema = z
  .object({
    /** Addressable identifier — the name the model calls the tool by. */
    name: z.string().refine(isAddressableOutputName, {
      message:
        'tool name must be a plain identifier (letters, digits, _; not starting with a digit)',
    }),
    description: z
      .string()
      .min(1)
      .refine((d) => !d.includes('${'), {
        message: 'templates are not supported in tool metadata',
      }),
    parameters: makeRestrictedSchemaSubset('a tool parameters schema'),
    /**
     * The whole-value `${...}` the driver evaluates when the model calls this
     * tool, over `${tool.args.*}` only. Whole-value + ref scoping are enforced
     * at save by `scanLlmToolRefs` (params.ts) and re-checked at run by
     * `evalToolExpression` — the schema here only pins non-empty.
     */
    expression: z.string().min(1),
  })
  .strict();

export type LlmToolDef = z.infer<typeof llmToolDefSchema>;

/** #2 L10a — the tools array: non-empty, unique names (the model calls by name). */
export const llmToolsArraySchema = z
  .array(llmToolDefSchema)
  .min(1)
  .superRefine((tools, ctx) => {
    const seen = new Set<string>();
    for (const [i, t] of tools.entries()) {
      if (seen.has(t.name)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `duplicate tool name '${t.name}' (tool names must be unique on a node)`,
        });
      }
      seen.add(t.name);
    }
  });

/**
 * #2 L10a — the `tools`/`toolChoice` COUPLING rule, extracted (the
 * `refineOutputModeCoupling` pattern) so the DISPATCH schema and the save-time
 * SURFACE slice enforce ONE rule: `toolChoice` is meaningless without `tools`,
 * and `tools` + `outputMode:'structured'` is refused in v1 — Anthropic's
 * structured mode already rides a FORCED tool (`structured_output`), and
 * arbitrating between the author's tools and the structured scaffold is a
 * deliberate deferral, not an oversight.
 */
function refineLlmToolsCoupling(
  c: { tools?: unknown; toolChoice?: unknown; outputMode?: OutputMode },
  ctx: z.RefinementCtx,
): void {
  if (c.toolChoice !== undefined && c.tools === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['toolChoice'],
      message: 'toolChoice is only valid when tools are declared',
    });
  }
  if (c.tools !== undefined && c.outputMode === 'structured') {
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message:
        "tools are not supported with outputMode:'structured' " +
        '(structured output rides a forced provider tool; the combination is deferred)',
    });
  }
}

/**
 * #2 L10a — the exact `{ tools, toolChoice, outputMode }` SLICE of a node's
 * config the save-time validator reads (`params.ts::validateLlmCallTools`),
 * mirroring `llmStructuredOutputSurfaceSchema`. NON-STRICT: only the tool
 * fields are picked; everything else passes through untouched.
 */
export const llmToolsSurfaceSchema = z
  .object({
    tools: llmToolsArraySchema.optional(),
    toolChoice: llmToolChoiceSchema.optional(),
    outputMode: outputModeSchema.optional(),
  })
  .superRefine(refineLlmToolsCoupling);

/**
 * #2 L10a — lower a tool's `parameters` to the PROVIDER-facing wire schema
 * (Anthropic `input_schema`, OpenAI/Ollama `function.parameters`).
 *
 * The local args validator (`validateStructuredOutput`) applies the #594 rule:
 * an ABSENT `required` list = ALL required. But the MODEL reads standard JSON
 * Schema, where absent `required` = all optional — so a well-behaved model
 * would legitimately omit args the validator then fails, burning the single
 * L10a round-trip on a self-inflicted error. The wire shape must SAY what the
 * validator enforces: an absent `required` is lowered to the explicit all-names
 * list, and `additionalProperties: false` is always stamped (the subset admits
 * only the explicit-`false` form anyway).
 */
export function toolWireParameters(parameters: LlmOutputSchema): Record<string, unknown> {
  return {
    ...parameters,
    required: parameters.required ?? Object.keys(parameters.properties),
    additionalProperties: false,
  };
}

/**
 * #2 L4a — lower a validated structured `outputSchema` to the `config.outputs`
 * `Output[]` contract the rest of the engine already understands
 * (`engine/outputs.ts`, `validateRefs`). Each TOP-LEVEL property becomes one
 * declared output, insertion order preserved (`Object.entries` is insertion-order
 * for string keys). Type lowering collapses the JSON-Schema types onto the four
 * `OutputType`s: `string`→`string`, `number`/`integer`→`number`,
 * `boolean`→`boolean`, `object`/`array`→the opaque `json` (their inner shape is
 * not addressable, #6 E7).
 *
 * #594 — a property NOT named in an EXPLICIT `required` list lowers with
 * `optional:true` (the optionality channel now lives ON the lowered row, via
 * `Output.optional`). An ABSENT `required` list keeps every property required
 * (the L4b all-present floor) — NOT strict-JSON-Schema "absent required = all
 * optional", which would silently null-fill and change existing saved-schema
 * semantics toward data loss. Optionality is therefore opt-in via an explicit
 * partial `required` list. This is immutable-fold-safe: pre-#594 lowered rows
 * carry no `optional` → all-required → identical fold; a new version's optional
 * row only produces NEW events.
 *
 * At RUNTIME an optional field the model omits becomes a present `null`
 * (`llm-structured.ts::validateStructuredOutput` normalizes it; the reducer's
 * `validateOutputs`/`storeOutputs` accept the present-null). A required field
 * omitted still fails `missing declared output`.
 */
export function lowerOutputSchema(schema: LlmOutputSchema): Output[] {
  return Object.entries(schema.properties).map(([name, prop]) => {
    const out: Output = { name, type: lowerOutputPropertyType(prop.type) };
    if (isOptionalProperty(schema, name)) out.optional = true;
    return out;
  });
}

/**
 * #594 — the SSOT for "is this structured-output property OPTIONAL?". A property
 * is optional ONLY when the schema carries an EXPLICIT `required` list that OMITS
 * it; an ABSENT `required` list = ALL required (the L4b all-present back-compat
 * floor, NOT strict-JSON-Schema "absent required = all optional", which would
 * silently null-fill existing saved schemas toward data loss). Exported so BOTH
 * the save-time lowering (`lowerOutputSchema`, what freezes into the immutable
 * version) AND the dispatch-time validator (`llm-structured.ts::
 * validateStructuredOutput`, what turns a response into `succeeded.outputs`) read
 * ONE rule — they can never disagree about which fields are optional (the very
 * lower-vs-validate drift class #594 is about).
 */
export function isOptionalProperty(schema: LlmOutputSchema, name: string): boolean {
  return schema.required !== undefined && !schema.required.includes(name);
}

function lowerOutputPropertyType(type: LlmOutputSchema['properties'][string]['type']): OutputType {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
      return 'json';
  }
}

/**
 * The canonical `llm_call` config.
 *
 * NON-STRICT BY DESIGN (#2 L1, planning-gate HIGH constraint): the value parsed
 * at dispatch is the whole substituted `node.config`, which carries the seeded
 * `outputs` contract key (and, later, L4a `outputMode` / L10 `tools`). A
 * `.strict()` object would reject every real dispatch on that extra key — so
 * unknown keys pass through, exactly as the pre-L1 schema did.
 *
 * Back-compat: the v1 `{ prompt, system?, model?, maxTokens?, temperature? }`
 * config still validates (the `prompt` shorthand path) and normalizes to a
 * single user message — a stored (immutable) v1 `PipelineVersion` replays
 * unchanged. Exactly one of `prompt` / `messages` is required; the illustrative
 * spec type shows `messages` non-optional, but the spec PROSE ("a single
 * `prompt` shorthand", "`system` shorthand allowed") and the back-compat mandate
 * make the shorthand load-bearing.
 *
 * `outputMode`/`outputSchema` landed in L4a (below): a `structured` node's
 * `outputSchema` LOWERS into `config.outputs` at save time (`catalog/lower.ts`),
 * so the fields drive real behaviour the moment they ship. `tools`/`toolChoice`
 * landed in L10a (below) — the local pure-tool contract with a single tool
 * round-trip. Still OFF the schema (kept off so nothing inert/unreachable
 * ships): `mcpServers` (L10c) and `maxToolIterations` (L10b's bounded loop).
 * `reasoningEffort` landed in L3 (below).
 */
export const llmCallConfigSchema = z
  .object({
    /** v1 shorthand: a single user message. Mutually exclusive with `messages`. */
    prompt: z.string().min(1).optional(),
    /** System instruction; folds together with any `role:'system'` messages. */
    system: z.string().optional(),
    /** v2 role-tagged conversation. Mutually exclusive with `prompt`. */
    messages: z.array(llmMessageSchema).min(1).optional(),
    /** Overrides the connection's default model for this node. */
    model: z.string().optional(),
    maxTokens: z.number().int().positive().optional(),
    // Only the UNIVERSAL lower bound (0) is enforced here; the upper bound is
    // provider-specific (Anthropic 0–1, OpenAI/Ollama 0–2) so the adapters own
    // it. Catches a negative temperature at save-time, not at the provider call.
    temperature: z.number().min(0).optional(),
    // L1 sampling — mapped per-provider by the adapters (names differ).
    // `topP` is nucleus sampling: a probability, universally [0, 1].
    topP: z.number().min(0).max(1).optional(),
    // Elements are `.min(1)`: an empty stop STRING is invalid at every provider,
    // so catch it at save-time. The ARRAY is intentionally left able to be empty
    // — `stop: []` is benign (no stop sequences, equivalent to omitting the
    // field), so rejecting it would be a false positive on an author who clears
    // every stop entry.
    stop: z.array(z.string().min(1)).optional(),
    seed: z.number().int().optional(),
    // L3 reasoning knob — the portable effort level; each adapter lowers it to
    // that provider's reasoning surface (Anthropic adaptive-thinking+effort,
    // OpenAI `reasoning_effort`, Ollama `think`). `xhigh` is intentionally not
    // offered (see `reasoningEffortSchema`); an unknown level fails at save-time.
    reasoningEffort: reasoningEffortSchema.optional(),
    // L4a output surface — `outputMode` (absent = text, back-compat) selects the
    // node's output contract; a `structured` node's `outputSchema` (the restricted
    // subset) lowers into `config.outputs` at save. The coupling between the two is
    // the shared `refineOutputModeCoupling` rule (below), applied here so a
    // structured-without-schema config fails at DISPATCH the same way it fails at
    // save.
    outputMode: outputModeSchema.optional(),
    outputSchema: llmOutputSchemaSchema.optional(),
    // L10a tool surface — the local pure-tool contract. `tools` declares the
    // callable tools (deferred-eval `${tool.args.*}` expressions — see the
    // ToolDef block above); `toolChoice` maps per provider. The coupling with
    // `outputMode` is the shared `refineLlmToolsCoupling` rule (below), applied
    // here so a tools+structured config fails at DISPATCH the same way it fails
    // at save.
    tools: llmToolsArraySchema.optional(),
    toolChoice: llmToolChoiceSchema.optional(),
  })
  .refine((c) => (c.prompt !== undefined) !== (c.messages !== undefined), {
    message: 'llm_call requires exactly one of `prompt` or `messages`',
  })
  .refine((c) => c.messages === undefined || c.messages.some((m) => m.role !== 'system'), {
    message: 'llm_call `messages` must contain at least one non-system (user/assistant) message',
  })
  .superRefine(refineOutputModeCoupling)
  .superRefine(refineLlmToolsCoupling);

export type LlmCallConfig = z.infer<typeof llmCallConfigSchema>;

/** Sampling knobs, provider-agnostic. `undefined` = the adapter adds no key. */
export interface LlmSampling {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  seed?: number;
}

/**
 * The provider-agnostic prepared request: a single `system` string + the
 * ordered non-system turns + sampling. Each adapter maps this to its wire shape
 * (Anthropic: `system` is a top-level param; OpenAI/Ollama: a leading
 * `role:'system'` message).
 */
export interface NormalizedLlmRequest {
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  sampling: LlmSampling;
  // L3 — a TOP-LEVEL sibling of `sampling`, not a sampling knob: it lowers to a
  // DIFFERENT request location per provider (Anthropic `thinking`+`output_config`,
  // OpenAI/Ollama a top-level field), whereas every `sampling` knob is one wire
  // parameter. `undefined` = the author set no reasoning effort; the adapter
  // then adds no reasoning surface (byte-identical to a pre-L3 request).
  reasoningEffort?: ReasoningEffort;
  // L4b — the restricted `outputSchema` of a `structured` node, threaded here as
  // the SSOT so all three adapters read it uniformly (the same pattern as L3's
  // `reasoningEffort`). Present iff `outputMode:'structured'` (the coupling rule
  // guarantees a schema when it is). Each adapter maps it to its provider's native
  // JSON/tool mode; the runtime strict validate/parse of the RESPONSE lives in
  // `llm-structured.ts`. `undefined` = a text-mode node (byte-identical to pre-L4b).
  structuredOutput?: LlmOutputSchema;
}

/**
 * Lower a validated `LlmCallConfig` to a provider-agnostic request.
 *
 * - `prompt` (v1) → one `user` message.
 * - System folds into ONE string: the top-level `system` shorthand plus every
 *   `role:'system'` message content, joined by a blank line. This is the
 *   cross-provider-uniform choice — Anthropic's `system` is a top-level param
 *   that cannot represent a mid-stream system turn — so positional semantics of
 *   an interleaved system message are intentionally not preserved. Non-system
 *   turns keep their order.
 * - An empty-string system is inert and dropped (a v1 `{prompt, system:''}`
 *   previously sent `system:''`; dropping an empty instruction is behaviour-
 *   equivalent). Non-empty system is always preserved.
 * - Sampling passes through untouched, `undefined` for any absent knob so an
 *   adapter adds no key for it — byte-identical to a pre-L1 request.
 *
 * `model` is deliberately NOT returned: an adapter resolves it via
 * `resolveModel(cfg, connectionConfig, fallback)` on the raw config, because the
 * connection default and per-provider fallback live outside this activity config.
 */
export function normalizeLlmRequest(cfg: LlmCallConfig): NormalizedLlmRequest {
  // The "exactly one of prompt/messages" invariant lives only in the runtime
  // `.refine`, not the TS type — so a caller that skips `safeParse` could reach
  // here with neither. Guard at the boundary rather than assert `cfg.prompt!`
  // and emit `content: undefined` typed as `string` (a lie to the type system).
  const messages: LlmMessage[] =
    cfg.messages ?? (cfg.prompt !== undefined ? [{ role: 'user', content: cfg.prompt }] : []);
  if (messages.length === 0) {
    throw new Error('normalizeLlmRequest requires a validated config with `prompt` or `messages`');
  }
  const systemParts: string[] = [];
  if (cfg.system !== undefined && cfg.system.length > 0) systemParts.push(cfg.system);
  for (const m of messages) {
    // `content` is `z.string().min(1)`, so any system turn is non-empty.
    if (m.role === 'system') systemParts.push(m.content);
  }
  const nonSystem = messages.filter(
    (m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system',
  );
  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: nonSystem,
    sampling: {
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      topP: cfg.topP,
      stop: cfg.stop,
      seed: cfg.seed,
    },
    reasoningEffort: cfg.reasoningEffort,
    // L4b — carry the schema only for a structured node. The `refineOutputModeCoupling`
    // rule makes `outputSchema` present whenever `outputMode` is `structured`, so
    // the ternary never yields `structured`-without-schema.
    structuredOutput: cfg.outputMode === 'structured' ? cfg.outputSchema : undefined,
  };
}
