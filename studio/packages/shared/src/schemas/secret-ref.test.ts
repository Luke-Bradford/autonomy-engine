import { describe, expect, it } from 'vitest';
import { SecretRefSchema, isSecretRef } from './secret-ref.js';

describe('SecretRefSchema', () => {
  it('parses a well-formed marker', () => {
    expect(SecretRefSchema.parse({ $secret: 'stripe-key' })).toEqual({ $secret: 'stripe-key' });
  });

  it('rejects an empty name', () => {
    expect(() => SecretRefSchema.parse({ $secret: '' })).toThrow();
  });

  it('rejects a non-string name', () => {
    expect(() => SecretRefSchema.parse({ $secret: 123 })).toThrow();
    expect(() => SecretRefSchema.parse({ $secret: { $secret: 'nested' } })).toThrow();
  });

  it('rejects an extra key (strict) — no smuggling ordinary config through a marker', () => {
    expect(() => SecretRefSchema.parse({ $secret: 'x', extra: 1 })).toThrow();
  });

  it('rejects a missing $secret key', () => {
    expect(() => SecretRefSchema.parse({})).toThrow();
  });
});

describe('isSecretRef — the loose detector', () => {
  it('is true for any object with an own $secret key (well-formed or not)', () => {
    expect(isSecretRef({ $secret: 'x' })).toBe(true);
    // A malformed marker must STILL be detected, so the gate can reject it
    // rather than let it slip through as plain config (fail-open).
    expect(isSecretRef({ $secret: 1 })).toBe(true);
    expect(isSecretRef({ $secret: 'x', extra: 1 })).toBe(true);
  });

  it('is false for non-marker values', () => {
    expect(isSecretRef(null)).toBe(false);
    expect(isSecretRef('string')).toBe(false);
    expect(isSecretRef(42)).toBe(false);
    expect(isSecretRef(['$secret'])).toBe(false);
    expect(isSecretRef({ url: 'https://x' })).toBe(false);
    expect(isSecretRef({})).toBe(false);
  });
});
