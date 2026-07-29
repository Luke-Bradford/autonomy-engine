import type { UnsupportedParam } from './llm-shared.js';

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
 * On `claude-sonnet-5` the source is explicit that the 400 fires only on a
 * NON-DEFAULT value — omitting the field, or passing its default, is accepted.
 * `unsupportedAnthropicParams` still gates on PRESENCE, so a `temperature: 1` on
 * Sonnet 5 is refused locally though the provider would serve it. That is a
 * deliberate over-refusal, not an unexamined one: see the rationale on that
 * function, which turns on authored INTENT rather than on wire acceptance. Stated
 * per-model rather than as a vague "sources differ" because the evidence is not
 * actually in conflict — it is specific.
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
 * SETTLED 2026-07-29 (#729, partially). Every member below is now backed by a
 * DIRECT PER-MODEL FACT rather than by generation-level inference: the models
 * overview page (`platform.claude.com/docs/en/about-claude/models/overview.md`)
 * publishes an explicit **"Adaptive thinking"** row per model in both its
 * current and legacy comparison tables. It reads `No` for `claude-opus-4-5`,
 * `claude-sonnet-4-5`, `claude-haiku-4-5` and `claude-opus-4-1`, and `Yes` for
 * every PERMITTED model that HAS a row (Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5,
 * Opus 5, Sonnet 5) — so the same source that adds a member also confirms each
 * non-member, which is the half a one-directional citation usually leaves
 * unchecked. The "that has a row" qualifier is load-bearing, not hedging:
 * `claude-mythos-5` is permitted here and has no row (the page covers it in
 * prose only), so its permission still rests on absence, like the three ids in
 * the KNOWN GAP below.
 *
 * RETIREMENT, because it changes how much this settlement is worth:
 * `claude-opus-4-1` is DEPRECATED and retires 2026-08-05, days after this entry
 * was added. The entry is still correct and still worth having — an operator
 * naming it today gets a local diagnostic instead of a provider 400 — but it is
 * short-lived by construction, and after that date it becomes dead weight to
 * prune rather than a fact to maintain.
 *
 * `claude-opus-4-5` is worth spelling out because it is the one model where the
 * two facts come apart: it accepts `output_config.effort` (at
 * `low`/`medium`/`high`), so it is tempting to read it as supported. But
 * `effort` is not what decides membership — the connector emits `effort` and
 * `thinking:{type:'adaptive'}` TOGETHER, and the row above says 4.5 has no
 * adaptive thinking, so the pair is rejected on the `thinking` key regardless of
 * the effort value.
 *
 * SEPARATELY, and NOT as a justification for membership: 4.5 also rejects
 * `reasoningEffort:'max'` while accepting `low`/`medium`/`high`. That fact does
 * different work — it is why a BOOLEAN set is a sufficient shape here.
 * `reasoningEffortSchema` admits `max`, a per-(model, VALUE) fact no boolean set
 * can express; with 4.5 refused wholesale that dimension is empty, because every
 * remaining model the connector can reach either accepts all four schema values
 * or is refused outright. Re-check THAT claim before removing any model from
 * this set — it does not follow from the adaptive-thinking rows.
 *
 * KNOWN GAP, narrowed 2026-07-29 from four ids to three. `claude-opus-4-1` was
 * on this list and is now a member on the direct row above. The remainder —
 * `claude-opus-4-0`, `claude-sonnet-4-0`, `claude-3-haiku-20240307` — appear in
 * NEITHER published comparison table, so the source that settled the other four
 * says nothing at all about them. Under this module's governing rule an absent
 * fact is not a refusal, so they stay PERMITTED and remain tracked in #729.
 * `claude-mythos-preview` is a different shape of gap on the SAMPLING set above
 * (the page names it in prose but gives it no capability row) and rides the same
 * ticket.
 *
 * Two of those three are near or past retirement — `claude-3-haiku-20240307`'s
 * published retirement date (2026-04-19) has ALREADY passed, so its row may be
 * absent because the model is gone rather than because the fact is unpublished,
 * and no classification would change any outcome for it. Treat the live residue
 * of #729 as `claude-opus-4-0` and `claude-sonnet-4-0`, and confirm the third is
 * actually retired before spending a cycle on it.
 *
 * Settling those needs a per-model fact this page cannot supply — it has no row
 * for them at all. The Models API `capabilities.thinking.types.adaptive` tree
 * remains the only named route, as it was before the overview page grew these
 * rows; what changed is that the page CAN now settle any id it lists, which is
 * how the other four were closed without it.
 *
 * The trap that cost two prior passes, kept because it is still live for those
 * three: the tempting citation is the migration guide's heading "Effort
 * parameter (Opus 4.5, Opus 4.6, Sonnet 4.6 only)", read as a global list of
 * what supports `effort`. It is not one — it sits under "Migrating to Opus 4.6 /
 * Sonnet 4.6" and is scoped to that era. Read globally it would also exclude
 * `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-7/4-8` and
 * `claude-fable-5`, every one of which this module deliberately PERMITS (pinned
 * by `anthropic-models.test.ts`). A per-model row settled this; a sharper
 * reading of a generation-level statement never would have.
 *
 * WHY THE BAR FOR ADDING IS HIGHER THAN THE BAR FOR LEAVING OUT, which is what
 * keeps those three out on no evidence rather than in on a plausible guess: the
 * two errors are not symmetric. Omitting a model that DOES reject costs a
 * provider 400 classified `permanent` — the pre-existing behaviour, bounded, and
 * the direction this module's fail-open essay prefers. Including a model that
 * does NOT reject costs a MANUFACTURED local refusal of a call that works, which
 * is the harm that essay exists to avoid.
 */
export const MODELS_REJECTING_ADAPTIVE_THINKING: ReadonlySet<string> = new Set([
  'claude-opus-4-5',
  'claude-opus-4-1',
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
): readonly UnsupportedParam[] {
  const unsupported: UnsupportedParam[] = [];
  // Sampling knobs EXISTED and were taken away → `removed`.
  if (MODELS_REJECTING_SAMPLING_PARAMS.has(model)) {
    if (requested.hasTemperature) unsupported.push({ name: 'temperature', cause: 'removed' });
    if (requested.hasTopP) unsupported.push({ name: 'topP', cause: 'removed' });
  }
  // The adaptive surface was ADDED at 4.6; these models predate it →
  // `unavailable`. Deliberately NOT `removed`: nothing was taken away, and the
  // remedy points the opposite way (a NEWER model, not an older one).
  //
  // The two sets are disjoint today (pinned by test), so in practice one call
  // yields one cause. Nothing here depends on that: a model added to BOTH sets
  // — which a legacy id landing under #729 could be — yields both causes and
  // the message builder groups them. Stated because the previous single-cause
  // shape made the disjointness load-bearing without saying so.
  if (MODELS_REJECTING_ADAPTIVE_THINKING.has(model) && requested.hasReasoningEffort) {
    unsupported.push({ name: 'reasoningEffort', cause: 'unavailable' });
  }
  return unsupported;
}
