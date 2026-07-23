import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, SCHEMA_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createSecret,
  createTrigger,
} from '../../repo/index.js';
import { NotFoundError } from '../../errors.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { exportConnection, exportPipeline, exportTrigger } from '../export.js';

describe('exportPipeline', () => {
  it('exports the pipeline + all of its versions, with every node connectionId nulled', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'My pipeline' });
    const versionInput: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [{ name: 'topic', type: 'string', required: true }],
      outputs: [{ name: 'summary', type: 'string' }],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { model: 'x' },
          connectionId: connection.id,
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    createPipelineVersion(db, versionInput);
    createPipelineVersion(db, { ...versionInput, nodes: [] }); // a second version

    const envelope = exportPipeline(db, pipeline.id, 'local');

    expect(envelope.schemaVersion).toBe(SCHEMA_VERSION);
    expect(envelope.catalogVersion).toBe(CATALOG_VERSION);
    expect(envelope.kind).toBe('pipeline');
    expect(typeof envelope.exportedAt).toBe('number');
    if (envelope.kind !== 'pipeline') throw new Error('unreachable');
    expect(envelope.data.pipeline.id).toBe(pipeline.id);
    expect(envelope.data.versions).toHaveLength(2);
    expect(envelope.data.versions[0]!.nodes[0]!.connectionId).toBeNull();
    expect(envelope.data.strippedConnectionRefs).toEqual(['n1']);
    expect(JSON.stringify(envelope)).not.toContain(connection.id);
  });

  it('strippedConnectionRefs lists only the nodes that actually had a connectionId', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Mixed' });
    const versionInput: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'bound',
          type: 'llm_call',
          config: {},
          connectionId: connection.id,
          position: { x: 0, y: 0 },
        },
        {
          id: 'unbound',
          type: 'llm_call',
          config: {},
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    createPipelineVersion(db, versionInput);

    const envelope = exportPipeline(db, pipeline.id, 'local');
    if (envelope.kind !== 'pipeline') throw new Error('unreachable');

    expect(envelope.data.strippedConnectionRefs).toEqual(['bound']);
    for (const node of envelope.data.versions[0]!.nodes) {
      expect(node.connectionId).toBeNull();
    }
  });

  it('#2 L13a — PRESERVES a ${} (dynamic) connectionId and does NOT flag it for rebind', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Dynamic route' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'provider', type: 'string', required: true }],
      outputs: [],
      nodes: [
        // A dynamic (portable) route — references a param, not a concrete row.
        {
          id: 'dynamic',
          type: 'llm_call',
          config: {},
          connectionId: '${params.provider}',
          position: { x: 0, y: 0 },
        },
        // A literal, env-specific id — still stripped + flagged for rebind.
        {
          id: 'literal',
          type: 'llm_call',
          config: {},
          connectionId: connection.id,
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'local');
    if (envelope.kind !== 'pipeline') throw new Error('unreachable');
    const nodes = envelope.data.versions[0]!.nodes;
    const dyn = nodes.find((n) => n.id === 'dynamic')!;
    const lit = nodes.find((n) => n.id === 'literal')!;

    // The expression survives verbatim; the concrete id is nulled.
    expect(dyn.connectionId).toBe('${params.provider}');
    expect(lit.connectionId).toBeNull();
    // Only the literal node needs a rebind on import; the dynamic one does not.
    expect(envelope.data.strippedConnectionRefs).toEqual(['literal']);
    // The concrete id never leaks; the expression is not a concrete id.
    expect(JSON.stringify(envelope)).not.toContain(connection.id);
  });

  it('#2 L13b — strips connectionParams alongside a LITERAL connectionId, keeps them on a dynamic one', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      parameters: ['model'],
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Param routes' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [
        { name: 'provider', type: 'string', required: true },
        { name: 'model', type: 'string', required: true },
      ],
      outputs: [],
      nodes: [
        {
          id: 'dynamic',
          type: 'llm_call',
          config: {},
          connectionId: '${params.provider}',
          connectionParams: { model: '${params.model}' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'literal',
          type: 'llm_call',
          config: {},
          connectionId: connection.id,
          connectionParams: { model: 'claude-sonnet' },
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'local');
    if (envelope.kind !== 'pipeline') throw new Error('unreachable');
    const nodes = envelope.data.versions[0]!.nodes;
    const dyn = nodes.find((n) => n.id === 'dynamic')!;
    const lit = nodes.find((n) => n.id === 'literal')!;

    // Dynamic route: portable — both the expression AND its bindings survive.
    expect(dyn.connectionId).toBe('${params.provider}');
    expect(dyn.connectionParams).toEqual({ model: '${params.model}' });
    // Literal route: the id is nulled, so the bindings would be silently-inert
    // config on import (validateDoc refuses connectionParams without a
    // connectionId) — stripped WITH it; the node is already flagged for rebind.
    expect(lit.connectionId).toBeNull();
    expect(lit.connectionParams).toBeUndefined();
    expect(envelope.data.strippedConnectionRefs).toEqual(['literal']);
  });

  it('strippedConnectionRefs is empty when no node has a connectionId', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'No connections' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        { id: 'a', type: 'llm_call', config: {}, position: { x: 0, y: 0 } },
        { id: 'b', type: 'llm_call', config: {}, position: { x: 1, y: 1 } },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'local');
    if (envelope.kind !== 'pipeline') throw new Error('unreachable');

    expect(envelope.data.strippedConnectionRefs).toEqual([]);
  });

  it('404s (NotFoundError) for a nonexistent pipeline', () => {
    const { db } = freshDb();
    expect(() => exportPipeline(db, 'pipe_missing', 'local')).toThrow(NotFoundError);
  });

  it('404s for a pipeline owned by a different owner', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'someone-else', name: 'Not mine' });
    expect(() => exportPipeline(db, pipeline.id, 'local')).toThrow(NotFoundError);
  });
});

describe('exportConnection', () => {
  it('never includes secretRef, and sets requiresSecret true when one existed', () => {
    const { db } = freshDb();
    const secret = createSecret(db, { ref: 'secref_1', ciphertext: 'not-the-plaintext-cipher' });
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'Keyed',
      kind: 'anthropic_api',
      config: {},
      secretRef: secret.ref,
    });

    const envelope = exportConnection(db, connection.id, 'local');
    if (envelope.kind !== 'connection') throw new Error('unreachable');
    expect(envelope.data).not.toHaveProperty('secretRef');
    expect(envelope.data.requiresSecret).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(secret.ref);
    expect(JSON.stringify(envelope)).not.toContain(secret.ciphertext);
  });

  it('sets requiresSecret false when the connection has no secret', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'No secret',
      kind: 'http',
      config: {},
      secretRef: null,
    });

    const envelope = exportConnection(db, connection.id, 'local');
    if (envelope.kind !== 'connection') throw new Error('unreachable');
    expect(envelope.data.requiresSecret).toBe(false);
  });

  it('404s for a nonexistent or not-owned connection', () => {
    const { db } = freshDb();
    expect(() => exportConnection(db, 'conn_missing', 'local')).toThrow(NotFoundError);
    const other = createConnection(db, {
      ownerId: 'someone-else',
      name: 'Not mine',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    expect(() => exportConnection(db, other.id, 'local')).toThrow(NotFoundError);
  });
});

describe('exportTrigger', () => {
  function setupPipelineVersion(db: ReturnType<typeof freshDb>['db']) {
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    return createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
  }

  it('nulls pipelineVersionId and strips webhook.secretRef', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    const trigger = createTrigger(db, {
      ownerId: 'local',
      name: 'Webhook trigger',
      pipelineVersionId: version.id,
      params: {},
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'super_secret_ref_value', idempotencyWindowSeconds: 60 },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const envelope = exportTrigger(db, trigger.id, 'local');
    if (envelope.kind !== 'trigger') throw new Error('unreachable');
    expect(envelope.data.pipelineVersionId).toBeNull();
    expect(envelope.data.webhook).toEqual({ idempotencyWindowSeconds: 60 });
    expect(JSON.stringify(envelope)).not.toContain('super_secret_ref_value');
    expect(JSON.stringify(envelope)).not.toContain(version.id);
  });

  it('404s for a nonexistent or not-owned trigger', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db);
    expect(() => exportTrigger(db, 'trig_missing', 'local')).toThrow(NotFoundError);
    const other = createTrigger(db, {
      ownerId: 'someone-else',
      name: 'Not mine',
      pipelineVersionId: version.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });
    expect(() => exportTrigger(db, other.id, 'local')).toThrow(NotFoundError);
  });
});
