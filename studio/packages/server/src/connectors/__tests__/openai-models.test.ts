import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENAI_BASE_URL,
  MODELS_REJECTING_REASONING_EFFORT,
  MODELS_REJECTING_SAMPLING_PARAMS,
  isOpenAiFirstParty,
  openAiUsesMaxCompletionTokens,
  unsupportedOpenAiParams,
} from '../openai-models.js';
import { normalizeModelId } from '../llm-shared.js';

const NONE = { hasTemperature: false, hasTopP: false, hasReasoningEffort: false };

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
    expect(
      unsupportedOpenAiParams(model, {
        hasTemperature: true,
        hasTopP: true,
        hasReasoningEffort: false,
      }),
    ).toEqual([
      // `removed`, NOT `unavailable`: a reasoning model is the NEWER thing, so
      // "select a newer model" would send the author the wrong way. The remedy
      // is a model that still accepts the knob.
      { name: 'temperature', cause: 'removed' },
      { name: 'topP', cause: 'removed' },
    ]);
  });

  it('names only the param the author actually set', () => {
    expect(
      unsupportedOpenAiParams('o3', {
        hasTemperature: true,
        hasTopP: false,
        hasReasoningEffort: false,
      }),
    ).toEqual([{ name: 'temperature', cause: 'removed' }]);
    expect(
      unsupportedOpenAiParams('o3', {
        hasTemperature: false,
        hasTopP: true,
        hasReasoningEffort: false,
      }),
    ).toEqual([{ name: 'topP', cause: 'removed' }]);
  });

  it('does NOT refuse a non-reasoning model, which accepts sampling', () => {
    // The fail direction: an absent row means permitted. `gpt-4o` and the chat
    // family take `temperature` happily, and refusing them would break calls
    // that work today.
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest', 'gpt-5.1-chat']) {
      expect(
        unsupportedOpenAiParams(model, {
          hasTemperature: true,
          hasTopP: true,
          hasReasoningEffort: false,
        }),
      ).toEqual([]);
    }
  });

  it('DOES refuse the dated snapshot of a rejecting id (#751)', () => {
    // INVERTED by #751. The old pin let the same model be refused or permitted
    // depending on which spelling the author typed, which is not a safe
    // direction so much as an arbitrary one: `o3-2025-04-16` IS `o3` — the
    // provider publishes them as one row's snapshot and alias — so it rejects
    // `temperature` identically, and permitting it just moved the failure to a
    // provider 400 with a worse diagnostic.
    expect(
      unsupportedOpenAiParams('o3-2025-04-16', {
        hasTemperature: true,
        hasTopP: false,
        hasReasoningEffort: false,
      }),
    ).toEqual([{ name: 'temperature', cause: 'removed' }]);
  });

  it('still does NOT refuse a -latest pointer (not a date — nothing to transfer)', () => {
    // `codex-mini-latest` is deliberately untouched: `-latest` is not a dated
    // snapshot, the id it resolves to is not published, and `codex-mini` is not
    // a set member anyway. The absent fact stays absent.
    expect(
      unsupportedOpenAiParams('codex-mini-latest', {
        hasTemperature: true,
        hasTopP: false,
        hasReasoningEffort: false,
      }),
    ).toEqual([]);
  });

  it('pins the sourced membership of the set', () => {
    // Sourced from Microsoft Learn "Azure OpenAI reasoning models" (2026-07-25):
    // its two enumerated reasoning-model feature tables, minus the four classes
    // of deliberate omission documented on the set — PLUS `o1-mini`, which #752
    // found sits in neither table and is sourced from the page's prose instead.
    // Pinned so a future edit is a decision against the source rather than a
    // drift — and so "completing" the list with a guess has to argue with this
    // test first.
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

describe('openAiUsesMaxCompletionTokens (#739)', () => {
  it('is true for a reasoning model, which rejects `max_tokens` outright', () => {
    // The source lists `max_tokens` alongside `temperature`/`top_p` in the SAME
    // "currently unsupported with reasoning models" sentence, and states the
    // replacement: reasoning models "will only work with the
    // `max_completion_tokens` parameter when using the Chat Completions API".
    // Named literally rather than driven from the set, for the same reason the
    // sampling cases above are.
    for (const model of ['o1', 'o3', 'o4-mini', 'gpt-5', 'gpt-5.4-mini', 'gpt-5.5']) {
      expect(openAiUsesMaxCompletionTokens(model)).toBe(true);
    }
  });

  it('is false for a non-reasoning model, which still takes `max_tokens`', () => {
    // The fail direction, identical to the sampling gate: an absent row means
    // the PRE-EXISTING wire field. Renaming here would break calls that work.
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest', 'gpt-5.1-chat']) {
      expect(openAiUsesMaxCompletionTokens(model)).toBe(false);
    }
  });

  it('is TRUE for the dated snapshot of a reasoning id (#751)', () => {
    // INVERTED by #751, and this half is a plain bug fix rather than a judgement
    // call: `o3-2025-04-16` is a reasoning model, so it takes
    // `max_completion_tokens`. Sending `max_tokens` was a guaranteed 400 that the
    // old exact-string match made depend on the spelling.
    expect(openAiUsesMaxCompletionTokens('o3-2025-04-16')).toBe(true);
  });

  it('is still false for a -latest pointer', () => {
    expect(openAiUsesMaxCompletionTokens('codex-mini-latest')).toBe(false);
  });

  it('keeps every set member its own normal form (a non-fixed-point entry is DEAD)', () => {
    // Same invariant as the anthropic module's, pinned per-set because this set
    // is maintained separately: lookups normalise first, so a member that is not
    // a fixed point is unreachable. It would fire if a dated snapshot
    // (`o3-2025-04-16`) were ever added to the set instead of its alias.
    for (const model of MODELS_REJECTING_SAMPLING_PARAMS) {
      expect(normalizeModelId(model)).toBe(model);
    }
  });
});

describe('unsupportedOpenAiParams — reasoningEffort (#752)', () => {
  const EFFORT = { hasTemperature: false, hasTopP: false, hasReasoningEffort: true };

  it('refuses reasoningEffort on o1-mini, the one reasoning model that takes none', () => {
    expect(unsupportedOpenAiParams('o1-mini', EFFORT)).toEqual([
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
  });

  it('is `unavailable`, NOT `removed` — the remedy points at a NEWER model', () => {
    // The direction is the OPPOSITE of temperature's on this same model, and
    // that is the whole reason the cause is typed. `o1-mini` predates the knob;
    // `o3-mini`/`o4-mini` accept it. `removed` would render "select a model that
    // still accepts reasoningEffort", pointing backwards at older models that
    // are even less likely to have it.
    const [param] = unsupportedOpenAiParams('o1-mini', EFFORT);
    expect(param?.cause).toBe('unavailable');
  });

  it('permits reasoningEffort on every OTHER reasoning model', () => {
    // The source restricts exactly one id. Refusing the rest would be the
    // manufactured refusal the module's FAIL DIRECTION rule forbids.
    for (const model of ['o1', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5.1']) {
      expect(unsupportedOpenAiParams(model, EFFORT)).toEqual([]);
    }
  });

  it('permits reasoningEffort on a NON-reasoning model (#752 problem 1 — a deliberate no-op)', () => {
    // The ticket's first defect is `reasoning_effort` reaching models that are
    // not reasoning models at all. The decision recorded in the module is to
    // send it: the source names no non-reasoning model that REJECTS the key,
    // and an absent fact must not become a local refusal.
    expect(unsupportedOpenAiParams('gpt-4o', EFFORT)).toEqual([]);
  });

  it('says nothing when the author set no reasoningEffort', () => {
    expect(unsupportedOpenAiParams('o1-mini', NONE)).toEqual([]);
  });

  it('classifies a DATED o1-mini snapshot like the alias it is a snapshot of (#751)', () => {
    expect(unsupportedOpenAiParams('o1-mini-2024-09-12', EFFORT)).toEqual([
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
  });

  it('yields BOTH causes when o1-mini is asked for temperature AND reasoningEffort', () => {
    // Unlike the anthropic sibling — where the equivalent case is unreachable
    // and its test had to synthesise a model in both sets — `o1-mini` is
    // genuinely in both sets here, so an author setting both fields really does
    // get two remedies pointing in opposite directions. Pinned so the combined
    // message is a decision rather than a surprise.
    expect(
      unsupportedOpenAiParams('o1-mini', {
        hasTemperature: true,
        hasTopP: false,
        hasReasoningEffort: true,
      }),
    ).toEqual([
      { name: 'temperature', cause: 'removed' },
      { name: 'reasoningEffort', cause: 'unavailable' },
    ]);
  });

  it('keeps every set member its own normal form (a non-fixed-point entry is DEAD)', () => {
    // Same invariant as the sampling set's, pinned SEPARATELY because this set
    // is maintained separately: lookups normalise first, so a member that is not
    // a fixed point can never be reached.
    for (const model of MODELS_REJECTING_REASONING_EFFORT) {
      expect(normalizeModelId(model)).toBe(model);
    }
  });
});
