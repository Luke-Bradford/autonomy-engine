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
  getPipeline,
  getPipelineVersion,
  listPipelineVersions,
  listPipelines,
} from '../../repo/index.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import {
  exportConnection,
  exportPipeline,
  exportPipelineBundle,
  exportTrigger,
} from '../export.js';
import { importBundle, importEnvelope } from '../import.js';
import { insertLegacyVersion } from '../../__tests__/legacy-version.js';

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
          config: { prompt: 'p', model: 'x' },
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

  it('#1380 — a folder survives export → import, and a top-level pipeline exports with no key', () => {
    const { db } = freshDb();
    const filed = createPipeline(db, { ownerId: 'owner-a', name: 'Filed', folder: 'Nightly' });
    const loose = createPipeline(db, { ownerId: 'owner-a', name: 'Loose' });

    const looseEnvelope = exportPipeline(db, loose.id, 'owner-a');
    expect(JSON.stringify(looseEnvelope)).not.toContain('folder');

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, filed.id, 'owner-a'));
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    // Re-read, not the create response (#473's shape: a dropped column echoes fine).
    expect(getPipeline(db, result.pipeline.id)?.folder).toBe('Nightly');

    const again = importEnvelope(db, 'owner-b', looseEnvelope);
    if (again.kind !== 'pipeline') throw new Error('unreachable');
    expect(getPipeline(db, again.pipeline.id)?.folder).toBeNull();
  });

  it('#2 L13a — a ${} (dynamic) connectionId survives export → import unchanged, no rebind', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Dynamic route' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'provider', type: 'string', required: true }],
      outputs: [],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: '${params.provider}',
          position: { x: 1, y: 2 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');

    // The portable routing expression round-trips verbatim — NOT nulled — so the
    // imported pipeline still routes; and no rebind is owed for it.
    expect(result.versions[0]!.nodes[0]!.connectionId).toBe('${params.provider}');
    expect(result.attention).toEqual([]);
  });

  it('M1 (#1104) — a connectionIds pair round-trips: all-dynamic survives, a stripped end drops the pair WHOLE', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Paired' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'provider', type: 'string', required: true }],
      outputs: [],
      nodes: [
        {
          id: 'dynamic',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionIds: { source: '${params.provider}', sink: '${params.provider}' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'mixed',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionIds: { source: '${params.provider}', sink: connection.id },
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const nodes = result.versions[0]!.nodes;

    // Wholly portable — the pair survives intact.
    expect(nodes.find((n) => n.id === 'dynamic')!.connectionIds).toEqual({
      source: '${params.provider}',
      sink: '${params.provider}',
    });
    // One end was env-specific and nulled. `NodeSchema.connectionIds` requires
    // BOTH ends, so the pair drops WHOLE and the node is flagged for a rebind —
    // a half pair would be unsavable, and inventing the missing end is the
    // fail-open an absent fact must never become.
    expect(nodes.find((n) => n.id === 'mixed')!.connectionIds).toBeUndefined();
    expect(
      result.attention.filter((a) => a.type === 'unresolvedConnectionRef').map((a) => a.nodeId),
    ).toContain('mixed');
  });

  // #1144 — `datasetParams` rides WITH the dataset pair: bindings for a pair
  // the import dropped are refused by the write gate, and would roll the whole
  // import back if they survived on their own.
  it('#1144 — datasetParams survive with a portable pair and drop with a stripped one', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Params' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'target', type: 'string', required: true }],
      outputs: [],
      nodes: [
        {
          id: 'dynamic',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: '${params.target}', sink: '${params.target}' },
          datasetParams: { source: { path: 'in.csv' } },
          position: { x: 0, y: 0 },
        },
        {
          id: 'stripped',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: '${params.target}', sink: 'ds_local_id' },
          datasetParams: { sink: { path: 'out.csv' } },
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const byId = (id: string) => result.versions[0]!.nodes.find((n) => n.id === id)!;
    expect(byId('dynamic').datasetParams).toEqual({ source: { path: 'in.csv' } });
    expect(byId('stripped').datasetIds).toBeUndefined();
    expect(byId('stripped').datasetParams).toBeUndefined();
  });

  // M3 (#1117) — driven through the REAL `exportPipeline` rather than a
  // hand-built envelope, so a stubbed-out export arm cannot let this pass.
  it('M3 (#1117) — a datasetIds pair round-trips: all-dynamic survives, a stripped end drops the pair WHOLE', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Copies' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'target', type: 'string', required: true }],
      outputs: [],
      nodes: [
        {
          id: 'dynamic',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: '${params.target}', sink: '${params.target}' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'mixed',
          type: 'llm_call',
          config: { prompt: 'p' },
          // Also carries a connection PAIR, so this pins that the two fields
          // survive independently rather than one masking the other.
          connectionIds: { source: '${params.target}', sink: '${params.target}' },
          datasetIds: { source: '${params.target}', sink: 'ds_local_id' },
          position: { x: 1, y: 1 },
        },
        { id: 'plain', type: 'llm_call', config: { prompt: 'p' }, position: { x: 2, y: 2 } },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const nodes = result.versions[0]!.nodes;
    const byId = (id: string) => nodes.find((n) => n.id === id)!;

    // Wholly portable — the pair survives intact.
    expect(byId('dynamic').datasetIds).toEqual({
      source: '${params.target}',
      sink: '${params.target}',
    });
    // One end was a local primary key and was nulled, so the pair drops WHOLE —
    // a half pair is unsavable and inventing the missing end is the fail-open an
    // absent fact must never become. Its connection pair is untouched.
    expect(byId('mixed').datasetIds).toBeUndefined();
    expect(byId('mixed').connectionIds).toEqual({
      source: '${params.target}',
      sink: '${params.target}',
    });
    // A node that bound no datasets gains no key on the way back in.
    expect(byId('plain').datasetIds).toBeUndefined();

    // Reported for repair — and ONLY for the node that lost one, never for the
    // portable pair or the node that never had one.
    expect(
      result.attention.filter((a) => a.type === 'unresolvedDatasetRef').map((a) => a.nodeId),
    ).toEqual(['mixed']);
  });

  // M12 slice 1 (#1220) — the source-only binding, and the distinction the whole
  // slice turns on. NULL means "a sink was bound and export stripped it" (drops
  // whole, reported); ABSENT means "no sink was ever bound" (survives, silent).
  // Collapsing them loses a source-only node's dataset binding on every
  // round-trip while reporting a repair it cannot express.
  it('M12 (#1220) — a SOURCE-ONLY pair survives the round-trip, and is not reported', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Lookups' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [{ name: 'target', type: 'string', required: true }],
      outputs: [],
      nodes: [
        {
          id: 'dynamic_source',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: '${params.target}' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'stripped_source',
          type: 'llm_call',
          config: { prompt: 'p' },
          // A source-only node whose ONE end is a local primary key. There is no
          // portable half left, so it drops and IS reported — a source-only pair
          // is not a licence to keep an unresolvable source.
          datasetIds: { source: 'ds_local_id' },
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const byId = (id: string) => result.versions[0]!.nodes.find((n) => n.id === id)!;

    const survived = byId('dynamic_source').datasetIds;
    expect(survived).toEqual({ source: '${params.target}' });
    // ABSENT, not `sink: null` and not `sink: undefined`. `toEqual` cannot see
    // the difference, and `sink: null` is exactly what the importer's drop-whole
    // rule keys on — so assert the key is gone.
    expect('sink' in survived!).toBe(false);

    expect(byId('stripped_source').datasetIds).toBeUndefined();
    expect(
      result.attention.filter((a) => a.type === 'unresolvedDatasetRef').map((a) => a.nodeId),
    ).toEqual(['stripped_source']);
  });

  // An export carries EVERY immutable version, and a node id is stable across
  // them — so a binding that was never re-authored appears identically in each.
  // Reported once per version, the operator reads the same repair instruction
  // three times for one node (`ImportPanel` renders `attention` verbatim).
  it('M3 (#1117) — reports ONE unresolvedDatasetRef for a node whose pair survives several versions', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Copies' });
    const nodes = [
      {
        id: 'n1',
        type: 'llm_call',
        config: { prompt: 'p' },
        datasetIds: { source: 'ds_local_id', sink: '${params.target}' },
        position: { x: 0, y: 0 },
      },
    ];
    const version: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [{ name: 'target', type: 'string', required: true }],
      outputs: [],
      nodes,
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
    // Three immutable versions, the node's stripped-literal pair unchanged
    // across all of them.
    createPipelineVersion(db, version);
    createPipelineVersion(db, version);
    createPipelineVersion(db, version);
    expect(listPipelineVersions(db, pipeline.id)).toHaveLength(3);

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));
    if (result.kind !== 'pipeline') throw new Error('unreachable');

    expect(
      result.attention.filter((a) => a.type === 'unresolvedDatasetRef').map((a) => a.nodeId),
    ).toEqual(['n1']);
  });

  it('#2 L13b — a literal-bound node with connectionParams round-trips WITHOUT bricking the import', () => {
    // The write gate refuses connectionParams without a connectionId, and export
    // nulls a literal connectionId — so export must have stripped the bindings
    // too, or this import would roll back the whole pipeline.
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'C',
      kind: 'http',
      config: {},
      parameters: ['model'],
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Bound' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [
        { name: 'provider', type: 'string', required: true },
        { name: 'model', type: 'string', required: true },
      ],
      outputs: [],
      nodes: [
        {
          id: 'lit',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: connection.id,
          connectionParams: { model: 'claude-sonnet' },
          position: { x: 0, y: 0 },
        },
        {
          id: 'dyn',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: '${params.provider}',
          connectionParams: { model: '${params.model}' },
          position: { x: 1, y: 1 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');

    const nodes = result.versions[0]!.nodes;
    const lit = nodes.find((n) => n.id === 'lit')!;
    const dyn = nodes.find((n) => n.id === 'dyn')!;
    // Literal route: id AND bindings gone; the rebind attention item covers both.
    expect(lit.connectionId).toBeUndefined();
    expect(lit.connectionParams).toBeUndefined();
    // Dynamic route: expression + bindings survive verbatim.
    expect(dyn.connectionId).toBe('${params.provider}');
    expect(dyn.connectionParams).toEqual({ model: '${params.model}' });
    expect(result.attention).toEqual([{ type: 'unresolvedConnectionRef', nodeId: 'lit' }]);
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
      nodes: [{ id: 'n1', type: 'llm_call', config: { prompt: 'p' }, position: { x: 0, y: 0 } }],
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

  // #844 V1 — variables survive export → import (the re-read, not the response),
  // and a re-export carries the same declaration. A variable-less export has no
  // key at all (spec V-D2).
  it('round-trip: variables survive export → import → export (#844 V1)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Stateful' });
    const variables = [
      { name: 'count', type: 'number' as const, default: 0 },
      { name: 'seen', type: 'array' as const, default: ['a'], description: 'visited' },
    ];
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      variables,
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const imported = getPipelineVersion(db, result.versions[0]!.id);
    expect(imported?.variables).toEqual(variables);

    const again = exportPipeline(db, result.pipeline.id, 'owner-b');
    if (again.kind !== 'pipeline' || envelope.kind !== 'pipeline') throw new Error('unreachable');
    expect(again.data.versions[0]!.variables).toEqual(envelope.data.versions[0]!.variables);
  });

  it('a pipeline with no variables exports with no `variables` key (#844 V1)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Plain' });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    if (envelope.kind !== 'pipeline') throw new Error('unreachable');
    expect(Object.keys(envelope.data.versions[0]!)).not.toContain('variables');
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
        { id: 'n1', type: 'llm_call', config: { prompt: 'p' }, position: { x: 0, y: 0 } },
        {
          id: 'n2',
          type: 'llm_call',
          config: { prompt: 'p', outputs: [{ name: 'done', type: 'boolean' }] },
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

  it('round-trip: a structured agent_task outputSchema + derived outputs survive export → import (#2 L11b)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Structured agent' });
    const outputSchema = {
      type: 'object',
      properties: { verdict: { type: 'string' }, confidence: { type: 'number' } },
    };
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'rev',
          type: 'agent_task',
          config: { task: 'review the diff', outputSchema },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });

    const envelope = exportPipeline(db, pipeline.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');

    // The source `outputSchema` survives AND the derived contract is re-lowered
    // idempotently on import (import re-runs `createPipelineVersion`, which
    // re-derives `config.outputs` via `lowerAgentTaskStructuredOutputs`).
    const imported = getPipelineVersion(db, result.versions[0]!.id)!.nodes.find(
      (n) => n.id === 'rev',
    )!;
    expect(imported.config['outputSchema']).toEqual(outputSchema);
    expect(imported.config['outputs']).toEqual([
      { name: 'verdict', type: 'string' },
      { name: 'confidence', type: 'number' },
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
          config: { prompt: 'p', model: 'x', outputs: [{ name: 'text', type: 'string' }] },
          position: { x: 3, y: 4 },
        },
        {
          id: 'n3',
          type: 'agent_task',
          config: { task: 't', outputs: [{ name: 'output', type: 'string' }] },
          position: { x: 5, y: 6 },
        },
        {
          id: 'n2',
          type: 'llm_call',
          config: { prompt: 'p', outputs: [{ name: 'done', type: 'boolean' }] },
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
      // #844 V1 — non-empty for the same reason: a dropped column reads back `[]`.
      variables: [{ name: 'tally', type: 'number', default: 3, description: 'kept' }],
      // #1 F8a — non-empty for the same reason: dropped columns read back `''` / `[]`.
      description: 'Loads the nightly batch',
      annotations: ['prod', 'finance'],
      // NOT CATALOG_VERSION — import is an "upgrade path can still set an older
      // value" (see `NewPipelineVersionSchema`), so a preserved older value is
      // the meaningful assertion; a re-stamped one would silently equal the default.
      catalogVersion: CATALOG_VERSION - 1,
    };

    // CLASS assertion: the fixture must populate every field the import is meant
    // to preserve. A field added to `PipelineVersionSchema` with no fixture
    // value fails HERE, forcing this test to be extended, not silently skipped.
    // `resourceId` (#3 G1) is deliberately NOT preserved by PORTABLE import —
    // portable semantics mint a fresh identity (that IS the copy contract; the
    // workspace-git import #3 G4/G5 is the mode that preserves it). The #3 G6b
    // git-provenance fields are LOCAL derived state, stripped on export
    // (`PipelineVersionExportSchema`) and never round-tripped — so they are not
    // preserved by any import path.
    const NOT_PRESERVED = [
      'id',
      'resourceId',
      'version',
      'createdAt',
      'pipelineId',
      'sourceCommit',
      'sourceBranch',
      'sourceFilePath',
      'sourceBlobSha',
    ];
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
      nodes: [{ id: 'n1', type: 'llm_call', config: { prompt: 'p' }, position: { x: 0, y: 0 } }],
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
      nodes: [{ id: 'n1', type: 'llm_call', config: { prompt: 'p' }, position: { x: 0, y: 0 } }],
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
      nodes: [
        { id: 'n1', type: 'llm_call', config: { prompt: 'p' }, position: { x: 0, y: 0 }, policy },
      ],
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
          config: { prompt: 'p' },
          connectionId: connection.id,
          position: { x: 0, y: 0 },
        },
        { id: 'unbound', type: 'llm_call', config: { prompt: 'p' }, position: { x: 1, y: 1 } },
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
        { id: 'a', type: 'llm_call', config: { prompt: 'p' }, position: { x: 0, y: 0 } },
        { id: 'b', type: 'llm_call', config: { prompt: 'p' }, position: { x: 1, y: 1 } },
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

  it('#2 L13b — the parameters allowlist survives export → import (#473 anti-test)', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'Parameterized',
      kind: 'anthropic_api',
      config: { model: 'claude-sonnet' },
      parameters: ['model', 'maxTokens'],
      secretRef: null,
    });
    const envelope = exportConnection(db, connection.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'connection') throw new Error('unreachable');
    expect(result.connection.parameters).toEqual(['model', 'maxTokens']);
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

  // #5 S11b — window-field bindings are tumbling-only (the route's cross-field
  // assert). This path bypasses route asserts, so it must REFUSE the envelope
  // rather than create a row whose every subsequent PATCH — including the
  // mandatory rebind — 400s on the effective-state rule (the same
  // brick-avoidance reasoning that forces `event`/`window` null above; params
  // can't be surgically forced consistent, so refusal is the honest disposition).
  it('refuses an envelope carrying a run window the scheduler could never open (#1090)', () => {
    // A legacy workspace can hold one — `RunWindowSchema` (the READ shape, and
    // so the export shape) is deliberately lenient, so such a trigger exports
    // cleanly. Import is a WRITE, and must refuse rather than launder it into
    // the target, where it would sit enabled and never fire.
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Windowed',
      pipelineVersionId: version.id,
      params: {},
      mode: 'schedule',
      schedule: '0 * * * *',
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: [{ start: '09:00', end: '17:00' }],
      enabled: false,
    });
    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    // Hand-edited to a bound `parseRunWindowTime` cannot read — the shape the
    // JSON textarea that #1090 replaces made easy to author.
    (envelope.data as { runWindows: unknown }).runWindows = [{ start: '9am', end: '5pm' }];

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow();
  });

  it('refuses a NON-tumbling envelope whose params bind ${trigger.windowStart/End}', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Windowed',
      pipelineVersionId: version.id,
      params: { ws: '${trigger.windowStart}' },
      mode: 'tumbling',
      schedule: null,
      webhook: null,
      window: { frequency: 'minute', interval: 15, startTime: '2026-07-01T00:00:00.000Z' },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: false,
    });
    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    // Hand-craft a mode-inconsistent envelope (the only source of this state —
    // no legal write path produces it).
    const data = envelope.data as { mode: string; window: unknown };
    data.mode = 'manual';
    data.window = null;

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(ImportError);
    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(/tumbling/);
  });

  it('imports a TUMBLING envelope with window-field bindings intact', () => {
    const { db } = freshDb();
    const version = setupPipelineVersion(db, 'owner-a');
    const trigger = createTrigger(db, {
      ownerId: 'owner-a',
      name: 'Windowed',
      pipelineVersionId: version.id,
      params: { ws: '${trigger.windowStart}', we: '${trigger.windowEnd}' },
      mode: 'tumbling',
      schedule: null,
      webhook: null,
      window: { frequency: 'minute', interval: 15, startTime: '2026-07-01T00:00:00.000Z' },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: false,
    });
    const envelope = exportTrigger(db, trigger.id, 'owner-a');
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'trigger') throw new Error('unreachable');
    expect(result.trigger.params).toEqual({
      ws: '${trigger.windowStart}',
      we: '${trigger.windowEnd}',
    });
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

// #3 G1 — PORTABLE import mints a FRESH resourceId, never adopting the
// exported one: portable semantics are a COPY (new identity), exactly like
// `id`. The workspace-git import (#3 G4/G5) is the mode that preserves it.
describe('#3 G1 — portable import mints fresh resourceIds', () => {
  it('imported pipeline + versions get resourceIds distinct from the exported ones', () => {
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
    const result = importEnvelope(db, 'owner-b', envelope);
    if (result.kind !== 'pipeline') throw new Error('unreachable');

    const imported = listPipelines(db, 'owner-b').find((p) => p.id === result.pipeline.id);
    expect(imported).toBeDefined();
    expect(imported!.resourceId).toBeTruthy();
    expect(imported!.resourceId).not.toBe(pipeline.resourceId);

    const importedVersions = listPipelineVersions(db, result.pipeline.id);
    const exportedVersionResourceIds = listPipelineVersions(db, pipeline.id).map(
      (v) => v.resourceId,
    );
    expect(importedVersions).toHaveLength(1);
    expect(importedVersions[0]!.resourceId).toBeTruthy();
    expect(exportedVersionResourceIds).not.toContain(importedVersions[0]!.resourceId);
  });

  it('a v3 (pre-G1, resourceId-less) envelope imports cleanly and still mints identity', () => {
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

    // Rebuild the envelope as a pre-G1 v3 export: no resourceId anywhere.
    const raw = JSON.parse(JSON.stringify(exportPipeline(db, pipeline.id, 'owner-a'))) as {
      schemaVersion: number;
      data: {
        pipeline: Record<string, unknown>;
        versions: Array<Record<string, unknown>>;
      };
    };
    raw.schemaVersion = 3;
    delete raw.data.pipeline.resourceId;
    for (const version of raw.data.versions) delete version.resourceId;

    const result = importEnvelope(db, 'owner-b', raw);
    if (result.kind !== 'pipeline') throw new Error('unreachable');
    const imported = listPipelines(db, 'owner-b').find((p) => p.id === result.pipeline.id);
    expect(imported!.resourceId).toBeTruthy();
    expect(listPipelineVersions(db, result.pipeline.id)[0]!.resourceId).toBeTruthy();
  });
});

describe('#1586 importBundle', () => {
  /** A pipeline whose one version binds a connection, so its import reports
   * an `unresolvedConnectionRef` — the per-member attention under test. */
  function seed(db: ReturnType<typeof freshDb>['db'], name: string, bound: boolean) {
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: `${name} conn`,
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name });
    createPipelineVersion(db, {
      pipelineId: pipeline.id,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          ...(bound ? { connectionId: connection.id } : {}),
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    });
    return pipeline;
  }

  it('imports every member, in order, each with its own attention items', () => {
    const { db } = freshDb();
    const a = seed(db, 'Alpha', true);
    const b = seed(db, 'Beta', false);
    const bundle = exportPipelineBundle(db, [b.id, a.id, b.id], 'owner-a');
    // De-duplicated, first occurrence kept.
    expect(bundle.items).toHaveLength(2);

    const result = importBundle(db, 'owner-b', JSON.parse(JSON.stringify(bundle)));

    expect(result.kind).toBe('bundle');
    const items = result.items.map((r) =>
      r.kind === 'pipeline' ? { name: r.pipeline.name, attention: r.attention } : r.kind,
    );
    expect(items).toEqual([
      { name: 'Beta', attention: [] },
      { name: 'Alpha', attention: [{ type: 'unresolvedConnectionRef', nodeId: 'n1' }] },
    ]);
    expect(
      listPipelines(db, 'owner-b')
        .map((p) => p.name)
        .sort(),
    ).toEqual(['Alpha', 'Beta']);
  });

  it('a member refused mid-way rolls back the members already written, and is named', () => {
    const { db } = freshDb();
    const a = seed(db, 'Alpha', false);
    const b = seed(db, 'Beta', false);
    const bundle = JSON.parse(JSON.stringify(exportPipelineBundle(db, [a.id, b.id], 'owner-a')));
    // The SECOND member breaks a doc rule (a forward cycle) the parse cannot
    // see, so the first member is really written before it is refused.
    const version = bundle.items[1].data.versions[0];
    const node = version.nodes[0];
    version.nodes = [
      { ...node, id: 'x' },
      { ...node, id: 'y' },
    ];
    version.edges = [
      { id: 'e1', from: 'x', to: 'y', on: 'success' },
      { id: 'e2', from: 'y', to: 'x', on: 'success' },
    ];

    expect(() => importBundle(db, 'owner-b', bundle)).toThrow(InvalidPipelineDocError);
    expect(() => importBundle(db, 'owner-b', bundle)).toThrow(/^Item 2 \(pipeline “Beta”\): /);
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  it('a write-schema refusal is an ImportError naming the member', () => {
    const { db } = freshDb();
    const a = seed(db, 'Alpha', false);
    const bundle = JSON.parse(JSON.stringify(exportPipelineBundle(db, [a.id, a.id], 'owner-a')));
    bundle.items.push(JSON.parse(JSON.stringify(bundle.items[0])));
    // Passes the envelope's lenient folder, refused by the pipeline write schema.
    bundle.items[1].data.pipeline.folder = '/';
    expect(() => importBundle(db, 'owner-b', bundle)).toThrow(ImportError);
    expect(() => importBundle(db, 'owner-b', bundle)).toThrow(/^Item 2 \(pipeline “Alpha”\): /);
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  it('clips a long pipeline name in the label — a name has no length cap', () => {
    const { db } = freshDb();
    const a = seed(db, 'A'.repeat(500), false);
    const bundle = JSON.parse(JSON.stringify(exportPipelineBundle(db, [a.id], 'owner-a')));
    bundle.items[0].data.pipeline.folder = '/';
    expect(() => importBundle(db, 'owner-b', bundle)).toThrow(
      new RegExp(`^Item 1 \\(pipeline “A{59}…”\\): `),
    );
  });

  it('carries pipelines only — any other member refuses the file before a write', () => {
    const { db } = freshDb();
    const a = seed(db, 'Alpha', false);
    const connection = createConnection(db, {
      ownerId: 'owner-a',
      name: 'Other',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const bundle = JSON.parse(JSON.stringify(exportPipelineBundle(db, [a.id], 'owner-a')));
    bundle.items.push(exportConnection(db, connection.id, 'owner-a'));
    expect(() => importBundle(db, 'owner-b', bundle)).toThrow(
      /^Item 2: a bundle carries pipelines only, and this is a connection export/,
    );
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  it('refuses a chosen store', () => {
    const { db } = freshDb();
    const a = seed(db, 'Alpha', false);
    const bundle = exportPipelineBundle(db, [a.id], 'owner-a');
    expect(() =>
      importBundle(db, 'owner-b', bundle, {
        resolveStore: () => {
          throw new Error('never resolved');
        },
      }),
    ).toThrow(/only a dataset lives in a store/);
  });

  it('exportPipelineBundle 404s an id the owner does not hold', () => {
    const { db } = freshDb();
    const a = seed(db, 'Alpha', false);
    expect(() => exportPipelineBundle(db, [a.id], 'owner-b')).toThrow(/not found/i);
  });
});

// #1492 — an exported HISTORY can hold a version saved before #1480 whose
// activity config the save gate now refuses. Versions are immutable, so it can
// never be repaired; refusing it refused the whole pipeline. It is admitted and
// reported, while the head and every structural rule still refuse.
describe('importEnvelope: history saved before #1480 (#1492)', () => {
  const copyNode = (mode: string) => ({
    id: 'load',
    type: 'copy',
    config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }], mode },
    position: { x: 0, y: 0 },
  });
  const doc = (pipelineId: string, mode: string): NewPipelineVersion => ({
    pipelineId,
    params: [],
    outputs: [],
    nodes: [copyNode(mode)],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  });

  it('admits an unrunnable HISTORICAL version, stored as it was, and reports it', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Copier' });
    insertLegacyVersion(db, doc(pipeline.id, 'truncate'));
    createPipelineVersion(db, doc(pipeline.id, 'append'));

    const result = importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'));

    if (result.kind !== 'pipeline') throw new Error('expected a pipeline import');
    expect(result.attention).toEqual([
      {
        type: 'unrunnableVersion',
        version: 1,
        issues: [expect.stringMatching(/^node 'load': config\.mode: /)],
        totalIssues: 1,
      },
    ]);
    expect(result.versions.map((v) => [v.version, v.nodes[0]?.config.mode])).toEqual([
      [1, 'truncate'],
      [2, 'append'],
    ]);
    expect(listPipelineVersions(db, result.pipeline.id)).toHaveLength(2);
  });

  it('still refuses an unrunnable HEAD, and stores nothing', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Copier' });
    createPipelineVersion(db, doc(pipeline.id, 'append'));
    insertLegacyVersion(db, doc(pipeline.id, 'truncate'));

    expect(() => importEnvelope(db, 'owner-b', exportPipeline(db, pipeline.id, 'owner-a'))).toThrow(
      InvalidPipelineDocError,
    );
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  it('the head is the LAST version in the file, not the highest number', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Copier' });
    insertLegacyVersion(db, doc(pipeline.id, 'truncate'));
    createPipelineVersion(db, doc(pipeline.id, 'append'));
    const envelope = JSON.parse(JSON.stringify(exportPipeline(db, pipeline.id, 'owner-a')));
    // Hand-reordered: the unrunnable v1 is now last, so it would become the head.
    envelope.data.versions.reverse();

    expect(() => importEnvelope(db, 'owner-b', envelope)).toThrow(InvalidPipelineDocError);
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  it('still refuses a historical version with a STRUCTURAL fault beside the activity one', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'owner-a', name: 'Copier' });
    insertLegacyVersion(db, doc(pipeline.id, 'truncate'));
    createPipelineVersion(db, doc(pipeline.id, 'append'));
    const envelope = JSON.parse(JSON.stringify(exportPipeline(db, pipeline.id, 'owner-a')));
    const exportedNode = envelope.data.versions[0].nodes[0];
    envelope.data.versions[0].nodes = [
      { ...exportedNode, id: 'a' },
      { ...exportedNode, id: 'b' },
    ];
    envelope.data.versions[0].edges = [
      { id: 'e1', from: 'a', to: 'b', on: 'success' },
      { id: 'e2', from: 'b', to: 'a', on: 'success' },
    ];

    let thrown: unknown;
    try {
      importEnvelope(db, 'owner-b', envelope);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidPipelineDocError);
    const issues = (thrown as InvalidPipelineDocError).issues;
    // The FIRST, complete diagnostics: the activity fault AND the structural one.
    expect(issues.some((i) => /config\.mode/.test(i))).toBe(true);
    expect(issues.some((i) => !/config\.mode/.test(i))).toBe(true);
    expect(listPipelines(db, 'owner-b')).toEqual([]);
  });

  it('a bundle reports the unrunnable history on its own member only', () => {
    const { db } = freshDb();
    const old = createPipeline(db, { ownerId: 'owner-a', name: 'Old' });
    insertLegacyVersion(db, doc(old.id, 'truncate'));
    createPipelineVersion(db, doc(old.id, 'append'));
    const fresh = createPipeline(db, { ownerId: 'owner-a', name: 'Fresh' });
    createPipelineVersion(db, doc(fresh.id, 'append'));

    const result = importBundle(
      db,
      'owner-b',
      JSON.parse(JSON.stringify(exportPipelineBundle(db, [old.id, fresh.id], 'owner-a'))),
    );

    expect(
      result.items.map((r) =>
        r.kind === 'pipeline' ? [r.pipeline.name, r.attention.map((a) => a.type)] : r.kind,
      ),
    ).toEqual([
      ['Old', ['unrunnableVersion']],
      ['Fresh', []],
    ]);
  });
});
