import { describe, expect, it } from 'vitest';
import {
  MODELS_REJECTING_ADAPTIVE_THINKING,
  MODELS_REJECTING_SAMPLING_PARAMS,
  unsupportedAnthropicParams,
} from '../anthropic-models.js';
import { unsupportedParamFailure } from '../llm-shared.js';

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
      ).toEqual(['temperature', 'topP']);
    },
  );

  it.each(['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'])(
    'names reasoningEffort on %s',
    (model) => {
      expect(unsupportedAnthropicParams(model, { ...NONE, hasReasoningEffort: true })).toEqual([
        'reasoningEffort',
      ]);
    },
  );

  it('reports only the params the author ACTUALLY set', () => {
    expect(unsupportedAnthropicParams('claude-opus-5', { ...NONE, hasTopP: true })).toEqual([
      'topP',
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
    ).toEqual(['reasoningEffort']);
  });

  it('does not gate sampling on a model that only lacks the thinking surface', () => {
    expect(
      unsupportedAnthropicParams('claude-haiku-4-5', { ...NONE, hasTemperature: true }),
    ).toEqual([]);
  });

  it.each([
    ['an unknown id', 'gpt-4o'],
    ['a dated variant of a rejecting model', 'claude-opus-5-20260101'],
    ['a bracketed variant', 'claude-opus-4-8[1m]'],
    ['a model verified to still ACCEPT them', 'claude-opus-4-6'],
    ['the empty string', ''],
  ])('permits everything on %s (an absent fact is never a refusal)', (_label, model) => {
    // Matching is exact-string, and absence means "not KNOWN to reject" — the
    // inverse of price-table.ts's fail-closed default, for the reason given in
    // the module note. A dated id or a proxied model must not be refused on a
    // guess; the provider stays the authority there.
    expect(
      unsupportedAnthropicParams(model, {
        hasTemperature: true,
        hasTopP: true,
        hasReasoningEffort: true,
      }),
    ).toEqual([]);
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
    expect([...MODELS_REJECTING_ADAPTIVE_THINKING].sort()).toEqual([
      'claude-haiku-4-5',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
    ]);
  });
});

describe('unsupportedParamFailure message (#727)', () => {
  it('joins two params with a conjunction and pluralizes throughout', () => {
    // The two-param branch is otherwise only reached via `toContain` assertions
    // in the adapter tests, which would pass on a garbled list. `params.length`
    // is bounded at 2 by the two disjoint sets, so this covers the whole space
    // alongside the single-param case below.
    const ev = unsupportedParamFailure('anthropic_api', 'claude-opus-5', ['temperature', 'topP']);
    expect(ev.kind).toBe('permanent');
    expect(ev.error).toBe(
      'anthropic_api model claude-opus-5 does not support the temperature and topP parameters ' +
        '(removed on this model); remove them from the activity config or ' +
        'select a model that still accepts them.',
    );
  });

  it('uses singular wording for one param', () => {
    const ev = unsupportedParamFailure('anthropic_api', 'claude-haiku-4-5', ['reasoningEffort']);
    expect(ev.error).toBe(
      'anthropic_api model claude-haiku-4-5 does not support the reasoningEffort parameter ' +
        '(removed on this model); remove it from the activity config or ' +
        'select a model that still accepts it.',
    );
  });
});
