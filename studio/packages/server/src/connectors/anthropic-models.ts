import { normalizeModelId } from './llm-shared.js';
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
 * Matching is on the NORMALISED id (#751), not the exact string as it once was.
 * A DATED full id (`claude-opus-4-1-20250805`) is reduced to the alias published
 * for that same row, so one model no longer gets two different answers depending
 * on how the author typed it. Dates only — every other variant spelling is left
 * alone, and `normalizeModelId` gives the reason for each. Note the one family
 * where a date strip does NOT reach the alias (`claude-opus-4-0` ⇄
 * `claude-opus-4-20250514`) before adding any 4.0 entry to a set below.
 *
 * `BUILTIN_PRICES` still matches EXACT-STRING and deliberately was not changed
 * with it — a capability is a property of the model (so it transfers across an
 * alias/full-id identity), whereas a price is a property of a PUBLISHED ROW, and
 * merging a dated id onto an alias there could silently mis-price a snapshot that
 * is billed differently. Same-looking helper, opposite fail direction; do not
 * reuse `normalizeModelId` in pricing.
 *
 * Still falling through to permitted, and still with the provider as the
 * authority: any id the sets do not name, and any model served by a proxy /
 * self-hosted `baseUrl` — including a Bedrock `anthropic.`-prefixed id and a
 * Vertex `@`-separated snapshot, which #751 pointedly does NOT normalise (see
 * `normalizeModelId`, and `anthropic.ts` on why the preflight is not Bedrock's
 * remedy).
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
 * ids. Since then, two per-model docs pages: the models overview's "Adaptive
 * thinking" rows (2026-07-29), and the model-deprecations page's parameter and
 * lifecycle tables (2026-09-26). Each set's note says which facts came from which.
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
 *
 * #729 (2026-09-26) — a second, per-model source now backs this set: the
 * model-deprecations page's parameter table
 * (`platform.claude.com/docs/en/about-claude/model-deprecations.md`) says the
 * three knobs return 400 "when set to a non-default value on Claude 4.7 and
 * later models and Claude Mythos Preview". That settled `claude-mythos-preview`
 * (named there outright, after being tracked in #729 as prose-only), and it
 * brought in `claude-opus-5-5`, `claude-fable-5-1` and `claude-mythos-5-1`,
 * which are later than 4.7 and which the set had not been updated for. It also
 * confirms the same non-default scope for every member, so the Sonnet 5 note
 * above now covers the whole set, and so does the over-refusal it argues for.
 */
export const MODELS_REJECTING_SAMPLING_PARAMS: ReadonlySet<string> = new Set([
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
  'claude-mythos-preview',
  'claude-opus-5',
  'claude-opus-5-5',
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
 * SETTLED 2026-07-29 (#729). Every member below is now backed by a
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
 * prose only), so its permission still rests on absence, like the three
 * retired ids below.
 *
 * RETIREMENT: `claude-opus-4-1` was RETIRED on 2026-08-05 (model-deprecations
 * page), so on Anthropic-operated platforms the provider now refuses it whatever
 * the request carries. The entry stays because its fact is still true. It still
 * governs a proxied `baseUrl` that serves the model, and pruning it would change
 * that case for no gain. #729's own thread named pruning it as the natural
 * step once it retired; this is a deliberate reversal of that note, for the
 * proxied-`baseUrl` reason. Nothing else depends on it.
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
 * THE THREE RETIRED IDS — #729 CLOSED 2026-09-26. `claude-opus-4-0`,
 * `claude-sonnet-4-0` and `claude-3-haiku-20240307` appear in neither published
 * comparison table, so no source states their adaptive-thinking fact. The
 * model-deprecations page (fetched 2026-09-26) settles why that no longer
 * matters. All three are RETIRED on Anthropic-operated platforms: Opus 4 and
 * Sonnet 4 on 2026-06-15, Haiku 3 on 2026-04-20. "Requests to retired models
 * will fail." So they stay OUT on purpose, and no future pass should add them.
 * On the first-party API their omission changes no outcome, and a local
 * `reasoningEffort` refusal would only name the WRONG cause for a call that
 * fails anyway. Behind a proxied `baseUrl` that still serves one, the governing
 * rule below applies unchanged: an absent fact is not a refusal. (Partner
 * platforms set their own retirement dates, but their prefixed ids never
 * normalise onto these entries; see the module note.) `claude-mythos-preview`,
 * the other id #729 tracked, is settled on the SAMPLING set above.
 *
 * Settling those needs a per-model fact this page cannot supply — it has no row
 * for them at all. The Models API `capabilities.thinking.types.adaptive` tree
 * remains the only named route, as it was before the overview page grew these
 * rows; what changed is that the page CAN now settle any id it lists, which is
 * how the other four were closed without it.
 *
 * The trap that cost two prior passes, kept for whoever classifies the next
 * model: the tempting citation is the migration guide's heading "Effort
 * parameter (Opus 4.5, Opus 4.6, Sonnet 4.6 only)", read as a global list of
 * what supports `effort`. It is not one — it sits under "Migrating to Opus 4.6 /
 * Sonnet 4.6" and is scoped to that era. Read globally it would also exclude
 * `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-7/4-8` and
 * `claude-fable-5`, every one of which this module deliberately PERMITS (pinned
 * by `anthropic-models.test.ts`). A per-model row settled this; a sharper
 * reading of a generation-level statement never would have.
 *
 * WHY THE BAR FOR ADDING IS HIGHER THAN THE BAR FOR LEAVING OUT, which is what
 * kept the retired three out on no evidence rather than in on a plausible guess: the
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
  // #751 — match on the BASE id, so a dated full id (`claude-opus-4-1-20250805`)
  // classifies like the alias published for the same row. Dates only: a Bedrock
  // prefix, a Vertex `@`-snapshot, a bracketed variant and every sibling-token
  // form are deliberately left alone. See `normalizeModelId`.
  const id = normalizeModelId(model);
  // Sampling knobs EXISTED and were taken away → `removed`.
  if (MODELS_REJECTING_SAMPLING_PARAMS.has(id)) {
    if (requested.hasTemperature) unsupported.push({ name: 'temperature', cause: 'removed' });
    if (requested.hasTopP) unsupported.push({ name: 'topP', cause: 'removed' });
  }
  // The adaptive surface was ADDED at 4.6; these models predate it →
  // `unavailable`. Deliberately NOT `removed`: nothing was taken away, and the
  // remedy points the opposite way (a NEWER model, not an older one).
  //
  // The two sets are disjoint today (pinned by test), so in practice one call
  // yields one cause. Nothing here depends on that: a model added to BOTH sets
  // — which a future model rejecting both surfaces would be — yields both causes and
  // the message builder groups them. Stated because the previous single-cause
  // shape made the disjointness load-bearing without saying so.
  if (MODELS_REJECTING_ADAPTIVE_THINKING.has(id) && requested.hasReasoningEffort) {
    unsupported.push({ name: 'reasoningEffort', cause: 'unavailable' });
  }
  return unsupported;
}
