import { describe, expect, it } from 'vitest';
import { ConnectionKindSchema } from '../schemas/connection.js';
import {
  CONNECTION_CONFIG_SCHEMAS,
  CONNECTION_KINDS,
  CONNECTION_SECRET_USE,
  agentConnectionConfigSchema,
  connectionConfigSchema,
  fsConnectionConfigSchema,
} from './connection-config.js';

describe('connection config catalog', () => {
  it('covers every kind, and nothing that is not a kind', () => {
    // The `Record<ConnectionKind, …>` type makes a MISSING kind a compile
    // error; this catches the other direction (a stale key left behind when a
    // kind is renamed or removed), which the type cannot.
    expect(Object.keys(CONNECTION_CONFIG_SCHEMAS).sort()).toEqual(
      [...ConnectionKindSchema.options].sort(),
    );
    expect(Object.keys(CONNECTION_SECRET_USE).sort()).toEqual(
      [...ConnectionKindSchema.options].sort(),
    );
    expect(CONNECTION_KINDS).toEqual(ConnectionKindSchema.options);
  });

  it('accepts a representative config for each kind', () => {
    const samples: Record<(typeof CONNECTION_KINDS)[number], Record<string, unknown>> = {
      anthropic_api: { model: 'claude-opus-5', anthropicVersion: '2023-06-01' },
      openai_api: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3' },
      agent_cli: { command: 'claude', args: ['-p'], timeoutMs: 60_000 },
      http: { baseUrl: 'https://example.test', headers: { accept: 'application/json' } },
      fs: { roots: ['/tmp/workspace'], maxBytes: 1024 },
    };
    for (const kind of CONNECTION_KINDS) {
      expect(connectionConfigSchema(kind).safeParse(samples[kind]).success).toBe(true);
    }
  });

  it('still refuses the shapes each adapter refuses', () => {
    expect(connectionConfigSchema('agent_cli').safeParse({}).success).toBe(false); // command
    expect(connectionConfigSchema('fs').safeParse({ roots: [] }).success).toBe(false); // min(1)
    expect(
      agentConnectionConfigSchema.safeParse({
        command: 'claude',
        quota: { exhaustionPattern: '([', resetWindowSeconds: 60 },
      }).success,
    ).toBe(false); // an un-compilable pattern is still refused at the boundary
  });

  it('leaves the ABSOLUTE-root check to the server, deliberately', () => {
    // `node:path`'s platform-aware `isAbsolute` cannot live in a browser-safe
    // package, so this schema owns the SHAPE and `connectors/fs.ts` refines it.
    // Asserted rather than left implicit: if someone later adds the check here,
    // the server's refine becomes dead code and this says where to look.
    expect(fsConnectionConfigSchema.safeParse({ roots: ['relative/path'] }).success).toBe(true);
  });
});
