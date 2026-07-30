import { describe, expect, it } from 'vitest';
import {
  MODELS_REJECTING_ADAPTIVE_THINKING,
  MODELS_REJECTING_SAMPLING_PARAMS,
  unsupportedAnthropicParams,
} from '../anthropic-models.js';
import { normalizeModelId, unsupportedParamFailure } from '../llm-shared.js';

const NONE = { hasTemperature: false, hasTopP: false, hasReasoningEffort: false };

describe('unsupportedAnthropicParams (#727)', () => {
  it('returns nothing when the author set none of the gated params', () => {
    // The overwhelmingly common case: the default path sets no sampling and no
    // reasoning, so the gate must be invisible even on a rejecting model.
    expect(unsupportedAnthropicParams('claude-opus-5', NONE)).toEqual([]);
  });

  // Models are named LITERALLY here rather than driven from the sets. Iterating
  // the sets under test would move input and expectation in lockstep, so the
  // cases could never fail on data drift — only on a change to the function
  // body, which the cases below already cover. The exhaustive membership pin at
  // the bottom of this file is the guard against drift.
  it.each(['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5'])(
    'names both sampling params on %s',
    (model) => {
      expect(
        unsupportedAnthropicParams(model, { ...NONE, hasTemperature: true, hasTopP: true }),
      ).toEqual([
        { name: 'temperature', cause: 'removed' },
        { name: 'topP', cause: 'removed' },
      ]);
    },
  );

  it.each(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'])(
    'names reasoningEffort on %s',
    (model) => {
      // `unavailable`, NOT `removed`: the adaptive surface was ADDED at 4.6, so
      // these models predate it and the remedy is a NEWER model.
      expect(unsupportedAnthropicParams(model, { ...NONE, hasReasoningEffort: true })).toEqual([
        { name: 'reasoningEffort', cause: 'unavailable' },
      ]);
    },
  );

  it('reports only the params the author ACTUALLY set', () => {
    expect(unsupportedAnthropicParams('claude-opus-5', { ...NONE, hasTopP: true })).toEqual([
      { name: 'topP', cause: 'removed' },
    ]);
  });

  it('does not gate reasoningEffort on a model that only rejects sampling', () => {
    // The two facts are independent: Opus 5 removed the sampling knobs but has a
    // full adaptive-thinking surface. Conflating them into one "modern model"
    // flag would refuse a reasoning-only node that works.
    expect(
      unsupportedAnthropicParams('claude-opus-5', { ...NONE, hasReasoningEffort: true }),
    ).toEqual([]);
  });

  it('gates reasoningEffort on claude-opus-4-5, which accepts effort but predates adaptive', () => {
    // The one model where the two facts come apart. Membership is decided by the
    // `thinking` key (emitted alongside `effort`), not by effort support — and it
    // subsumes the per-value 400 on `reasoningEffort:'max'` that a boolean set
    // could not otherwise express.
    expect(
      unsupportedAnthropicParams('claude-opus-4-5', { ...NONE, hasReasoningEffort: true }),
    ).toEqual([{ name: 'reasoningEffort', cause: 'unavailable' }]);
  });

  it('does not gate sampling on a model that only lacks the thinking surface', () => {
    expect(
      unsupportedAnthropicParams('claude-haiku-4-5', { ...NONE, hasTemperature: true }),
    ).toEqual([]);
  });

  it.each([
    ['an unknown id', 'gpt-4o'],
    ['a model verified to still ACCEPT them', 'claude-opus-4-6'],
    ['the empty string', ''],
    // #751 — a Bedrock id keeps its prefix and stays permitted. Deliberate, and
    // the one variant form NOT normalised: these are reachable only via a
    // proxied `baseUrl`, this preflight has no first-party gate (unlike the
    // OpenAI one), and `anthropic.ts` records that Bedrock's request surface
    // genuinely differs and the preflight is not the remedy. Refusing here would
    // manufacture a local failure on exactly the surface this module declines to
    // claim facts about.
    ['a proxied Bedrock id', 'anthropic.claude-opus-5'],
    ['a cross-region Bedrock id', 'us.anthropic.claude-opus-5'],
    // Same reason, same surface: a Vertex `@`-snapshot is non-first-party only.
    // A `[1m]` bracketed variant is out of #751's scope (date forms only).
    ['a Vertex @-separated snapshot', 'claude-opus-5@20260101'],
    ['a bracketed context variant', 'claude-opus-5[1m]'],
  ])('permits everything on %s (an absent fact is never a refusal)', (_label, model) => {
    // Absence means "not KNOWN to reject" — the inverse of price-table.ts's
    // fail-closed default, for the reason given in the module note. A proxied
    // model must not be refused on a guess; the provider stays the authority.
    expect(
      unsupportedAnthropicParams(model, {
        hasTemperature: true,
        hasTopP: true,
        hasReasoningEffort: true,
      }),
    ).toEqual([]);
  });

  it('DOES refuse sampling on the dated full id of a rejecting model (#751)', () => {
    // INVERTED by #751. The old pin permitted this on the grounds that a dated id
    // "must not be refused on a guess" — but transferring a fact from an alias to
    // its own published full id is identity, not a guess, so the guess objection
    // does not reach this form. What the old behaviour actually bought was that
    // one model got two different answers depending on spelling.
    //
    // Scoped to the DATE form only: the `@`-separated Vertex spelling and the
    // `[1m]` bracketed variant stay permitted (pinned above) — see
    // `normalizeModelId` for why each is deliberately left alone.
    expect(
      unsupportedAnthropicParams('claude-opus-5-20260101', { ...NONE, hasTemperature: true }),
    ).toEqual([{ name: 'temperature', cause: 'removed' }]);
  });

  it('keeps the two sets disjoint from each other', () => {
    // Not a law of nature, but true of every model today, and a model landing in
    // both would mean the connector can emit nothing an author sets — worth
    // failing loudly here rather than discovering it as a puzzling double
    // refusal.
    const overlap = [...MODELS_REJECTING_SAMPLING_PARAMS].filter((m) =>
      MODELS_REJECTING_ADAPTIVE_THINKING.has(m),
    );
    expect(overlap).toEqual([]);
  });

  it('pins the sourced membership of both sets', () => {
    // Sourced from the claude-api model + thinking/effort tables (2026-07-25).
    // Re-derived rather than transcribed from #727, whose own list omitted
    // `claude-sonnet-5` and the Fable/Mythos ids — pinned so a future edit is a
    // decision against the source, not a drift.
    expect([...MODELS_REJECTING_SAMPLING_PARAMS].sort()).toEqual([
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
    // #729 (2026-07-29): `claude-opus-4-1` added on the models overview page's
    // explicit per-model "Adaptive thinking: No" row, which also re-grounds the
    // other three — previously carried on generation-level inference.
    expect([...MODELS_REJECTING_ADAPTIVE_THINKING].sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-1',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
    ]);
  });
});

describe('unsupportedParamFailure message (#727)', () => {
  it('joins two params with a conjunction and pluralizes throughout', () => {
    // The two-param branch is otherwise only reached via `toContain` assertions
    // in the adapter tests, which would pass on a garbled list.
    const ev = unsupportedParamFailure('anthropic_api', 'claude-opus-5', [
      { name: 'temperature', cause: 'removed' },
      { name: 'topP', cause: 'removed' },
    ]);
    expect(ev.kind).toBe('permanent');
    expect(ev.error).toBe(
      'anthropic_api model claude-opus-5 does not support the temperature and topP parameters ' +
        '(removed on this model); remove them from the activity config or ' +
        'select a model that still accepts them.',
    );
  });

  it('points FORWARD in time for an unavailable param, not backward', () => {
    // The defect this shape exists to prevent. A single message string served
    // both causes, so a `reasoningEffort` refusal read "removed on this model
    // ... select a model that still accepts it" — both halves false, and the
    // remedy aimed the author AWAY from the 4.6+ models that support it. The
    // adaptive surface was ADDED at 4.6; `claude-haiku-4-5` predates it.
    const ev = unsupportedParamFailure('anthropic_api', 'claude-haiku-4-5', [
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
    expect(ev.error).toBe(
      'anthropic_api model claude-haiku-4-5 does not support the reasoningEffort parameter ' +
        '(not available on this model, which predates it); remove it from the ' +
        'activity config or select a newer model that supports it.',
    );
    // The old wording must not survive anywhere in the string.
    expect(ev.error).not.toContain('removed on this model');
    expect(ev.error).not.toContain('still accepts');
  });

  it('emits one clause per CAUSE when a model is in both sets', () => {
    // Not reachable through `unsupportedAnthropicParams` today — the two sets
    // are disjoint, pinned above. Tested directly because the builder is
    // exported and generic, and because a legacy id landing under #729 could
    // reject both surfaces. Asserts the two remedies stay separate rather than
    // one cause silently mislabelling the other's fields.
    const ev = unsupportedParamFailure('anthropic_api', 'some-legacy-model', [
      { name: 'temperature', cause: 'removed' },
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
    expect(ev.error).toBe(
      'anthropic_api model some-legacy-model does not support the temperature parameter ' +
        '(removed on this model); remove it from the activity config or ' +
        'select a model that still accepts it. ' +
        'anthropic_api model some-legacy-model does not support the reasoningEffort parameter ' +
        '(not available on this model, which predates it); remove it from the ' +
        'activity config or select a newer model that supports it.',
    );
  });
});

/**
 * #729 — the legacy-id classification, settled for two of the five ids and
 * deliberately still open for three.
 *
 * SOURCE: the models overview page's per-model **"Adaptive thinking"** row
 * (fetched 2026-07-29), which is the per-model fact this module spent two
 * passes waiting for.
 */
describe('adaptive-thinking classification of legacy ids (#729)', () => {
  const EFFORT = { hasTemperature: false, hasTopP: false, hasReasoningEffort: true };

  it('refuses reasoningEffort on claude-opus-4-1, whose row reads "No"', () => {
    expect(unsupportedAnthropicParams('claude-opus-4-1', EFFORT)).toEqual([
      // `unavailable`, not `removed`: the adaptive surface was ADDED at 4.6, so
      // the remedy points at a NEWER model.
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
  });

  it('still PERMITS the three ids the source says nothing about', () => {
    // The deliberate omission, pinned so a later author cannot quietly
    // "complete" the list. These appear in NEITHER published comparison table,
    // and this module's governing rule is that an absent fact is not a refusal:
    // guessing them in would manufacture a local failure of a call that works,
    // while leaving them out costs at most the pre-existing provider 400.
    for (const model of ['claude-opus-4-0', 'claude-sonnet-4-0', 'claude-3-haiku-20240307']) {
      expect(unsupportedAnthropicParams(model, EFFORT)).toEqual([]);
    }
  });

  it('does NOT refuse claude-opus-4-1 when the author set no reasoningEffort', () => {
    // Membership alone must stay invisible: the connector emits the adaptive
    // pair only on author opt-in, so a plain call to a legacy model is untouched.
    expect(
      unsupportedAnthropicParams('claude-opus-4-1', {
        hasTemperature: false,
        hasTopP: false,
        hasReasoningEffort: false,
      }),
    ).toEqual([]);
  });

  it('DOES refuse the DATED form of a member id (#751)', () => {
    // INVERTED by #751 — this was the hole the ticket was filed about, and it is
    // the cleanest case for normalising: the docs publish `claude-opus-4-1` and
    // `claude-opus-4-1-20250805` as the alias and full id of ONE model, both
    // strings reach the wire, and the adaptive-thinking fact settled for the
    // alias is therefore already settled for the dated form. The old pin let the
    // author's choice of spelling decide whether they got a local diagnostic or a
    // provider 400.
    expect(unsupportedAnthropicParams('claude-opus-4-1-20250805', EFFORT)).toEqual([
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
  });

  it('leaves the #729 known-gap ids permitted — including their DATED forms', () => {
    // #751 must not quietly settle #729. The dated forms are the point of this
    // test: the bare aliases contain no date, so on their own they never reach
    // the new code path at all and would pin nothing (an earlier version of this
    // test listed only those three and was vacuous — it passed under an identity
    // normaliser AND under an over-stripping one).
    //
    // `claude-3-haiku-20240307` carries its date as part of the published id, and
    // the two 4.0 full ids miss their own `-0` alias when the date is stripped
    // (see `normalizeModelId`). Every one of these lands on a NON-member either
    // way, so #729's deliberate omission survives this change untouched.
    for (const model of [
      'claude-opus-4-0',
      'claude-sonnet-4-0',
      'claude-3-haiku-20240307',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
    ]) {
      expect(unsupportedAnthropicParams(model, EFFORT)).toEqual([]);
    }
  });

  it('keeps every set member its own normal form (a non-fixed-point entry is DEAD)', () => {
    // The invariant that makes membership and normalisation safe to combine:
    // lookups normalise first, so a member that is not a fixed point could never
    // be matched by any input — it would read as a live capability fact while
    // being unreachable code. Guards both sets at once, and is the test that
    // fires if a future #729 pass adds a DATED id (e.g. `claude-opus-4-20250514`)
    // instead of the alias, or adds it without also adding the alias.
    for (const set of [MODELS_REJECTING_SAMPLING_PARAMS, MODELS_REJECTING_ADAPTIVE_THINKING]) {
      for (const model of set) {
        expect(normalizeModelId(model)).toBe(model);
      }
    }
  });
});
