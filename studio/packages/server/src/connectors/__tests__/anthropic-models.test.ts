import { describe, expect, it } from 'vitest';
import {
  MODELS_REJECTING_ADAPTIVE_THINKING,
  MODELS_REJECTING_SAMPLING_PARAMS,
  unsupportedAnthropicParams,
} from '../anthropic-models.js';

const NONE = { hasTemperature: false, hasTopP: false, hasReasoningEffort: false };

describe('unsupportedAnthropicParams (#727)', () => {
  it('returns nothing when the author set none of the gated params', () => {
    // The overwhelmingly common case: the default path sets no sampling and no
    // reasoning, so the gate must be invisible even on a rejecting model.
    expect(unsupportedAnthropicParams('claude-opus-5', NONE)).toEqual([]);
  });

  it.each([...MODELS_REJECTING_SAMPLING_PARAMS])('names both sampling params on %s', (model) => {
    expect(
      unsupportedAnthropicParams(model, { ...NONE, hasTemperature: true, hasTopP: true }),
    ).toEqual(['temperature', 'topP']);
  });

  it.each([...MODELS_REJECTING_ADAPTIVE_THINKING])('names reasoningEffort on %s', (model) => {
    expect(unsupportedAnthropicParams(model, { ...NONE, hasReasoningEffort: true })).toEqual([
      'reasoningEffort',
    ]);
  });

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
    ['the deliberately-unasserted model', 'claude-opus-4-5'],
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
      'claude-sonnet-4-5',
    ]);
  });
});
