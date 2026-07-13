import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, ImportError, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createSecret,
  createTrigger,
  getPipelineVersion,
} from '../../repo/index.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { exportConnection, exportPipeline, exportTrigger } from '../export.js';
import { importEnvelope } from '../import.js';

describe('importEnvelope: pipeline', () => {
  it('round-trip: new ids, importer ownerId, same structural content, unresolved connectionRef reported', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Original' });
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
          position: { x: 1, y: 2 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    createPipelineVersion(db, versionInput);

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);

    expect(result.kind).toBe('pipeline');
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    expect(result.pipeline.id).not.toBe(pipeline.id);
    expect(result.pipeline.ownerId).toBe('owner-b');
    expect(result.pipeline.name).toBe('Original');
    expect(result.versions).toHaveLength(1);
    const importedVersion = result.versions[0]!;
    expect(importedVersion.pipelineId).toBe(result.pipeline.id);
    expect(importedVersion.params).toEqual(versionInput.params);
    expect(importedVersion.outputs).toEqual(versionInput.outputs);
    expect(importedVersion.nodes).toHaveLength(1);
    expect(importedVersion.nodes[0]!.connectionId).toBeUndefined();
    expect(importedVersion.nodes[0]!.id).toBe('n1');

    expect(result.attention).toEqual([{ type: 'unresolvedConnectionRef', nodeId: 'n1' }]);

    // Actually persisted via the real repo — not just an in-memory echo.
    expect(getPipelineVersion(db, importedVersion.id)).toEqual(importedVersion);
  });

  it('reports unresolvedConnectionRef only for nodes that originally had a connectionId, not connection-less nodes', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Mixed' });
    createPipelineVersion(db, {
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
        { id: 'unbound', type: 'llm_call', config: {}, position: { x: 1, y: 1 } },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);

    expect(result.kind).toBe('pipeline');
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    expect(result.attention).toEqual([{ type: 'unresolvedConnectionRef', nodeId: 'bound' }]);
    expect(result.attention).toHaveLength(1);
  });

  it('no unresolvedConnectionRef attention items when no node had a connectionId', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'No connections' });
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

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);

    expect(result.kind).toBe('pipeline');
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    expect(result.attention.filter((a) => a.type === 'unresolvedConnectionRef')).toEqual([]);
  });

  it('accepts a raw JSON string body (not just a parsed object)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'P' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const envelope = exportPipeline(db, pipeline.id, 'owner-a');

    const result = importEnvelope(db, 'owner-b', JSON.stringify(envelope));
    expect(result.kind).toBe('pipeline');
  });
});

describe('importEnvelope: connection', () => {
  it('round-trip: new id, importer ownerId, never imports a secret, requiresSecret reported', () => {
    const { db } = freshDb();
    const secret = createSecret(db, { ref: 'secref_1', ciphertext: 'ciphertext-blob' });
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'Keyed',
      kind: 'anthropic_api',
      config: { model: 'x' },
      secretRef: secret.ref,
    });

    const envelope = exportConnection(db, connection.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);

    expect(result.kind).toBe('connection');
    if (result.kind !== 'connection') throw new Error('unreachable');
    expect(result.connection.id).not.toBe(connection.id);
    expect(result.connection.ownerId).toBe('owner-b');
    expect(result.connection.name).toBe('Keyed');
    expect(result.connection.config).toEqual({ model: 'x' });
    expect(result.connection).not.toHaveProperty('secretRef');
    expect(JSON.stringify(result)).not.toContain(secret.ref);
    expect(JSON.stringify(result)).not.toContain(secret.ciphertext);
    expect(result.attention).toEqual([{ type: 'requiresSecret' }]);
  });

  it('no attention item when the original connection had no secret', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'No secret',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const envelope = exportConnection(db, connection.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    expect(result.attention).toEqual([]);
  });
});

describe('importEnvelope: trigger', () => {
  function setupPipelineVersion(db: ReturnType<typeof freshDb>['db'], ownerId: string) {
    const pipeline = createPipeline(db, { ownerId, name: 'P' });
    return createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
  }

  it('round-trip: new id, importer ownerId, pipelineVersionId stays null, unboundPipelineVersion + requiresWebhookSecret reported', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Nightly webhook',
      pipelineVersionId: version.id,
      params: { topic: 'news' },
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'secref_should_never_leak', idempotencyWindowSeconds: 30 },
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: true,
    });

    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);

    expect(result.kind).toBe('trigger');
    if (result.kind !== 'trigger') throw new Error('unreachable');
    expect(result.trigger.id).not.toBe(trigger.id);
    expect(result.trigger.ownerId).toBe('owner-b');
    expect(result.trigger.name).toBe('Nightly webhook');
    expect(result.trigger.params).toEqual({ topic: 'news' });
    expect(result.trigger.pipelineVersionId).toBeNull();
    expect(result.trigger.webhook).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secref_should_never_leak');
    expect(result.attention).toEqual(
      expect.arrayContaining([
        { type: 'unboundPipelineVersion' },
        { type: 'requiresWebhookSecret' },
      ]),
    );
    expect(result.attention).toHaveLength(2);
  });

  it('forces enabled: false on import, even when the envelope had enabled: true (unbound trigger must arrive inert)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Was enabled',
      pipelineVersionId: version.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    expect((envelope.data as { enabled: boolean }).enabled).toBe(true);

    const result = importEnvelope(db, 'owner-b', envelope);
    expect(result.kind).toBe('trigger');
    if (result.kind !== 'trigger') throw new Error('unreachable');
    expect(result.trigger.enabled).toBe(false);
    expect(result.trigger.pipelineVersionId).toBeNull();
  });

  it('a manual (non-webhook) trigger only reports unboundPipelineVersion', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Manual',
      pipelineVersionId: version.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    expect(result.attention).toEqual([{ type: 'unboundPipelineVersion' }]);
  });
});

describe('importEnvelope: refusals', () => {
  it('throws ImportError for a junk body', () => {
    const { db } = freshDb();
    expect(() => importEnvelope(db, 'owner-a', { not: 'an envelope' })).toThrow(ImportError);
  });

  it('throws ImportError for an unsupported kind', () => {
    const { db } = freshDb();
    expect(() =>
      importEnvelope(db, 'owner-a', {
        schemaVersion: 1,
        catalogVersion: 1,
        kind: 'not_a_real_kind',
        exportedAt: 1,
        data: {},
      }),
    ).toThrow(ImportError);
  });
});
