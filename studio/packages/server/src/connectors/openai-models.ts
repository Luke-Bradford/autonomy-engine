import { normalizeModelId } from './llm-shared.js';
import type { UnsupportedParam } from './llm-shared.js';

/**
 * #730 — per-model REQUEST-SURFACE facts for `openai_api`, the sibling of
 * `anthropic-models.ts` and the same defect class #727 fixed there.
 *
 * OpenAI's REASONING models (the o-series and the GPT-5 series) do not accept
 * the sampling knobs. Sending one answers HTTP 400 `unsupported_parameter`,
 * which `classifyHttpStatus` maps to `permanent`. The connector only emits them
 * when the AUTHOR opted in, which is why no test caught it — the default path
 * sets neither, and `fetch` is mocked, so no real 400 is ever observed.
 *
 * SOURCE: Microsoft Learn, "Azure OpenAI reasoning models" (fetched
 * 2026-07-25), which states outright: "The following are currently unsupported
 * with reasoning models: `temperature`, `top_p`, `presence_penalty`,
 * `frequency_penalty`, `logprobs`, `top_logprobs`, `logit_bias`, `max_tokens`".
 * Membership below is that page's two enumerated reasoning-model feature tables
 * (o-series and GPT-5 series), PLUS its prose — and the "plus" is not a
 * formality. #752 found that `o1-mini` sits in NEITHER table, so the
 * tables-only claim this sentence used to make did not actually cover one of
 * the ids listed under it. Its membership rests on the page's `reasoning_effort`
 * sentence ("for all reasoning models except `o1-mini`"), which names it as a
 * reasoning model in the present tense.
 *
 * An ABSENT feature-table row therefore has two readings here, and this module
 * takes a different one for `o1-mini` than for `o1-preview` (excluded below as
 * "Retired") on purpose: prose that speaks of a model in the present tense is
 * evidence it is still served, where silence in every table and sentence alike
 * is evidence it is gone. The two are consistent, not contradictory — the
 * distinction is whether ANY live text names the id.
 *
 * Corroborated by the 400 text operators actually report: "Unsupported
 * parameter: 'temperature' is not supported with this model".
 *
 * SCOPE, and it is NOT the whole quoted list: this connector emits THREE of
 * those eight from author config — `temperature`, `top_p`, and `max_tokens`
 * (`openai.ts`'s body builder). `stop` and `seed` are also emitted and are
 * NOT in the quoted list, so they need no gate. The three are handled two
 * different ways, because the source prescribes two different remedies:
 *
 *  - `temperature` / `top_p` are REFUSED locally (`unsupportedOpenAiParams`).
 *    There is no replacement field; the authored intent cannot be honoured.
 *  - `max_tokens` is RENAMED on the wire to `max_completion_tokens`
 *    (`openAiUsesMaxCompletionTokens`, #739), because the source states the
 *    replacement outright: reasoning models "will only work with the
 *    `max_completion_tokens` parameter when using the Chat Completions API".
 *    Refusing there would deny a request the provider can serve perfectly well
 *    under a different key.
 *
 * #730 shipped only the first half and tracked the second as #739, on the
 * grounds that a rename carries a gateway-compatibility failure mode a refusal
 * does not. It does, and the answer turned out to be the gate that already
 * existed: the rename is applied ONLY on the first-party base URL, so a gateway
 * that predates `max_completion_tokens` keeps receiving exactly what it
 * receives today. See `openAiUsesMaxCompletionTokens`.
 *
 * FAIL DIRECTION — the same rule as `anthropic-models.ts`, arrived at the same
 * way: list ONLY models KNOWN to reject, so absence means "not known to reject"
 * → permitted, exactly as before this module existed. Manufacturing a local
 * refusal of a call that works is the harm; a missed model costs the
 * pre-existing provider 400.
 *
 * BUT THE PROXY CASE INVERTS, and that is why this module is not a copy of its
 * sibling. `anthropic-models.ts` can lean on id matching to let a proxied
 * `baseUrl` fall through, because a gateway rarely serves models under
 * Anthropic's own ids — and per #751 the proxied spellings it WOULD see (a
 * Bedrock `anthropic.`-prefixed id, a Vertex `@`-separated snapshot) are
 * deliberately left unnormalised so they keep falling through. The
 * OpenAI-COMPATIBLE ecosystem is the opposite: its
 * whole point is reusing OpenAI's exact model names, and such a gateway may
 * well accept (or silently ignore) `temperature` on a model called `gpt-5`.
 * Refusing there would be precisely the manufactured refusal the rule above
 * forbids. So the preflight is additionally gated on the DEFAULT base URL: these
 * are facts about OpenAI's own API, and a custom `baseUrl` is someone else's
 * server whose request surface we have no facts about. See `isOpenAiFirstParty`.
 *
 * Matching is on the NORMALISED id (#751): a dated snapshot (`o3-2025-04-16`)
 * classifies like the alias it is a snapshot of. A `-latest` pointer is NOT
 * normalised (it names no published id to transfer a fact from) and still falls
 * through to permitted, as does every id the set does not name — the provider
 * stays the authority there. Sibling ids are never merged: `o3` and `o3-mini`
 * are separate members and only a date-shaped suffix is stripped, so no model
 * inherits a refusal from a differently-named relative. `BUILTIN_PRICES` keeps
 * exact-string matching for the reason given in `anthropic-models.ts`.
 *
 * `ollama` was checked in the same pass (#730 asked for a confirmation rather
 * than an assumption) and needs no equivalent: it targets Ollama's NATIVE
 * `/api/chat` with an `options` bag, not an OpenAI-shaped body, and its
 * sampling keys are accepted across the local models it serves. There is no
 * per-model forced-choice surface there to gate.
 */

/**
 * OpenAI reasoning models — `temperature` and `top_p` are rejected.
 *
 * DELIBERATE OMISSIONS, so the next author does not "complete" the list and
 * regress it into manufactured refusals:
 *
 *  - Any `*-chat*` id. OpenAI's first-party `gpt-5-chat-latest` is the
 *    NON-reasoning member of the family and does accept sampling; the source's
 *    `gpt-5.1-chat` row sits in its reasoning table, so the two naming schemes
 *    disagree and the conflict is not worth resolving in the refusing
 *    direction.
 *  - `codex-mini`. The source names it, but OpenAI's own id is
 *    `codex-mini-latest`; an entry for either would be a guess about which
 *    string reaches the wire.
 *  - `gpt-5.6-sol` / `-terra` / `-luna`. Named only in the Azure table, whose
 *    deployment naming and OpenAI's first-party ids are not the same namespace
 *    for these.
 *  - Bare `gpt-5.6`. Added to this list by #752, which is the first thing in
 *    this repo to cite the id at all — its `reasoning_effort` sentence names
 *    `gpt-5.6` as the one model accepting `max`, and on the RESPONSES API
 *    (see `openAiReasoningEffort`). That sentence says nothing about whether it
 *    rejects sampling on Chat Completions, and this set's membership rule is a
 *    feature-table row, not "sounds like a reasoning model". Listed here rather
 *    than silently absent so the next author reads a decision instead of a gap
 *    — the omission costs at most the pre-existing 400, and adding it on the
 *    strength of a sentence about a different API and a different parameter
 *    would be the guess this essay exists to prevent.
 *  - `o1-preview`. Retired.
 *
 * Each omission costs at most the pre-existing 400. Adding one on a guess costs
 * a refusal of a call that works, which is not symmetric.
 *
 * THAT CALCULUS IS ABOUT THE REFUSAL, and #739 gave this set a second consumer
 * with a different one. For `openAiUsesMaxCompletionTokens` a wrong ADD costs
 * only a field name — and OpenAI accepts `max_completion_tokens` on
 * non-reasoning models too, so the wrong name is usually served anyway. Do not
 * carry the refusal's high bar over to a rename question, or the reverse: the
 * membership decision is governed by the STRICTER of the two, which is the
 * refusal.
 */
export const MODELS_REJECTING_SAMPLING_PARAMS: ReadonlySet<string> = new Set([
  // o-series
  'o1',
  'o1-mini',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
  // GPT-5 series
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5-codex',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.4-pro',
  'gpt-5.5',
]);

/**
 * #752 — OpenAI models that accept NO `reasoning_effort` at any value.
 *
 * SOURCE: the same Microsoft Learn page — its `reasoning_effort` sentence
 * re-fetched and re-verified 2026-07-29, later than the 2026-07-25 date on the
 * header above, which covers the feature tables. The sentence is a single
 * explicit exception rather than a table: "`reasoning_effort` can be set to
 * `low`, `medium`, or `high` for all reasoning models EXCEPT `o1-mini`". One
 * id, named outright, so this set is one id long and the fail-direction rule
 * keeps it that way — every model the source does not except stays permitted,
 * and the membership pin in the tests makes widening it argue with a test.
 *
 * A SEPARATE set from `MODELS_REJECTING_SAMPLING_PARAMS`, not a reuse of it,
 * because the two facts point OPPOSITE ways. Sampling is rejected by the whole
 * reasoning class; `reasoning_effort` is accepted by the whole reasoning class
 * save one member. Reusing the sampling set would refuse the knob on all 23 ids
 * — the precise inversion of the fact. (`openAiUsesMaxCompletionTokens` DOES
 * reuse that set, for the reason given there: it is the same fact about the
 * same class. This is not.)
 *
 * `o1-mini` is in BOTH sets, and that is the first genuinely reachable
 * two-cause case in either provider module — an author setting `temperature`
 * and `reasoningEffort` on `o1-mini` is told to pick an OLDER model for one and
 * a NEWER one for the other. Both remedies are individually correct and the
 * message builder groups them by cause. Pinned at the RENDERED level in
 * `__tests__/openai.test.ts`, not just as a param array: the string is what the
 * operator actually reads, and it is the reason `unsupportedParamFailure`'s
 * n-safe join stopped being hypothetical.
 *
 * TWO THINGS #752 ASKED ABOUT ARE DELIBERATELY NOT HERE, so they are not
 * silently re-opened:
 *
 *  - NON-REASONING models (the ticket's first defect — `reasoning_effort`
 *    emitted to every model). DECISION: send it, i.e. a documented no-op. The
 *    source names no non-reasoning model that REJECTS the key, and its
 *    `gpt-5.1-chat` row — the non-reasoning member of a reasoning family —
 *    carries reasoning-effort support outright. Under the fail direction an
 *    absent fact must not become a local refusal, and the cost of being wrong
 *    is the pre-existing provider 400. A model later found to reject it belongs
 *    in the set above, which is why the set is keyed on the fact and not on
 *    "is a reasoning model".
 *  - PER-VALUE constraints (`gpt-5-pro` accepts only `high`, footnote 5).
 *    DEFERRED, because the constraint is UNREACHABLE through this adapter and a
 *    refusal for it would be dead code that misdiagnoses a live failure. The
 *    same page marks `gpt-5-pro` Chat-Completions `-` (Responses-API only), and
 *    this adapter posts only to `/chat/completions` — the identical argument
 *    `openAiUsesMaxCompletionTokens` already makes for the `-pro` ids. Such a
 *    call fails at the ENDPOINT, so an error blaming the author's effort VALUE
 *    would point at the wrong thing. Every other value constraint the page
 *    states is out of reach too: `minimal`/`xhigh`/`none` are not in studio's
 *    enum or not emitted, and `max` is Responses-API-only (see
 *    `openAiReasoningEffort`, which lowers it away regardless). Recording a
 *    value dimension would also mean a third `UnsupportedParamCause` on the
 *    PROVIDER-GENERIC type in `llm-shared.ts`, whose message builder groups
 *    strictly by cause and renders one sentence per cause — a shape no
 *    per-value message fits. Tracked as #809; build it when a reachable member
 *    exists.
 */
export const MODELS_REJECTING_REASONING_EFFORT: ReadonlySet<string> = new Set(['o1-mini']);

/** The OpenAI base URL the adapter uses when the connection sets none. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/**
 * Is this connection talking to OpenAI itself?
 *
 * Only then do the capability facts above apply. An author-set `baseUrl` means
 * an OpenAI-COMPATIBLE gateway (vLLM, LiteLLM, OpenRouter, Azure, a local
 * proxy), which reuses OpenAI's model names while making its own decisions
 * about the request surface — including, commonly, accepting or ignoring
 * `temperature` on a model OpenAI would reject it on.
 *
 * Compared post-normalisation (trailing slashes already stripped by the caller)
 * and case-sensitively on the whole string: this is a conservative "we are
 * certain" test, not a URL parser. Anything it cannot recognise falls through to
 * permitted, which is the same direction as an absent model row.
 */
export function isOpenAiFirstParty(baseUrl: string): boolean {
  return baseUrl === DEFAULT_OPENAI_BASE_URL;
}

/**
 * #739 — does `model` take `max_completion_tokens` instead of `max_tokens` on
 * Chat Completions?
 *
 * Membership is `MODELS_REJECTING_SAMPLING_PARAMS`, REUSED rather than
 * duplicated: the source names `max_tokens` in the same "currently unsupported
 * with reasoning models" sentence as `temperature` and `top_p`, so this is one
 * fact about one class of model, and a second hand-maintained list of the same
 * 23 ids would only drift from the first.
 *
 * The two facts are not perfectly co-extensive, and the difference is stated
 * rather than glossed. The source's feature tables mark several members
 * (the `-pro` ids — `o3-pro`, `gpt-5-pro`, `gpt-5.4-pro` — and the `*-codex` ids)
 * as Responses-API-only — no
 * Chat Completions row, and on Responses the budget field is
 * `max_output_tokens`, a third name again. So the sampling-rejection fact
 * covers every member, while the `max_completion_tokens` fact covers only the
 * Chat-Completions-capable subset. Reusing the set is still correct HERE
 * because this adapter speaks only Chat Completions (`openai.ts` posts to
 * `/chat/completions`): a Responses-only model fails at the endpoint whatever
 * we name the field, so the rename is moot for exactly those members rather
 * than wrong for them. The set is a superset, and a harmless one.
 *
 * Takes ONLY `model`, deliberately — the same shape as `unsupportedOpenAiParams`
 * and for the same reason. The first-party gate (`isOpenAiFirstParty`) is
 * composed by the CALLER, so the two sibling facts share one copy of that gate
 * instead of each carrying its own to drift.
 *
 * THE AUTHOR'S NUMBER CHANGES MEANING, which is worth knowing before reading a
 * surprising result. `max_tokens` bounded VISIBLE output; `max_completion_tokens`
 * bounds reasoning + visible output together. So a `maxTokens` an author tuned
 * against a non-reasoning model can, on a reasoning model, be consumed entirely
 * by invisible reasoning and yield a truncated completion with
 * `finish_reason: 'length'`.
 *
 * What that then does depends on a response shape this module does NOT pin, so
 * both branches are named rather than one asserted: an empty STRING (`''`) is a
 * REAL result and still succeeds per the settled #461 contract (`stopReason`
 * carries why, downstream branches on it), whereas a `null` content would take
 * `noCompletionFailure`'s `malformed_block` path — a `permanent` failure whose
 * diagnostic blames the response shape when the actual cause was the budget.
 * Neither is silent and neither is worse than the guaranteed 400 this rename
 * replaces, which is why the sweep documents them instead of choosing. Whether
 * an empty-and-truncated completion deserves louder treatment is a genuine
 * re-open of #461 and is filed as #750.
 */
export function openAiUsesMaxCompletionTokens(model: string): boolean {
  // #751 — on the BASE id, so `o3-2025-04-16` takes the same field name as `o3`.
  return MODELS_REJECTING_SAMPLING_PARAMS.has(normalizeModelId(model));
}

/** The author-facing `llm_call` config fields this preflight can refuse. */
export interface OpenAiRequestedParams {
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
 * be unsupported".
 *
 * BOTH causes occur here, pointing opposite ways, and #752 is what made that
 * true — before it this function only ever said `removed`:
 *
 *  - `temperature`/`topP` are `removed`. The knob exists on OpenAI's other
 *    models and is gone on the reasoning class, which is the NEWER thing, so
 *    `removed`'s "select a model that still accepts temperature" is the remedy
 *    that resolves it. `unavailable` ("predates it … select a NEWER model")
 *    would point backwards.
 *  - `reasoningEffort` is `unavailable`. `o1-mini` PREDATES the adaptive
 *    surface that `o3-mini`/`o4-mini` have, so here it is "newer" that
 *    resolves — the same direction the Anthropic module uses for the same
 *    knob, and the opposite of the line above it.
 *
 * Getting either backwards sends the author hunting in the wrong direction,
 * which is the whole reason `UnsupportedParamCause` is typed rather than prose.
 *
 * PRESENCE, not value — same reasoning as `unsupportedAnthropicParams`: the
 * authored intent is to steer sampling (or reasoning depth), which a model
 * lacking the knob cannot honour at any value. The one per-VALUE fact the
 * source states is unreachable through this adapter; see
 * `MODELS_REJECTING_REASONING_EFFORT`.
 */
export function unsupportedOpenAiParams(
  model: string,
  requested: OpenAiRequestedParams,
): readonly UnsupportedParam[] {
  const unsupported: UnsupportedParam[] = [];
  // #751 — on the BASE id: a dated snapshot classifies exactly as its alias
  // does. Sibling ids (`o3-mini` vs `o3`) are NOT merged; see
  // `normalizeModelId`. Reached only behind the caller's `isOpenAiFirstParty`
  // gate, so this never widens refusals onto an OpenAI-compatible gateway.
  const id = normalizeModelId(model);
  // Sampling knobs exist elsewhere and are gone on this class → `removed`.
  if (MODELS_REJECTING_SAMPLING_PARAMS.has(id)) {
    if (requested.hasTemperature) unsupported.push({ name: 'temperature', cause: 'removed' });
    if (requested.hasTopP) unsupported.push({ name: 'topP', cause: 'removed' });
  }
  // #752 — a SEPARATE membership test, not an `else`. The early return this
  // replaced (`if (!MODELS_REJECTING_SAMPLING_PARAMS.has(id)) return []`) would
  // have made the reasoning-effort fact reachable ONLY for models that also
  // reject sampling — a coupling between two independent facts.
  //
  // BE HONEST ABOUT WHAT IS TESTED: no test can currently tell the two
  // topologies apart, and nesting this block back inside the sampling branch
  // still passes the whole suite. That is because the sole member of this set
  // (`o1-mini`) is also a member of the sampling set, so the coupling is
  // presently unobservable. It is written flat anyway because the two sets
  // encode facts that vary independently, and the day either of them moves the
  // nested form would silently drop a refusal rather than fail a test. What
  // guards the assumption meanwhile is the membership pin on
  // `MODELS_REJECTING_SAMPLING_PARAMS`: removing `o1-mini` from it has to argue
  // with that test first.
  if (MODELS_REJECTING_REASONING_EFFORT.has(id) && requested.hasReasoningEffort) {
    unsupported.push({ name: 'reasoningEffort', cause: 'unavailable' });
  }
  return unsupported;
}
