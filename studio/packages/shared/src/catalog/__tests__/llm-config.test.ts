import { describe, expect, it } from 'vitest';
import { getActivity } from '../registry.js';
import { llmCallConfigSchema, normalizeLlmRequest } from '../llm-config.js';

describe('llmCallConfigSchema', () => {
  it('accepts the v1 `prompt` shorthand', () => {
    expect(llmCallConfigSchema.safeParse({ prompt: 'hi' }).success).toBe(true);
  });

  it('accepts the v2 role-tagged `messages[]`', () => {
    const r = llmCallConfigSchema.safeParse({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts the full v2 sampling surface', () => {
    const r = llmCallConfigSchema.safeParse({
      prompt: 'hi',
      system: 's',
      model: 'm',
      maxTokens: 10,
      temperature: 0.2,
      topP: 0.9,
      stop: ['\n\n'],
      seed: 7,
    });
    expect(r.success).toBe(true);
  });

  // HIGH constraint: `ctx.input` is the whole substituted node.config, which
  // carries the seeded `outputs` contract key (+ future L3/L4a/L10 fields). The
  // schema MUST be non-strict or every real dispatch fails on an extra key.
  it('is non-strict — an unknown key like the `outputs` contract passes', () => {
    const r = llmCallConfigSchema.safeParse({
      prompt: 'hi',
      outputs: [{ key: 'text', type: 'string' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects both `prompt` and `messages` (ambiguous)', () => {
    const r = llmCallConfigSchema.safeParse({
      prompt: 'hi',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects neither `prompt` nor `messages`', () => {
    expect(llmCallConfigSchema.safeParse({ system: 's' }).success).toBe(false);
  });

  it('rejects an empty `messages` array', () => {
    expect(llmCallConfigSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it('rejects `messages` with no non-system turn', () => {
    const r = llmCallConfigSchema.safeParse({
      messages: [{ role: 'system', content: 'only system' }],
    });
    expect(r.success).toBe(false);
  });

  // SSOT: the catalog entry and the adapter validation are ONE schema object.
  it('IS the llm_call catalog configSchema (single source of truth)', () => {
    expect(getActivity('llm_call')!.configSchema).toBe(llmCallConfigSchema);
  });
});

describe('normalizeLlmRequest', () => {
  it('lowers the v1 `prompt` to a single user message', () => {
    const n = normalizeLlmRequest({ prompt: 'hi' });
    expect(n.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(n.system).toBeUndefined();
  });

  it('folds the top-level `system` shorthand and preserves user turns', () => {
    const n = normalizeLlmRequest({
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(n.system).toBe('be terse');
    expect(n.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('folds a NON-LEADING system message to the top-level system, keeping non-system order', () => {
    const n = normalizeLlmRequest({
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: 'a1' },
      ],
    });
    expect(n.system).toBe('mid');
    expect(n.messages).toEqual([
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]);
  });

  it('joins the top-level system and any system messages with a blank line', () => {
    const n = normalizeLlmRequest({
      system: 'top',
      messages: [
        { role: 'system', content: 'inline' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(n.system).toBe('top\n\ninline');
  });

  it('drops an inert empty-string system (behavior noted in the schema doc)', () => {
    const n = normalizeLlmRequest({ prompt: 'hi', system: '' });
    expect(n.system).toBeUndefined();
  });

  it('passes sampling through, yielding undefined (never null/0) for absent knobs', () => {
    const bare = normalizeLlmRequest({ prompt: 'hi' });
    expect(bare.sampling).toEqual({
      temperature: undefined,
      maxTokens: undefined,
      topP: undefined,
      stop: undefined,
      seed: undefined,
    });
    const full = normalizeLlmRequest({
      prompt: 'hi',
      temperature: 0.2,
      maxTokens: 10,
      topP: 0.9,
      stop: ['x'],
      seed: 7,
    });
    expect(full.sampling).toEqual({
      temperature: 0.2,
      maxTokens: 10,
      topP: 0.9,
      stop: ['x'],
      seed: 7,
    });
  });
});
