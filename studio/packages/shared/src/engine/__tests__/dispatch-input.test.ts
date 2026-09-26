/**
 * #890 — `captureDispatchInput`: the bounded, JSON-text record of the config a
 * node was dispatched with, as `node.dispatched.input` stores it.
 */
import { describe, expect, it } from 'vitest';
import {
  DISPATCH_INPUT_MAX_CHARS,
  captureDispatchInput,
  captureDispatchParams,
} from '../dispatch-input.js';

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

describe('#890 captureDispatchParams', () => {
  it('records the connection and dataset parameters under the doc field names', () => {
    const got = captureDispatchParams({
      connectionParams: { model: 'm-2' },
      datasetParams: { source: { path: 'in.csv' }, sink: { path: 'out.csv' } },
    });
    const text =
      '{"connectionParams":{"model":"m-2"},"datasetParams":{"source":{"path":"in.csv"},"sink":{"path":"out.csv"}}}';
    expect(got).toEqual({ text, chars: text.length });
  });

  it('omits an absent or empty part, and an end with no parameters', () => {
    expect(
      captureDispatchParams({ connectionParams: {}, datasetParams: { source: { path: 'a' } } }),
    ).toEqual({ text: '{"datasetParams":{"source":{"path":"a"}}}', chars: 41 });
    expect(
      captureDispatchParams({ datasetParams: { source: {}, sink: { path: 'b' } } })?.text,
    ).toBe('{"datasetParams":{"sink":{"path":"b"}}}');
  });

  it('is absent when nothing was bound: no invented empty record', () => {
    expect(captureDispatchParams({})).toBeUndefined();
    expect(captureDispatchParams({ connectionParams: {} })).toBeUndefined();
    expect(captureDispatchParams({ datasetParams: { source: {}, sink: {} } })).toBeUndefined();
  });

  it('is bounded like the input: cut at the cap, flagged, with the whole length', () => {
    const got = captureDispatchParams({ connectionParams: { s: 'a'.repeat(DISPATCH_INPUT_MAX_CHARS) } });
    expect(got?.text.length).toBe(DISPATCH_INPUT_MAX_CHARS);
    expect(got?.truncated).toBe(true);
    expect(got?.chars).toBe(DISPATCH_INPUT_MAX_CHARS + 29);
  });

  it('is absent when JSON cannot represent a value', () => {
    expect(captureDispatchParams({ connectionParams: { n: 1n } })).toBeUndefined();
  });
});
