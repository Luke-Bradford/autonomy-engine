import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_BASE_URL,
  MODELS_REJECTING_SAMPLING_PARAMS,
  isOpenAiFirstParty,
  unsupportedOpenAiParams,
} from '../openai-models.js';

const NONE = { hasTemperature: false, hasTopP: false };

describe('unsupportedOpenAiParams (#730)', () => {
  it('returns nothing when the author set neither sampling param', () => {
    // The overwhelmingly common case: the default path sets no sampling at all,
    // so the gate must be invisible even on a rejecting model.
    expect(unsupportedOpenAiParams('o3', NONE)).toEqual([]);
  });

  // Named LITERALLY rather than driven from the set: iterating the set under
  // test would move input and expectation in lockstep, so these could only fail
  // on a change to the function body. The membership pin below guards the data.
  it.each(['o3', 'o4-mini', 'gpt-5', 'gpt-5.4-mini'])('names both params on %s', (model) => {
    expect(unsupportedOpenAiParams(model, { hasTemperature: true, hasTopP: true })).toEqual([
      // `removed`, NOT `unavailable`: a reasoning model is the NEWER thing, so
      // "select a newer model" would send the author the wrong way. The remedy
      // is a model that still accepts the knob.
      { name: 'temperature', cause: 'removed' },
      { name: 'topP', cause: 'removed' },
    ]);
  });

  it('names only the param the author actually set', () => {
    expect(unsupportedOpenAiParams('o3', { hasTemperature: true, hasTopP: false })).toEqual([
      { name: 'temperature', cause: 'removed' },
    ]);
    expect(unsupportedOpenAiParams('o3', { hasTemperature: false, hasTopP: true })).toEqual([
      { name: 'topP', cause: 'removed' },
    ]);
  });

  it('does NOT refuse a non-reasoning model, which accepts sampling', () => {
    // The fail direction: an absent row means permitted. `gpt-4o` and the chat
    // family take `temperature` happily, and refusing them would break calls
    // that work today.
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest', 'gpt-5.1-chat']) {
      expect(unsupportedOpenAiParams(model, { hasTemperature: true, hasTopP: true })).toEqual([]);
    }
  });

  it('does NOT refuse a dated or -latest VARIANT of a rejecting id', () => {
    // Exact-string matching, like `BUILTIN_PRICES`. A variant falls through to
    // permitted and the provider stays the authority — the pre-existing
    // behaviour, which is the safe direction to be wrong in.
    expect(
      unsupportedOpenAiParams('o3-2025-04-16', { hasTemperature: true, hasTopP: false }),
    ).toEqual([]);
    expect(
      unsupportedOpenAiParams('codex-mini-latest', { hasTemperature: true, hasTopP: false }),
    ).toEqual([]);
  });

  it('pins the sourced membership of the set', () => {
    // Sourced from Microsoft Learn "Azure OpenAI reasoning models" (2026-07-25):
    // its two enumerated reasoning-model feature tables, minus the four classes
    // of deliberate omission documented on the set. Pinned so a future edit is a
    // decision against the source rather than a drift — and so "completing" the
    // list with a guess has to argue with this test first.
    expect([...MODELS_REJECTING_SAMPLING_PARAMS].sort()).toEqual([
      'gpt-5',
      'gpt-5-codex',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-pro',
      'gpt-5.1',
      'gpt-5.1-codex',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex-mini',
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.3-codex',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.4-pro',
      'gpt-5.5',
      'o1',
      'o1-mini',
      'o3',
      'o3-mini',
      'o3-pro',
      'o4-mini',
    ]);
  });

  it('holds no `*-chat*` id — the non-reasoning member of the family', () => {
    // The one omission a future author is most likely to "fix", because the
    // source's own `gpt-5.1-chat` row sits in its reasoning table. Stated as its
    // own case so deleting it is a deliberate act.
    expect([...MODELS_REJECTING_SAMPLING_PARAMS].filter((m) => m.includes('chat'))).toEqual([]);
  });
});

describe('isOpenAiFirstParty (#730)', () => {
  it('is true only for the default OpenAI base URL', () => {
    expect(isOpenAiFirstParty(DEFAULT_OPENAI_BASE_URL)).toBe(true);
  });

  it('is false for every OpenAI-COMPATIBLE gateway', () => {
    // This is the inverted-proxy case that makes this module differ from
    // `anthropic-models.ts`: these gateways deliberately reuse OpenAI's exact
    // model names while deciding their own request surface, so a capability
    // fact about api.openai.com says nothing about them. Refusing here would
    // manufacture a local failure of a call that works.
    for (const base of [
      'https://openrouter.ai/api/v1',
      'http://localhost:8000/v1',
      'https://my-gateway.example.com/openai/v1',
      'https://api.openai.com/v1/beta',
    ]) {
      expect(isOpenAiFirstParty(base)).toBe(false);
    }
  });
});
