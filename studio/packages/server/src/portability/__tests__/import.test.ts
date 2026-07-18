import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  ImportError,
  PipelineVersionSchema,
  type NewPipelineVersion,
  type PipelineVersion,
} from '@autonomy-studio/shared';
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

  it('round-trip: a structured llm_call outputSchema + derived outputs survive export → import (#2 L4a)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Structured' });
    const outputSchema = {
      type: 'object',
      properties: { category: { type: 'string' }, score: { type: 'number' } },
    };
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'clf',
          type: 'llm_call',
          config: { prompt: 'classify', outputMode: 'structured', outputSchema },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');

    // Re-read the IMPORTED (immutable) row: the source `outputSchema` survives
    // (so L4b recovers optionality) AND the derived contract is re-lowered
    // idempotently on import — import re-runs `createPipelineVersion`, which
    // re-derives `config.outputs` from the round-tripped `outputSchema`.
    const imported = getPipelineVersion(db, result.versions[0]!.id)!.nodes.find(
      (n) => n.id === 'clf',
    )!;
    expect(imported.config['outputSchema']).toEqual(outputSchema);
    expect(imported.config['outputs']).toEqual([
      { name: 'category', type: 'string' },
      { name: 'score', type: 'number' },
    ]);
  });

  // #485 — the #473 import test above pins ONE field (`containers`).
  // `importPipelineEnvelope` builds its `NewPipelineVersion` by hand, and every
  // `.default()` field is optional in `z.input`, so a future field could be
  // dropped there exactly as `containers` was, unseen until someone writes a
  // field-specific round-trip. This generalizes the guard to the whole domain
  // shape: author EVERY preserved field with a value that DIFFERS from its
  // default, assert the fixture covers every preserved key (a new schema field
  // fails HERE), then assert the RE-READ deep-equals it. `id`/`version`/
  // `createdAt` are server-reassigned, `pipelineId` is re-pointed at the new
  // pipeline, and node `connectionId` is nulled on export by design — those are
  // not "preserved" and are excluded.
  it('round-trip: EVERY domain field survives export → import — a class guard (#485)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'FullShape' });

    const authored: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [{ name: 'topic', type: 'string', required: true }],
      outputs: [{ name: 'summary', type: 'string' }],
      // Each known-type node declares an EXPLICIT `config.outputs` so F13b
      // lowering (#456) is a no-op — this test guards the export→import
      // round-trip (loss point 1/2), not the catalog-default seeding, so an
      // author override keeps the round-trip exact and the two concerns apart.
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { model: 'x', outputs: [{ name: 'text', type: 'string' }] },
          position: { x: 3, y: 4 },
        },
        {
          id: 'n3',
          type: 'agent_task',
          config: { outputs: [{ name: 'output', type: 'string' }] },
          position: { x: 5, y: 6 },
        },
        {
          id: 'n2',
          type: 'llm_call',
          config: { outputs: [{ name: 'done', type: 'boolean' }] },
          position: { x: 7, y: 8 },
        },
      ],
      // A top-level edge (no endpoint is a container child) so the doc is valid.
      edges: [{ id: 'e1', from: 'n1', to: 'n3', on: 'success' }],
      containers: [
        {
          id: 'c1',
          kind: 'loop',
          children: ['n2'],
          maxRounds: 5,
          exitWhen: '${nodes.n2.output.done}',
        },
      ],
      // NOT CATALOG_VERSION — import is an "upgrade path can still set an older
      // value" (see `NewPipelineVersionSchema`), so a preserved older value is
      // the meaningful assertion; a re-stamped one would silently equal the default.
      catalogVersion: CATALOG_VERSION - 1,
    };

    // CLASS assertion: the fixture must populate every field the import is meant
    // to preserve. A field added to `PipelineVersionSchema` with no fixture
    // value fails HERE, forcing this test to be extended, not silently skipped.
    const NOT_PRESERVED = ['id', 'version', 'createdAt', 'pipelineId'];
    const preserved = Object.keys(PipelineVersionSchema.shape).filter(
      (key) => !NOT_PRESERVED.includes(key),
    );
    expect(preserved.filter((key) => !(key in authored))).toEqual([]);

    createPipelineVersion(db, authored);
    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    expect(result.versions).toHaveLength(1);
    const importedVersion = result.versions[0]!;

    // RE-READ, never the import response (built from the in-memory input).
    const reread = getPipelineVersion(db, importedVersion.id);
    expect(reread).not.toBeNull();

    // `nodes` is compared by the generic branch below, not special-cased: this
    // fixture sets no node `connectionId` (that field IS export-nulled, and its
    // round-trip is covered by the dedicated tests above), so authored and
    // re-read node shapes are identical. Should a future author add a
    // `connectionId`-bearing node here, this generic `toEqual` would FAIL loudly
    // (export nulls it → import omits it) — forcing them to handle it, rather
    // than a silent no-op branch hiding the divergence.
    for (const key of preserved) {
      expect(reread![key as keyof PipelineVersion]).toEqual(
        authored[key as keyof NewPipelineVersion],
      );
    }
  });

  // #458 — a git-authored envelope carrying duplicate pipeline-level param
  // names is refused on import, not silently stored last-wins. The export schema
  // derives from the READ-tolerant `PipelineVersionSchema`, so the duplicate
  // survives `parseAndUpgradeEnvelope` and is caught by the write-strict
  // `NewPipelineVersionSchema` inside `createPipelineVersion` — and the atomic
  // import (#459) means no orphan pipeline is left behind.
  it('refuses an imported envelope with duplicate pipeline-level param names (#458)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'DupParams' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'topic', type: 'string', required: true }],
      outputs: [],
      nodes: [{ id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = JSON.parse(JSON.stringify(exportPipeline(db, pipeline.id, 'owner-a')));
    envelope.data.versions[0].params = [
      { name: 'topic', type: 'string', required: true },
      { name: 'topic', type: 'number', required: false },
    ];

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(/duplicate param name/);
    // Atomic (#459): the refused import leaves no orphan for the importer.
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  // The outputs half of the same write gate — same funnel, pinned at the import
  // level too so neither field can regress silently.
  it('refuses an imported envelope with duplicate pipeline-level output names (#458)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'DupOutputs' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [{ name: 'summary', type: 'string' }],
      nodes: [{ id: 'n1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = JSON.parse(JSON.stringify(exportPipeline(db, pipeline.id, 'owner-a')));
    envelope.data.versions[0].outputs = [
      { name: 'summary', type: 'string' },
      { name: 'summary', type: 'number' },
    ];

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(/duplicate output name/);
    expect(listPipelines(db, 'owner-b')).toEqual([]);
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

  it('#5 S5b-1: round-trips a recurrence through export→import (recurrence + derived cron preserved)', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Weekly',
      pipelineVersionId: version.id,
      params: {},
      mode: 'schedule',
      schedule: null,
      recurrence: { frequency: 'week', schedule: { weekDays: [1, 5], hours: [8] } },
      webhook: null,
      concurrency: { policy: 'skip_if_running' },
      runWindows: null,
      enabled: true,
    });

    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'trigger') throw new Error('unreachable');

    // The recurrence survives the round-trip (the #473 SECOND loss point — a
    // builder that dropped the field would fail HERE, not at the schema⇔column
    // seam); the derived cron is re-derived on import via `createTrigger`.
    expect(result.trigger.recurrence).toEqual({
      frequency: 'week',
      interval: 1,
      schedule: { weekDays: [1, 5], hours: [8] },
    });
    expect(result.trigger.schedule).toBe('0 8 * * 1,5');
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
