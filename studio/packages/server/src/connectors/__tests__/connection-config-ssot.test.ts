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
/**
 * #1119 M4 — the kinds whose adapter DELIBERATELY refines the shared schema
 * server-side, and therefore cannot assert object identity against it.
 *
 * Named as an exception set, and DERIVED from rather than duplicating the kind
 * list, because the hand-written `it.each([...5 kinds])` this replaces had
 * already gone stale: it excluded `fs` for this reason and would silently have
 * given `sqlite` — the second divergent kind — no assertion at all, which is the
 * opposite of what an exclusion is for. Both divergences are the same one:
 * `node:path`'s `isAbsolute` is platform-aware and cannot live in a
 * browser-safe package, so the adapter refines the shared `roots`.
 */
const DIVERGENT_KINDS: ReadonlySet<ConnectionKind> = new Set<ConnectionKind>(['fs', 'sqlite']);

const supervisor = {} as Supervisor;

describe('connection config is one declaration, server and shared', () => {
  const registry = createConnectorRegistry({ supervisor });

  it('has an adapter for every kind', () => {
    expect([...registry.keys()].sort()).toEqual(Object.keys(CONNECTION_CONFIG_SCHEMAS).sort());
  });


  const identicalKinds = (Object.keys(CONNECTION_CONFIG_SCHEMAS) as ConnectionKind[]).filter(
    (kind) => !DIVERGENT_KINDS.has(kind),
  );

  it.each(identicalKinds)('%s parses the SAME schema object the form renders', (kind) => {
    expect(registry.get(kind)?.configSchema).toBe(connectionConfigSchema(kind));
  });

  it('accounts for every kind — identical or a NAMED divergence', () => {
    // The exclusion set cannot quietly grow: a kind that is neither asserted
    // identical nor listed as divergent fails here.
    expect([...identicalKinds, ...DIVERGENT_KINDS].sort()).toEqual(
      Object.keys(CONNECTION_CONFIG_SCHEMAS).sort(),
    );
  });

  it('fs adds the absolute-root check, and nothing else', () => {
    const schema = registry.get('fs')!.configSchema;

    // The one deliberate divergence: `node:path`'s `isAbsolute` is platform-
    // aware and cannot live in a browser-safe package, so the adapter refines
    // the SHARED `roots` rather than re-declaring the object.
    expect(schema.safeParse({ roots: ['relative/path'] }).success).toBe(false);
    expect(connectionConfigSchema('fs').safeParse({ roots: ['relative/path'] }).success).toBe(true);

    // And it still names WHICH root is wrong, as the per-element refine it
    // replaced did — with several roots, `roots` alone would be useless.
    const mixed = schema.safeParse({ roots: ['/ok', 'relative/path', '/also-ok'] });
    expect(mixed.success).toBe(false);
    expect(mixed.error?.issues[0]?.path).toEqual(['roots', 1]);

    // Everything else still comes from shared, including the messages.
    expect(schema.safeParse({ roots: ['/tmp'], maxBytes: 1024 }).success).toBe(true);
    const empty = schema.safeParse({ roots: [] });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe(
      'an fs connection needs at least one allowed root',
    );
  });
});
