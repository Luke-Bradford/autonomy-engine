import { describe, expect, it } from 'vitest';
import { deepRedactSecrets, redactSecrets } from '../redact.js';

describe('redactSecrets — string substring scrub', () => {
  it('replaces every occurrence of each non-empty secret with ***', () => {
    expect(redactSecrets('token=abc and again abc', ['abc'])).toBe('token=*** and again ***');
  });

  it('skips null/undefined/empty secrets so a message is never turned wholly into ***', () => {
    expect(redactSecrets('keep me', [null, undefined, ''])).toBe('keep me');
  });
});

describe('deepRedactSecrets — structured value scrub (item 7 / S3)', () => {
  const SECRET = 'sk-super-secret';

  it('scrubs string leaves nested in objects and arrays, leaving the shape intact', () => {
    const value = {
      headers: { auth: `Bearer ${SECRET}`, other: 'safe' },
      list: ['x', SECRET, { deep: SECRET }],
    };
    expect(deepRedactSecrets(value, [SECRET])).toEqual({
      headers: { auth: 'Bearer ***', other: 'safe' },
      list: ['x', '***', { deep: '***' }],
    });
  });

  it('passes non-string leaves through untouched (only a string can carry a secret)', () => {
    const value = { status: 200, ok: true, body: null, nested: [1, false] };
    expect(deepRedactSecrets(value, [SECRET])).toEqual(value);
  });

  it('is a pure no-op when the plaintext list is empty (the common dispatch path)', () => {
    const value = { a: `contains ${SECRET}` };
    expect(deepRedactSecrets(value, [])).toEqual({ a: `contains ${SECRET}` });
  });

  it('redacts a top-level string value directly', () => {
    expect(deepRedactSecrets(SECRET, [SECRET])).toBe('***');
  });

  it('does not mutate the input value (rebuilds the tree)', () => {
    const value = { a: [SECRET] };
    const out = deepRedactSecrets(value, [SECRET]);
    expect(value).toEqual({ a: [SECRET] }); // original untouched
    expect(out).toEqual({ a: ['***'] });
  });
});
