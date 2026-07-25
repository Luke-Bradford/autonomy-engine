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
 * (o-series and GPT-5 series). Corroborated by the 400 text operators actually
 * report: "Unsupported parameter: 'temperature' is not supported with this
 * model".
 *
 * SCOPE, and it is NOT the whole quoted list: this connector emits THREE of
 * those eight from author config — `temperature`, `top_p`, and `max_tokens`
 * (`openai.ts`'s body builder). Only the first two are gated here. `max_tokens`
 * is deliberately left alone and tracked as #739, because its remedy is
 * different in kind: the source says reasoning models "will only work with the
 * `max_completion_tokens` parameter when using the Chat Completions API", so the
 * fix is to RENAME the field on the wire, not to refuse the call. A rename has a
 * failure mode a refusal does not — `max_completion_tokens` is newer than many
 * OpenAI-compatible gateways — and deciding that belongs in its own change
 * rather than riding along here. Until #739 lands, an author who sets BOTH
 * `temperature` and `maxTokens` on a reasoning model gets this preflight's
 * message naming `temperature`, fixes that, and then still meets the provider's
 * own 400 for `max_tokens`. Stated so the partial diagnosis is a known
 * limitation rather than a surprise.
 *
 * FAIL DIRECTION — the same rule as `anthropic-models.ts`, arrived at the same
 * way: list ONLY models KNOWN to reject, so absence means "not known to reject"
 * → permitted, exactly as before this module existed. Manufacturing a local
 * refusal of a call that works is the harm; a missed model costs the
 * pre-existing provider 400.
 *
 * BUT THE PROXY CASE INVERTS, and that is why this module is not a copy of its
 * sibling. `anthropic-models.ts` can lean on exact-string matching to let a
 * proxied `baseUrl` fall through, because a gateway rarely serves models under
 * Anthropic's exact ids. The OpenAI-COMPATIBLE ecosystem is the opposite: its
 * whole point is reusing OpenAI's exact model names, and such a gateway may
 * well accept (or silently ignore) `temperature` on a model called `gpt-5`.
 * Refusing there would be precisely the manufactured refusal the rule above
 * forbids. So the preflight is additionally gated on the DEFAULT base URL: these
 * are facts about OpenAI's own API, and a custom `baseUrl` is someone else's
 * server whose request surface we have no facts about. See `isOpenAiFirstParty`.
 *
 * Matching is EXACT-STRING, like `BUILTIN_PRICES`. A dated or `-latest` variant
 * therefore falls through to permitted and the provider stays the authority —
 * the pre-existing behaviour, merely no longer the only behaviour.
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
 *  - `o1-preview`. Retired.
 *
 * Each omission costs at most the pre-existing 400. Adding one on a guess costs
 * a refusal of a call that works, which is not symmetric.
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

/** The author-facing `llm_call` config fields this preflight can refuse. */
export interface OpenAiRequestedParams {
  /** `sampling.temperature` — set by the author. */
  hasTemperature: boolean;
  /** `sampling.topP` — set by the author. */
  hasTopP: boolean;
}

/**
 * The AUTHOR-FACING names of the sampling parameters `model` is known to reject,
 * in a stable order. Empty (the overwhelmingly common case) means "nothing known
 * to be unsupported".
 *
 * `removed`, NOT `unavailable`, and the distinction is the opposite of the
 * Anthropic module's: `unavailable` renders "not available on this model, which
 * predates it … select a NEWER model", which points backwards here. A reasoning
 * model is the newer thing; the knob exists on OpenAI's other models and is gone
 * on this class, so `removed`'s "select a model that still accepts temperature"
 * is the remedy that actually resolves it.
 *
 * PRESENCE, not value — same reasoning as `unsupportedAnthropicParams`: the
 * authored intent is to steer sampling, which a model with no sampling knobs
 * cannot honour at any value.
 */
export function unsupportedOpenAiParams(
  model: string,
  requested: OpenAiRequestedParams,
): readonly UnsupportedParam[] {
  if (!MODELS_REJECTING_SAMPLING_PARAMS.has(model)) return [];
  const unsupported: UnsupportedParam[] = [];
  if (requested.hasTemperature) unsupported.push({ name: 'temperature', cause: 'removed' });
  if (requested.hasTopP) unsupported.push({ name: 'topP', cause: 'removed' });
  return unsupported;
}
