import { describe, expect, it } from 'vitest';
import { CONNECTION_CONFIG_SCHEMAS, connectionConfigSchema } from '@autonomy-studio/shared';
import type { ConnectionKind } from '@autonomy-studio/shared';
import { createConnectorRegistry } from '../registry.js';
import type { Supervisor } from '../../workers/process-supervisor.js';

/**
 * #1087 — the drift guard for the shared→server connection-config move.
 *
 * The five per-kind schemas used to be module-private consts inside the
 * adapters, so the authoring UI could not see them and a second copy was the
 * only way to render a form. They now live in
 * `shared/catalog/connection-config.ts`, and what makes that a CONSOLIDATION
 * rather than a second copy is that each adapter's `configSchema` is the very
 * object the form derives its controls from — asserted here by IDENTITY, so a
 * re-declared local schema fails even if it happens to be equivalent today.
 */
const supervisor = {} as Supervisor;

describe('connection config is one declaration, server and shared', () => {
  const registry = createConnectorRegistry({ supervisor });

  it('has an adapter for every kind', () => {
    expect([...registry.keys()].sort()).toEqual(Object.keys(CONNECTION_CONFIG_SCHEMAS).sort());
  });

  it.each(['anthropic_api', 'openai_api', 'ollama', 'agent_cli', 'http'] as ConnectionKind[])(
    '%s parses the SAME schema object the form renders',
    (kind) => {
      expect(registry.get(kind)?.configSchema).toBe(connectionConfigSchema(kind));
    },
  );

  it('fs adds the absolute-root check, and nothing else', () => {
    const schema = registry.get('fs')!.configSchema;

    // The one deliberate divergence: `node:path`'s `isAbsolute` is platform-
    // aware and cannot live in a browser-safe package, so the adapter refines
    // the SHARED `roots` rather than re-declaring the object.
    expect(schema.safeParse({ roots: ['relative/path'] }).success).toBe(false);
    expect(connectionConfigSchema('fs').safeParse({ roots: ['relative/path'] }).success).toBe(true);

    // Everything else still comes from shared, including the messages.
    expect(schema.safeParse({ roots: ['/tmp'], maxBytes: 1024 }).success).toBe(true);
    const empty = schema.safeParse({ roots: [] });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe(
      'an fs connection needs at least one allowed root',
    );
  });
});
