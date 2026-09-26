/**
 * #890 — `captureDispatchInput`: the bounded, JSON-text record of the config a
 * node was dispatched with, as `node.dispatched.input` stores it.
 */
import { describe, expect, it } from 'vitest';
import { DISPATCH_INPUT_MAX_CHARS, captureDispatchInput } from '../dispatch-input.js';

describe('#890 captureDispatchInput', () => {
  it('stores compact JSON and its full length, with no truncated flag', () => {
    expect(captureDispatchInput({ url: 'https://x', n: 2 })).toEqual({
      text: '{"url":"https://x","n":2}',
      chars: 25,
    });
  });

  it('keeps an input of exactly the cap whole', () => {
    const value = { s: 'a'.repeat(DISPATCH_INPUT_MAX_CHARS - 8) };
    const text = JSON.stringify(value);
    expect(text.length).toBe(DISPATCH_INPUT_MAX_CHARS);
    expect(captureDispatchInput(value)).toEqual({ text, chars: DISPATCH_INPUT_MAX_CHARS });
  });

  it('cuts a longer input at the cap, flags it, and reports the whole length', () => {
    const value = { s: 'a'.repeat(DISPATCH_INPUT_MAX_CHARS) };
    const text = JSON.stringify(value);
    expect(captureDispatchInput(value)).toEqual({
      text: text.slice(0, DISPATCH_INPUT_MAX_CHARS),
      chars: text.length,
      truncated: true,
    });
  });

  it('never splits a surrogate pair at the cut', () => {
    // `{"s":"` is 6 units, so the emoji's HIGH half lands on the last kept unit.
    const value = { s: 'a'.repeat(DISPATCH_INPUT_MAX_CHARS - 7) + '😀' + 'tail' };
    const got = captureDispatchInput(value);
    expect(got?.truncated).toBe(true);
    expect(got?.text.length).toBe(DISPATCH_INPUT_MAX_CHARS - 1);
    expect(got?.text.endsWith('a')).toBe(true);
  });

  it('records nothing for a value JSON cannot represent, rather than inventing one', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(captureDispatchInput(cyclic)).toBeUndefined();
    expect(captureDispatchInput({ big: 1n })).toBeUndefined();
  });

  it('leaves out the `outputs` result contract, which is not an input', () => {
    expect(
      captureDispatchInput({ path: '/d', outputs: [{ name: 'entries', type: 'json' }] }),
    ).toEqual({ text: '{"path":"/d"}', chars: 13 });
  });
});
