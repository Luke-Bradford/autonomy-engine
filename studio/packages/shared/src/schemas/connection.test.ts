import { describe, expect, it } from 'vitest';
import {
  ConnectionKindSchema,
  ConnectionPublicSchema,
  ConnectionSchema,
  NewConnectionSchema,
  SECRET_REQUIRING_CONNECTION_KINDS,
  connectionKindRequiresSecret,
} from './connection.js';

const validConnection = {
  id: 'conn_1',
  resourceId: 'res_conn1',
  ownerId: null,
  name: 'My Claude key',
  kind: 'anthropic_api',
  config: { model: 'claude-sonnet' },
  parameters: [],
  secretRef: 'secret_1',
  secretStatus: 'ready',
  enabled: true,
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
    const { id, resourceId, secretStatus, enabled, createdAt, updatedAt, ...insert } =
      validConnection;
    void id;
    void resourceId;
    void secretStatus;
    void enabled;
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

  // #3 G8a — readiness is server-derived, never client-writable.
  it('strips a client-supplied secretStatus / enabled (server-set)', () => {
    const { id, resourceId, createdAt, updatedAt, ...insert } = validConnection;
    void id;
    void resourceId;
    void createdAt;
    void updatedAt;
    const parsed = NewConnectionSchema.parse({
      ...insert,
      secretStatus: 'not_required',
      enabled: false,
    });
    expect(parsed).not.toHaveProperty('secretStatus');
    expect(parsed).not.toHaveProperty('enabled');
  });
});

describe('ConnectionPublicSchema', () => {
  it('never carries secretRef', () => {
    const parsed = ConnectionPublicSchema.parse(validConnection);
    expect(parsed).not.toHaveProperty('secretRef');
  });

  // #3 G8a — readiness IS public (the UI shows it), unlike secretRef.
  it('carries secretStatus and enabled', () => {
    const parsed = ConnectionPublicSchema.parse(validConnection);
    expect(parsed.secretStatus).toBe('ready');
    expect(parsed.enabled).toBe(true);
  });
});

describe('secret-requiring kinds (G8a SSOT)', () => {
  it('requires a secret for the hosted-API LLM kinds only', () => {
    expect(connectionKindRequiresSecret('anthropic_api')).toBe(true);
    expect(connectionKindRequiresSecret('openai_api')).toBe(true);
  });

  it('does NOT require a connection secret for credential-less kinds', () => {
    expect(connectionKindRequiresSecret('ollama')).toBe(false);
    expect(connectionKindRequiresSecret('agent_cli')).toBe(false);
    expect(connectionKindRequiresSecret('http')).toBe(false);
    expect(connectionKindRequiresSecret('fs')).toBe(false);
  });

  it('the SSOT set matches the helper for every connection kind', () => {
    for (const kind of ConnectionKindSchema.options) {
      expect(SECRET_REQUIRING_CONNECTION_KINDS.has(kind)).toBe(connectionKindRequiresSecret(kind));
    }
  });
});

describe('ConnectionSchema readiness fields (G8a)', () => {
  it('rejects a missing secretStatus (no fail-open default — #473)', () => {
    const { secretStatus, ...rest } = validConnection;
    void secretStatus;
    expect(() => ConnectionSchema.parse(rest)).toThrow();
  });

  it('rejects a missing enabled (no fail-open default — #473)', () => {
    const { enabled, ...rest } = validConnection;
    void enabled;
    expect(() => ConnectionSchema.parse(rest)).toThrow();
  });

  it('rejects an unknown secretStatus value', () => {
    expect(() => ConnectionSchema.parse({ ...validConnection, secretStatus: 'pending' })).toThrow();
  });
});
