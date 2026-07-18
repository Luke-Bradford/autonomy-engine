import { z } from 'zod';

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
 * Later-ticket surface still OFF the schema (kept off so nothing inert/
 * unreachable ships): `outputMode`/`outputSchema` (L4a),
 * `tools`/`toolChoice`/`mcpServers` (L10). `reasoningEffort` landed in L3 (below).
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
  })
  .refine((c) => (c.prompt !== undefined) !== (c.messages !== undefined), {
    message: 'llm_call requires exactly one of `prompt` or `messages`',
  })
  .refine((c) => c.messages === undefined || c.messages.some((m) => m.role !== 'system'), {
    message: 'llm_call `messages` must contain at least one non-system (user/assistant) message',
  });

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
  };
}
