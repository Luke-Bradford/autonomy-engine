import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, ImportError, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  InvalidPipelineDocError,
  createConnection,
  createPipeline,
  createPipelineVersion,
  createSecret,
  createTrigger,
  getPipelineVersion,
  listPipelineVersions,
  listPipelines,
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

  // #444 + #459. The gate makes mid-import rejection a REAL class (before it,
  // only a Zod parse could reject), so the import's atomicity stops being
  // theoretical: without a transaction, a refused version leaves an orphan
  // pipeline + the versions that happened to land first.
  it('an INVALID version mid-envelope is refused and leaves NO orphan pipeline (#459)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'TwoVersions' });
    const validInput: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [{ id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    createPipelineVersion(db, validInput);
    createPipelineVersion(db, validInput);

    // Hand-edit the SECOND version into a forward cycle. This is the real
    // threat model, not a contrivance: an export is a git-authorable file, and
    // `parseAndUpgradeEnvelope` is deliberately permissive about graph rules so
    // a doc round-trips unchanged — so the doc rules are the importer's job.
    // Version 1 stays valid, which is exactly what makes a partial write
    // possible: it lands before version 2 is refused.
    const envelope = JSON.parse(JSON.stringify(exportPipeline(db, pipeline.id, 'owner-a')));
    // Derive the two nodes from the REAL exported node so they satisfy the
    // export schema (which requires an explicit `connectionId`) — the point of
    // this test is a doc-RULE refusal, not a Zod-shape one, and those are
    // different branches with different status codes.
    const exportedNode = envelope.data.versions[1].nodes[0];
    envelope.data.versions[1].nodes = [
      { ...exportedNode, id: 'a' },
      { ...exportedNode, id: 'b' },
    ];
    envelope.data.versions[1].edges = [
      { id: 'e1', from: 'a', to: 'b', on: 'success' },
      { id: 'e2', from: 'b', to: 'a', on: 'success' },
    ];

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(InvalidPipelineDocError);

    // The importer's OWN pipeline row must not survive the refusal — and
    // neither may version 1, which really was written before the throw.
    const orphans = listPipelines(db, 'owner-b');
    expect(orphans).toEqual([]);
    // owner-a's source pipeline is untouched: a refused import is not a delete.
    expect(listPipelines(db, 'owner-a')).toHaveLength(1);
    expect(listPipelineVersions(db, pipeline.id)).toHaveLength(2);
  });

  // #473 — the SECOND, independent loss point. Even with the `containers`
  // column fixed, `importPipelineEnvelope` rebuilt its `NewPipelineVersion`
  // field-by-field and simply never copied `containers`, so an imported
  // pipeline came back flat. `containers` is optional in `NewPipelineVersion`
  // (`z.input`, because of the write-side `.default([])`), so the omission
  // type-checked cleanly — nothing but this test can see it.
  it('round-trip: containers survive export → import (#473)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Containered' });
    const containers = [
      { id: 'c1', kind: 'stage' as const, children: ['n1'], join: 'all' as const },
      // `n2` + a child-output `exitWhen` are what make `c2` a VALID loop, now
      // that the write path enforces the doc rules (#444). The invalidity was
      // incidental to what this test proves (containers survive the round-trip)
      // and was only reachable because nothing validated.
      {
        id: 'c2',
        kind: 'loop' as const,
        children: ['n2'],
        maxRounds: 5,
        exitWhen: '${nodes.n2.output.done}',
      },
    ];
    const sourceVersion = createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        { id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } },
        {
          id: 'n2',
          type: 'llm_call',
          config: { outputs: [{ name: 'done', type: 'boolean' }] },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      containers,
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const importedVersion = result.versions[0]!;

    // Assert the RE-READ, not the import response: the response is built from
    // the in-memory input and so cannot witness a dropped write.
    expect(getPipelineVersion(db, importedVersion.id)?.containers).toEqual(containers);

    // The import spread (#473) means the exported `id` is now IN the object
    // handed to `createPipelineVersion`, where the old field-by-field rebuild
    // structurally excluded it. What keeps the module's "never reuses an
    // exported id" invariant true is that `NewPipelineVersionSchema` omits the
    // key and Zod strips it — a property no code NAMES, so it is pinned here
    // rather than assumed. (`createdAt` is not asserted: the server stamps
    // `Date.now()`, which can legitimately equal the source's in the same
    // millisecond.)
    expect(importedVersion.id).not.toBe(sourceVersion.id);
  });

  // #1 F2a. `policy` round-trips for free — `NodeExportSchema` derives from
  // `NodeSchema` and both `stripNodeConnectionId` and `toDbNode` spread the rest
  // of the node — so no code here NAMES it. This pins that: a refactor
  // re-declaring a node field-by-field would drop it silently, surfacing only
  // once F2b/F3 read it and a configured retry/timeout never fired.
  it('preserves a node policy across export -> import (#1 F2a)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Policied' });
    const policy = { timeoutSeconds: 300, retry: 2, retryIntervalSeconds: 60 };
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [{ id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 }, policy }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));

    expect(result.kind).toBe('pipeline');
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const importedVersion = result.versions[0]!;
    expect(importedVersion.nodes[0]!.policy).toEqual(policy);
    // Round-tripped through the real repo, not just the in-memory result.
    expect(getPipelineVersion(db, importedVersion.id)!.nodes[0]!.policy).toEqual(policy);
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
