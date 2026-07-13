import { describe, expect, it } from 'vitest';
import { NewSecretSchema, SecretSchema } from './secret.js';

const secret = {
  id: 'sec_1',
  ref: 'anthropic-key-1',
  ciphertext: 'base64:opaque-blob',
  createdAt: 1700000000000,
};

describe('SecretSchema', () => {
  it('round-trips a valid secret', () => {
    expect(SecretSchema.parse(secret)).toEqual(secret);
  });

  it('rejects an empty ref', () => {
    expect(() => SecretSchema.parse({ ...secret, ref: '' })).toThrow();
  });

  it('rejects an empty ciphertext', () => {
    expect(() => SecretSchema.parse({ ...secret, ciphertext: '' })).toThrow();
  });
});

describe('NewSecretSchema', () => {
  it('accepts a payload without server-set fields', () => {
    const { id, createdAt, ...insert } = secret;
    void id;
    void createdAt;
    expect(NewSecretSchema.parse(insert)).toEqual(insert);
  });
});
