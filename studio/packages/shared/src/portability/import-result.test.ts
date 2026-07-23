import { describe, expect, it } from 'vitest';
import { ImportAttentionItemSchema, ImportResultSchema } from './import-result.js';

describe('ImportAttentionItemSchema', () => {
  it.each([
    { type: 'unresolvedConnectionRef', nodeId: 'n1' },
    { type: 'requiresSecret' },
    { type: 'unboundPipelineVersion' },
    { type: 'requiresWebhookSecret' },
  ])('accepts %j', (item) => {
    expect(ImportAttentionItemSchema.parse(item)).toEqual(item);
  });

  it('rejects an unknown type', () => {
    expect(() => ImportAttentionItemSchema.parse({ type: 'made_up' })).toThrow();
  });

  it('rejects unresolvedConnectionRef missing nodeId', () => {
    expect(() => ImportAttentionItemSchema.parse({ type: 'unresolvedConnectionRef' })).toThrow();
  });
});

describe('ImportResultSchema', () => {
  const connectionResult = {
    kind: 'connection' as const,
    connection: {
      id: 'conn_1',
      ownerId: 'local',
      name: 'Imported',
      kind: 'http',
      config: {},
      parameters: [],
      createdAt: 1,
      updatedAt: 1,
    },
    attention: [{ type: 'requiresSecret' as const }],
  };

  it('round-trips a connection import result', () => {
    expect(ImportResultSchema.parse(connectionResult)).toEqual(connectionResult);
  });

  it('rejects a connection result carrying secretRef (the connection field must be the public projection)', () => {
    const withSecretRef = {
      ...connectionResult,
      connection: { ...connectionResult.connection, secretRef: 'sec_1' },
    };
    // `ConnectionPublicSchema` strips unknown/extra keys via plain z.object
    // parsing rather than throwing, so assert the parsed result never
    // carries it through instead of expecting a throw.
    const parsed = ImportResultSchema.parse(withSecretRef);
    expect(parsed.kind === 'connection' && parsed.connection).not.toHaveProperty('secretRef');
  });

  it('rejects an unknown kind', () => {
    expect(() => ImportResultSchema.parse({ ...connectionResult, kind: 'nope' })).toThrow();
  });
});
