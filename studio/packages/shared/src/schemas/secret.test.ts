import { describe, expect, it } from 'vitest';
import {
  MAX_SECRET_NAME_LEN,
  MAX_SECRET_VALUE_LEN,
  NewSecretSchema,
  SecretPublicSchema,
  SecretRotateBodySchema,
  SecretSchema,
  SecretWriteBodySchema,
} from './secret.js';

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

describe('SecretWriteBodySchema', () => {
  it('accepts a name + plaintext value', () => {
    const body = { name: 'stripe-key', secret: 'sk_live_123' };
    expect(SecretWriteBodySchema.parse(body)).toEqual(body);
  });

  it('is STRICT — a client cannot smuggle ownerId or ref past the boundary', () => {
    expect(() =>
      SecretWriteBodySchema.parse({ name: 'k', secret: 'v', ownerId: 'someone-else' }),
    ).toThrow();
    expect(() =>
      SecretWriteBodySchema.parse({ name: 'k', secret: 'v', ref: 'secref_1' }),
    ).toThrow();
  });

  it('rejects a blank or untrimmed name — the name is an exact-match lookup key', () => {
    expect(() => SecretWriteBodySchema.parse({ name: '   ', secret: 'v' })).toThrow();
    expect(() => SecretWriteBodySchema.parse({ name: 'key ', secret: 'v' })).toThrow();
    expect(() => SecretWriteBodySchema.parse({ name: ' key', secret: 'v' })).toThrow();
    expect(() => SecretWriteBodySchema.parse({ name: '', secret: 'v' })).toThrow();
  });

  it('rejects an empty value, and bounds both fields', () => {
    expect(() => SecretWriteBodySchema.parse({ name: 'k', secret: '' })).toThrow();
    expect(() =>
      SecretWriteBodySchema.parse({ name: 'a'.repeat(MAX_SECRET_NAME_LEN + 1), secret: 'v' }),
    ).toThrow();
    expect(() =>
      SecretWriteBodySchema.parse({ name: 'k', secret: 'v'.repeat(MAX_SECRET_VALUE_LEN + 1) }),
    ).toThrow();
  });

  it('accepts both fields exactly AT their bound (the cap is inclusive)', () => {
    expect(() =>
      SecretWriteBodySchema.parse({
        name: 'a'.repeat(MAX_SECRET_NAME_LEN),
        secret: 'v'.repeat(MAX_SECRET_VALUE_LEN),
      }),
    ).not.toThrow();
  });
});

describe('SecretRotateBodySchema', () => {
  it('accepts a bare plaintext value', () => {
    expect(SecretRotateBodySchema.parse({ secret: 'sk_live_rotated' })).toEqual({
      secret: 'sk_live_rotated',
    });
  });

  /*
   * The load-bearing property of this schema, and the reason it is `.pick`ed
   * from a STRICT parent rather than declared fresh. `name` is the lookup key
   * every stored `{ "$secret": "<name>" }` marker resolves through, and a
   * pipeline version is immutable — so a rename would strand every marker
   * naming the old value with no way to repair the version. Rotation must
   * change the VALUE and nothing else, and the boundary is where that is
   * enforced: a client that sends `name` gets a loud 400, never a silent drop.
   */
  it('REFUSES a name — rotation may never rename the lookup key', () => {
    expect(() => SecretRotateBodySchema.parse({ secret: 'v', name: 'other' })).toThrow();
  });

  it('is STRICT about the machine-owned fields too', () => {
    expect(() => SecretRotateBodySchema.parse({ secret: 'v', ownerId: 'someone-else' })).toThrow();
    expect(() => SecretRotateBodySchema.parse({ secret: 'v', ref: 'secref_1' })).toThrow();
  });

  it('requires the value, and inherits POST’s bound rather than forking it', () => {
    expect(() => SecretRotateBodySchema.parse({})).toThrow();
    expect(() => SecretRotateBodySchema.parse({ secret: '' })).toThrow();
    expect(() =>
      SecretRotateBodySchema.parse({ secret: 'v'.repeat(MAX_SECRET_VALUE_LEN + 1) }),
    ).toThrow();
    expect(() =>
      SecretRotateBodySchema.parse({ secret: 'v'.repeat(MAX_SECRET_VALUE_LEN) }),
    ).not.toThrow();
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
