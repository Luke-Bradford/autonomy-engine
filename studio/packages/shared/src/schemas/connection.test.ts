import { describe, expect, it } from 'vitest';
import {
  ConnectionKindSchema,
  ConnectionPublicSchema,
  ConnectionSchema,
  NewConnectionSchema,
} from './connection.js';

const validConnection = {
  id: 'conn_1',
  ownerId: null,
  name: 'My Claude key',
  kind: 'anthropic_api',
  config: { model: 'claude-sonnet' },
  parameters: [],
  secretRef: 'secret_1',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('ConnectionKindSchema', () => {
  it.each(['anthropic_api', 'openai_api', 'ollama', 'agent_cli', 'http', 'fs'])(
    'accepts %s',
    (kind) => {
      expect(ConnectionKindSchema.parse(kind)).toBe(kind);
    },
  );

  it('rejects an unknown kind', () => {
    expect(() => ConnectionKindSchema.parse('carrier_pigeon')).toThrow();
  });
});

describe('ConnectionSchema', () => {
  it('round-trips a valid connection', () => {
    expect(ConnectionSchema.parse(validConnection)).toEqual(validConnection);
  });

  it('accepts a non-null ownerId and a null secretRef', () => {
    const value = { ...validConnection, ownerId: 'user_1', secretRef: null };
    expect(ConnectionSchema.parse(value)).toEqual(value);
  });

  it('rejects a missing required field', () => {
    const { name, ...rest } = validConnection;
    void name;
    expect(() => ConnectionSchema.parse(rest)).toThrow();
  });

  it('rejects an invalid kind', () => {
    expect(() => ConnectionSchema.parse({ ...validConnection, kind: 'nope' })).toThrow();
  });

  it('rejects a non-record config', () => {
    expect(() => ConnectionSchema.parse({ ...validConnection, config: 'not-an-object' })).toThrow();
  });

  // #2 L13b — the per-dispatch override allowlist.
  it('accepts a declared parameters allowlist and round-trips it', () => {
    const value = { ...validConnection, parameters: ['model', 'baseUrl'] };
    expect(ConnectionSchema.parse(value)).toEqual(value);
  });

  it('defaults an absent parameters to [] (pre-L13b rows declare nothing — fail-closed)', () => {
    const { parameters, ...withoutParameters } = validConnection;
    void parameters;
    expect(ConnectionSchema.parse(withoutParameters).parameters).toEqual([]);
  });

  it('rejects an empty-string parameter name', () => {
    expect(() => ConnectionSchema.parse({ ...validConnection, parameters: [''] })).toThrow();
  });

  it('rejects a non-array parameters', () => {
    expect(() =>
      ConnectionSchema.parse({ ...validConnection, parameters: { model: true } }),
    ).toThrow();
  });
});

describe('NewConnectionSchema', () => {
  it('accepts a payload without server-set fields', () => {
    const { id, createdAt, updatedAt, ...insert } = validConnection;
    void id;
    void createdAt;
    void updatedAt;
    expect(NewConnectionSchema.parse(insert)).toEqual(insert);
  });

  it('rejects a payload that still carries an id', () => {
    // `id` is an unknown key on the insert schema's stricter shape check
    // (extra keys are stripped by default zod object parsing, but the
    // *type* correctly no longer requires/accepts it) — assert the parsed
    // result never carries it through.
    const { createdAt, updatedAt, ...withId } = validConnection;
    void createdAt;
    void updatedAt;
    const parsed = NewConnectionSchema.parse(withId);
    expect(parsed).not.toHaveProperty('id');
  });
});

describe('ConnectionPublicSchema', () => {
  it('never carries secretRef', () => {
    const parsed = ConnectionPublicSchema.parse(validConnection);
    expect(parsed).not.toHaveProperty('secretRef');
  });
});
