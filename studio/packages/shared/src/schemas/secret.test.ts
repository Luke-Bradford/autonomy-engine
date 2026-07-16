import { describe, expect, it } from 'vitest';
import { NewSecretSchema, SecretPublicSchema, SecretSchema } from './secret.js';

const secret = {
  id: 'sec_1',
  ref: 'anthropic-key-1',
  ciphertext: 'base64:opaque-blob',
  ownerId: 'local',
  name: 'stripe-key',
  createdAt: 1700000000000,
};

describe('SecretSchema', () => {
  it('round-trips a valid standalone secret', () => {
    expect(SecretSchema.parse(secret)).toEqual(secret);
  });

  it('defaults ownerId/name to null when omitted (connection-owned provenance)', () => {
    const { ownerId, name, ...connectionOwned } = secret;
    void ownerId;
    void name;
    expect(SecretSchema.parse(connectionOwned)).toEqual({
      ...connectionOwned,
      ownerId: null,
      name: null,
    });
  });

  it('rejects an empty ref', () => {
    expect(() => SecretSchema.parse({ ...secret, ref: '' })).toThrow();
  });

  it('rejects an empty ciphertext', () => {
    expect(() => SecretSchema.parse({ ...secret, ciphertext: '' })).toThrow();
  });

  it('rejects an empty name (null is the only non-string it accepts)', () => {
    expect(() => SecretSchema.parse({ ...secret, name: '' })).toThrow();
  });
});

describe('NewSecretSchema', () => {
  it('accepts a connection-owned payload with only ref + ciphertext', () => {
    const insert = { ref: secret.ref, ciphertext: secret.ciphertext };
    expect(NewSecretSchema.parse(insert)).toEqual({ ...insert, ownerId: null, name: null });
  });

  it('accepts a standalone payload with owner + name', () => {
    const insert = {
      ref: secret.ref,
      ciphertext: secret.ciphertext,
      ownerId: 'local',
      name: 'stripe-key',
    };
    expect(NewSecretSchema.parse(insert)).toEqual(insert);
  });
});

describe('SecretPublicSchema', () => {
  it('strips ciphertext AND ref — the only client-facing projection', () => {
    const projected = SecretPublicSchema.parse(secret);
    expect(projected).toEqual({
      id: secret.id,
      ownerId: secret.ownerId,
      name: secret.name,
      createdAt: secret.createdAt,
    });
    expect(projected).not.toHaveProperty('ciphertext');
    expect(projected).not.toHaveProperty('ref');
  });
});
