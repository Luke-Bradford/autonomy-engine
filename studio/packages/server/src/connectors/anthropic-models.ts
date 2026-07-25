/**
 * #727 / #724 — per-model REQUEST-SURFACE facts for `anthropic_api`.
 *
 * The Messages API has REMOVED knobs on its newer models: sending one answers
 * HTTP 400, which `classifyHttpStatus` maps to `permanent`. The connector only
 * emits those knobs when the AUTHOR opted in, which is why no test caught it —
 * the default path never sets them, and `fetch` is mocked so no real 400 is
 * ever observed.
 *
 * FAIL DIRECTION — the deliberate INVERSE of `price-table.ts`. That table is
 * fail-CLOSED: an absent price resolves to `null` and stamps no `costEstimate`,
 * because manufacturing a `0` would silently understate spend. Here the absent
 * fact is a CAPABILITY, and the same instinct would invert into harm: refusing
 * a request because we have no row for its model would manufacture a failure
 * out of ignorance and break a call that works today. So each set below lists
 * ONLY the models KNOWN to reject, and absence means "not known to reject" →
 * permitted, exactly as before this module existed. Both tables obey one rule —
 * never manufacture an absent fact — and it points opposite ways because the
 * facts mean opposite things.
 *
 * Matching is EXACT-STRING, like `BUILTIN_PRICES`. A dated or variant id
 * (`claude-opus-5-20260101`, `claude-opus-4-8[1m]`) and any model served by a
 * proxy / self-hosted `baseUrl` therefore falls through to permitted, and the
 * provider stays the authority — the pre-existing behaviour, merely no longer
 * the only behaviour.
 *
 * WHY SERVER-SIDE and not `packages/shared` alongside the price table: the only
 * consumer is the dispatch path, and the sets are `anthropic_api`-specific
 * request-surface trivia rather than a durable fact stamped onto a run (a price
 * is recorded INTO an immutable event; a capability is consulted and
 * discarded). Keeping it here also keeps it out of the web bundle. The
 * tradeoff, stated so the next author can re-decide rather than rediscover: an
 * author-time UI hint ("this model rejects `temperature`") is the obvious
 * future consumer, and building that means moving this to `shared` — a move,
 * not a rewrite, since the sets are plain data.
 *
 * SOURCE: the `claude-api` skill's model + thinking/effort tables (cached
 * 2026-06-24), re-derived 2026-07-25. Re-derived rather than transcribed from
 * ticket #727, whose own list omitted `claude-sonnet-5` and the Fable/Mythos
 * ids.
 */

/**
 * Models where `temperature` / `top_p` / `top_k` are REMOVED — sending one
 * returns 400. (`top_k` and `seed` are never emitted by this connector; the
 * fact is stated for completeness.)
 *
 * Sources differ on whether the 400 fires on ANY value or only a NON-DEFAULT
 * one. `unsupportedAnthropicParams` gates on PRESENCE, which is the stricter
 * reading — see the note there.
 */
export const MODELS_REJECTING_SAMPLING_PARAMS: ReadonlySet<string> = new Set([
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
]);

/**
 * Models with NO adaptive-thinking surface: they accept neither
 * `thinking:{type:'adaptive'}` nor `output_config:{effort}` (they predate both
 * and take the legacy `thinking:{type:'enabled', budget_tokens}` form, which
 * this connector never emits). The connector emits those two keys TOGETHER and
 * only when `reasoningEffort` is set, so one set covers both.
 *
 * `claude-opus-4-5` is deliberately in NEITHER set: it supports `effort` (at
 * `low`/`medium`/`high` only), but its adaptive-thinking support was not
 * verifiable from an authoritative source, and asserting a rejection we cannot
 * source is exactly the manufactured fact the module note forbids. A test pins
 * that it stays permitted so the omission reads as a decision, not an oversight.
 */
export const MODELS_REJECTING_ADAPTIVE_THINKING: ReadonlySet<string> = new Set([
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
]);

/** The author-facing `llm_call` config fields this preflight can refuse. */
export interface AnthropicRequestedParams {
  /** `sampling.temperature` — set by the author. */
  hasTemperature: boolean;
  /** `sampling.topP` — set by the author. */
  hasTopP: boolean;
  /** `reasoningEffort` — set by the author. */
  hasReasoningEffort: boolean;
}

/**
 * The AUTHOR-FACING names of the parameters `model` is known to reject, in a
 * stable order. Empty (the overwhelmingly common case) means "nothing known to
 * be unsupported" — either the author set none of them, or the model accepts
 * what they set, or the model is not in either set.
 *
 * Names are the node-config fields (`temperature`, `topP`, `reasoningEffort`),
 * NOT the wire keys (`temperature`, `top_p`, `thinking`/`output_config`): the
 * author edits the former, and an error naming a key they cannot find in their
 * own config is a worse diagnostic than the provider 400 it replaces.
 *
 * PRESENCE, not value: a `temperature` the author explicitly set to the
 * provider default is still refused. Some sources scope the 400 to a
 * NON-DEFAULT value, so this is a conscious over-refusal on the narrow reading.
 * It is the right side to err on — the authored intent is to steer sampling,
 * which a model with no sampling knobs cannot honour at any value, so
 * proceeding would grant the letter of the request while silently dropping its
 * point. "The default" is also undefined for `topP`, so a value-aware gate
 * could not be applied consistently across the two fields.
 */
export function unsupportedAnthropicParams(
  model: string,
  requested: AnthropicRequestedParams,
): readonly string[] {
  const unsupported: string[] = [];
  if (MODELS_REJECTING_SAMPLING_PARAMS.has(model)) {
    if (requested.hasTemperature) unsupported.push('temperature');
    if (requested.hasTopP) unsupported.push('topP');
  }
  if (MODELS_REJECTING_ADAPTIVE_THINKING.has(model) && requested.hasReasoningEffort) {
    unsupported.push('reasoningEffort');
  }
  return unsupported;
}
