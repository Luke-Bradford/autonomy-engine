import { describe, expect, it } from 'vitest';
import { HelloSchema } from './index.js';

describe('HelloSchema', () => {
  it('round-trips a valid Hello value', () => {
    const input = { message: 'hi', ts: 1700000000000 };
    const parsed = HelloSchema.parse(input);
    expect(parsed).toEqual(input);
  });

  it('rejects a value with the wrong shape', () => {
    expect(() => HelloSchema.parse({ message: 'hi' })).toThrow();
  });
});
