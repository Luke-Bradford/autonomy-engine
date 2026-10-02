import { describe, expect, it, vi } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  archivePipeline,
  createConnection,
  createPipeline,
  createPipelineVersion,
  createSecret,
  createTrigger,
  deletePipeline,
} from '../../repo/index.js';
import { deleteConnection } from '../../repo/connections.js';
import { createDataset, deleteDataset } from '../../repo/datasets.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import {
  ownedVersionForms,
  serializeWorkspace,
  serializeWorkspaceTolerant,
  WorkspaceSerializeError,
} from '../workspace-serialize.js';
import { parseWorkspaceFiles } from '../workspace-parse.js';

/** Parse a serialized file's canonical JSON back to an envelope object (a test
 * peeks at nested envelope fields — the inferred `any` from `JSON.parse` is
 * intentional here). */
function envelopeAt(files: { path: string; contents: string }[], path: string) {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`no file at ${path} (have: ${files.map((f) => f.path).join(', ')})`);
  return JSON.parse(file.contents);
}

function baseVersion(pipelineId: string): NewPipelineVersion {
  return {
    pipelineId,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
}

describe('serializeWorkspace', () => {
  it('serializes ONLY the latest version of each pipeline (not the whole trail)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'My Pipeline' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      outputs: [{ name: 'old', type: 'string' }],
    });
    const latest = createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      outputs: [{ name: 'new', type: 'string' }],
    });

    const files = serializeWorkspace(db, 'local');
    const env = envelopeAt(files, 'pipelines/my-pipeline.json');
    expect(env.kind).toBe('pipeline');
    expect(env.data.versions).toHaveLength(1);
    expect(env.data.versions[0].resourceId).toBe(latest.resourceId);
    expect(env.data.versions[0].outputs[0].name).toBe('new');
  });

  it('remaps a literal node connectionId to the connection resourceId, preserving the binding', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'My Conn',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: connection.id,
          position: { x: 0, y: 0 },
        },
      ],
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/p.json');
    // The stored resourceId, NOT the DB id, and NOT null (portable export nulls it).
    expect(env.data.versions[0].nodes[0].connectionId).toBe(connection.resourceId);
    expect(JSON.stringify(env)).not.toContain(connection.id);
  });

  it('preserves a ${} dynamic connectionId verbatim (it routes on run values)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Dyn' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      params: [{ name: 'conn', type: 'string', required: true }],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: '${params.conn}',
          position: { x: 0, y: 0 },
        },
      ],
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/dyn.json');
    expect(env.data.versions[0].nodes[0].connectionId).toBe('${params.conn}');
  });

  it('M1 (#1104) — remaps BOTH ends of a connectionIds pair to resourceIds', () => {
    const { db } = freshDb();
    const source = createConnection(db, {
      ownerId: 'local',
      name: 'Src',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const sink = createConnection(db, {
      ownerId: 'local',
      name: 'Snk',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      params: [{ name: 'conn', type: 'string', required: true }],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionIds: { source: source.id, sink: sink.id },
          position: { x: 0, y: 0 },
        },
        {
          id: 'n2',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionIds: { source: '${params.conn}', sink: sink.id },
          position: { x: 1, y: 1 },
        },
      ],
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/p.json');
    expect(env.data.versions[0].nodes[0].connectionIds).toEqual({
      source: source.resourceId,
      sink: sink.resourceId,
    });
    // A dynamic end survives verbatim beside a remapped one.
    expect(env.data.versions[0].nodes[1].connectionIds).toEqual({
      source: '${params.conn}',
      sink: sink.resourceId,
    });
    // Neither DB id reaches the branch.
    expect(JSON.stringify(env)).not.toContain(source.id);
    expect(JSON.stringify(env)).not.toContain(sink.id);
  });

  it('M1 (#1104) — a dangling END refuses the serialize, and the message names WHICH end', () => {
    const { db } = freshDb();
    const source = createConnection(db, {
      ownerId: 'local',
      name: 'Src',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionIds: { source: source.id, sink: 'conn_does_not_exist' },
          position: { x: 0, y: 0 },
        },
      ],
    });

    // "node n1 references a connection that no longer exists" is not actionable
    // on a node that binds two of them.
    expect(() => serializeWorkspace(db, 'local')).toThrow(/sink connection/);
  });

  // M3 (#1117) — a dataset ref reaches the branch as a stable `resourceId` or it
  // does not reach it at all. Committing a LOCAL primary key into a shared repo
  // is the exact failure §3 exists to prevent, and it throws nothing.
  // M12 slice 1 (#1220) — the silent site. `remapRef` maps a NULLISH input to
  // `null` (`value == null`), so a source-only pair passed through it verbatim
  // would serialize `sink: null` — which the importer reads as "export stripped
  // a literal" and drops the whole pair on. The node would lose its binding on a
  // git round-trip and be reported as needing a repair that never applied. Only
  // an assertion on key ABSENCE can see this: `toEqual` treats a missing key and
  // an explicit `undefined` alike, and `null` is a different bug again.
  it('M12 (#1220) — a SOURCE-ONLY pair serializes with NO sink key, never a null one', () => {
    const { db } = freshDb();
    const store = createConnection(db, {
      ownerId: 'local',
      name: 'Store',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const src = createDataset(db, {
      ownerId: 'local',
      name: 'Src',
      connectionId: store.id,
      kind: 'table',
      config: {},
      columns: [],
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: src.id },
          position: { x: 0, y: 0 },
        },
      ],
    });

    const pair = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/p.json').data.versions[0]
      .nodes[0].datasetIds;
    expect(pair).toEqual({ source: src.resourceId });
    expect('sink' in pair!).toBe(false);
  });

  it('M3 (#1117) — remaps BOTH ends of a datasetIds pair to resourceIds', () => {
    const { db } = freshDb();
    const store = createConnection(db, {
      ownerId: 'local',
      name: 'Store',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const mkDataset = (name: string) =>
      createDataset(db, {
        ownerId: 'local',
        name,
        connectionId: store.id,
        kind: 'table',
        config: {},
        columns: [],
      });
    const src = mkDataset('Src');
    const snk = mkDataset('Snk');
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      params: [{ name: 'target', type: 'string', required: true }],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: src.id, sink: snk.id },
          position: { x: 0, y: 0 },
        },
        {
          id: 'n2',
          type: 'llm_call',
          config: { prompt: 'p' },
          // A dynamic end beside a remapped one, and a CONNECTION pair on the
          // same node — the two fields are remapped through different maps and
          // must not be able to resolve each other's ids.
          connectionIds: { source: store.id, sink: store.id },
          datasetIds: { source: '${params.target}', sink: snk.id },
          position: { x: 1, y: 1 },
        },
      ],
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/p.json');
    expect(env.data.versions[0].nodes[0].datasetIds).toEqual({
      source: src.resourceId,
      sink: snk.resourceId,
    });
    expect(env.data.versions[0].nodes[1].datasetIds).toEqual({
      source: '${params.target}',
      sink: snk.resourceId,
    });
    expect(env.data.versions[0].nodes[1].connectionIds).toEqual({
      source: store.resourceId,
      sink: store.resourceId,
    });
    // No dataset DB id reaches the branch.
    expect(JSON.stringify(env)).not.toContain(src.id);
    expect(JSON.stringify(env)).not.toContain(snk.id);
  });

  it('M3 (#1117) — a dangling dataset END refuses the serialize, naming WHICH end', () => {
    const { db } = freshDb();
    const store = createConnection(db, {
      ownerId: 'local',
      name: 'Store',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const src = createDataset(db, {
      ownerId: 'local',
      name: 'Src',
      connectionId: store.id,
      kind: 'table',
      config: {},
      columns: [],
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          datasetIds: { source: src.id, sink: 'ds_does_not_exist' },
          position: { x: 0, y: 0 },
        },
      ],
    });

    // Not "a connection", and not the ternary tail's "pipeline version" — a ref
    // kind without its own arm in `describeUnserializable` is labelled WRONG
    // rather than merely unlabelled.
    expect(() => serializeWorkspace(db, 'local')).toThrow(/sink dataset/);
  });

  it('remaps a literal call_pipeline pipelineVersionId to the target version resourceId', () => {
    const { db } = freshDb();
    const child = createPipeline(db, { ownerId: 'local', name: 'Child' });
    const childVersion = createPipelineVersion(db, baseVersion(child.id));
    const parent = createPipeline(db, { ownerId: 'local', name: 'Parent' });
    createPipelineVersion(db, {
      ...baseVersion(parent.id),
      nodes: [
        {
          id: 'call1',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: childVersion.id, params: {} },
        },
      ],
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/parent.json');
    expect(env.data.versions[0].nodes[0].call.pipelineVersionId).toBe(childVersion.resourceId);
  });

  it('remaps a trigger pipelineVersionId to the bound version resourceId, and strips webhook secret', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(db, baseVersion(pipeline.id));
    createTrigger(db, {
      ownerId: 'local',
      name: 'Hook',
      pipelineVersionId: version.id,
      params: {},
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'super_secret_ref_value', idempotencyWindowSeconds: 60 },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'triggers/hook.json');
    expect(env.kind).toBe('trigger');
    expect(env.data.pipelineVersionId).toBe(version.resourceId);
    expect(JSON.stringify(env)).not.toContain('super_secret_ref_value');
  });

  it('serializes a trigger bound to a NON-latest version faithfully (dangle is G7 import-side)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, baseVersion(pipeline.id));
    const v2 = createPipelineVersion(db, baseVersion(pipeline.id));
    createTrigger(db, {
      ownerId: 'local',
      name: 'T',
      pipelineVersionId: v1.id, // bound to the OLD version while v2 is latest
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const files = serializeWorkspace(db, 'local');
    // The pipeline file carries only latest (v2)...
    expect(envelopeAt(files, 'pipelines/p.json').data.versions[0].resourceId).toBe(v2.resourceId);
    // ...but the trigger faithfully records the v1 binding it actually has.
    expect(envelopeAt(files, 'triggers/t.json').data.pipelineVersionId).toBe(v1.resourceId);
  });

  it('strips connection secretRef and records requiresSecret', () => {
    const { db } = freshDb();
    createSecret(db, { ref: 'sec_abc', ciphertext: 'not-the-plaintext' });
    createConnection(db, {
      ownerId: 'local',
      name: 'Secret Conn',
      kind: 'http',
      config: {},
      secretRef: 'sec_abc',
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'connections/secret-conn.json');
    expect(env.kind).toBe('connection');
    expect(env.data.requiresSecret).toBe(true);
    expect(JSON.stringify(env)).not.toContain('sec_abc');
  });

  // #844 V1 (spec V-D2) — every committed pipeline file predates `variables`,
  // and `sourceBlobSha` hashes those exact bytes. A variable-less version must
  // serialize WITHOUT the key, or the first Commit after V1 rewrites every file.
  it('#844 V1 — a version with NO variables serializes with no `variables` key', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Plain' });
    createPipelineVersion(db, baseVersion(pipeline.id));

    const [file] = serializeWorkspace(db, 'local');
    expect(file!.contents).not.toContain('variables');
    expect(Object.keys(JSON.parse(file!.contents).data.versions[0])).not.toContain('variables');
  });

  // #1 F8a — the same rule for the two later late fields: a version without a
  // description or annotations must serialize to the bytes it had before F8a.
  it('#1 F8a — no description and no annotations serialize with neither key', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Plain' });
    createPipelineVersion(db, baseVersion(pipeline.id));

    const [file] = serializeWorkspace(db, 'local');
    expect(file!.contents).not.toContain('description');
    expect(file!.contents).not.toContain('annotations');
  });

  // #1380 — the same rule on the ROW: a pipeline with no folder must serialize
  // to the bytes it had before folders existed.
  it('#1380 — a top-level pipeline serializes with no `folder` key; a filed one carries it', () => {
    const { db } = freshDb();
    const loose = createPipeline(db, { ownerId: 'local', name: 'Loose' });
    createPipelineVersion(db, baseVersion(loose.id));
    const filed = createPipeline(db, { ownerId: 'local', name: 'Filed', folder: 'Nightly' });
    createPipelineVersion(db, baseVersion(filed.id));

    const files = serializeWorkspace(db, 'local');
    const looseFile = files.find((f) => f.path === 'pipelines/loose.json')!;
    expect(looseFile.contents).not.toContain('folder');
    expect(envelopeAt(files, 'pipelines/filed.json').data.pipeline.folder).toBe('Nightly');
  });

  it('#1 F8a — a description and annotations serialize', () => {
    const { db } = freshDb();
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, baseVersion(pipe.id));
    const described = createPipeline(db, { ownerId: 'local', name: 'Described' });
    createPipelineVersion(db, {
      ...baseVersion(described.id),
      description: 'Nightly',
      annotations: ['prod'],
    });
    const version = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/described.json').data
      .versions[0]!;
    expect(version.description).toBe('Nightly');
    expect(version.annotations).toEqual(['prod']);
  });

  it('#844 V1 — declared variables serialize, and parse back to the same declaration', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Stateful' });
    const variables = [{ name: 'count', type: 'number' as const, default: 0 }];
    createPipelineVersion(db, { ...baseVersion(pipeline.id), variables });

    const files = serializeWorkspace(db, 'local');
    expect(envelopeAt(files, 'pipelines/stateful.json').data.versions[0].variables).toEqual(
      variables,
    );
  });

  it('normalizes exportedAt to 0 so identical content re-serializes to identical bytes', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Stable' });
    createPipelineVersion(db, baseVersion(pipeline.id));

    const first = serializeWorkspace(db, 'local');
    const second = serializeWorkspace(db, 'local');
    expect(JSON.parse(first[0]!.contents).exportedAt).toBe(0);
    expect(second).toEqual(first);
  });

  it('suffixes BOTH files when two resources of a kind share a slug (deterministic)', () => {
    const { db } = freshDb();
    const a = createPipeline(db, { ownerId: 'local', name: 'Report' });
    const b = createPipeline(db, { ownerId: 'local', name: 'Report' });
    createPipelineVersion(db, baseVersion(a.id));
    createPipelineVersion(db, baseVersion(b.id));

    const paths = serializeWorkspace(db, 'local')
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual(
      [`pipelines/report-${a.resourceId}.json`, `pipelines/report-${b.resourceId}.json`].sort(),
    );
  });

  it('throws WorkspaceSerializeError on a non-null literal ref to a resource not in the workspace', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: 'conn_does_not_exist',
          position: { x: 0, y: 0 },
        },
      ],
    });

    expect(() => serializeWorkspace(db, 'local')).toThrow(WorkspaceSerializeError);
  });

  describe('#1043 — a head that cannot be put in resourceId-space', () => {
    /** A pipeline whose head node uses `conn`, which is then hard-deleted — the
     * two ordinary acts that produce a dangling ref (versions are immutable and
     * the delete has no FK to stop it). */
    function pipelineWithDeadConnection(db: ReturnType<typeof freshDb>['db'], name = 'Uses Conn') {
      const conn = createConnection(db, {
        ownerId: 'local',
        name: 'Doomed',
        kind: 'http',
        config: {},
        secretRef: null,
      });
      const pipeline = createPipeline(db, { ownerId: 'local', name });
      createPipelineVersion(db, {
        ...baseVersion(pipeline.id),
        nodes: [
          {
            id: 'n1',
            type: 'llm_call',
            config: { prompt: 'p' },
            connectionId: conn.id,
            position: { x: 0, y: 0 },
          },
        ],
      });
      deleteConnection(db, conn.id);
      return { conn, pipeline };
    }

    it('tolerant: names the offender and omits its file, instead of throwing', () => {
      const { db } = freshDb();
      const { conn, pipeline } = pipelineWithDeadConnection(db);

      const { files, unserializable } = serializeWorkspaceTolerant(db, 'local');

      expect(files.map((f) => f.path)).toEqual([]);
      expect(unserializable).toEqual([
        {
          kind: 'pipeline',
          resourceId: pipeline.resourceId,
          name: 'Uses Conn',
          path: 'pipelines/uses-conn.json',
          ref: 'connection',
          nodeId: 'n1',
          danglingId: conn.id,
        },
      ]);
    });

    it('tolerant: a healthy resource alongside an offender still serializes', () => {
      const { db } = freshDb();
      pipelineWithDeadConnection(db);
      const healthy = createPipeline(db, { ownerId: 'local', name: 'Fine' });
      createPipelineVersion(db, baseVersion(healthy.id));

      const { files, unserializable } = serializeWorkspaceTolerant(db, 'local');

      // Blast radius is exactly one resource — the whole point of the ticket.
      expect(files.map((f) => f.path)).toEqual(['pipelines/fine.json']);
      expect(unserializable).toHaveLength(1);
    });

    it('tolerant: a call_pipeline ref to a HARD-DELETED pipeline dangles the same way', () => {
      // The second producer: `deletePipeline` hard-deletes and cascades its
      // versions, so an unrelated live pipeline's call node is left naming a
      // version id that no longer exists.
      const { db } = freshDb();
      const callee = createPipeline(db, { ownerId: 'local', name: 'Callee' });
      const calleeVersion = createPipelineVersion(db, baseVersion(callee.id));
      const caller = createPipeline(db, { ownerId: 'local', name: 'Caller' });
      createPipelineVersion(db, {
        ...baseVersion(caller.id),
        nodes: [
          {
            id: 'c1',
            type: 'call_pipeline',
            config: {},
            call: { pipelineVersionId: calleeVersion.id, params: {} },
            position: { x: 0, y: 0 },
          },
        ],
      });
      deletePipeline(db, callee.id);

      const { files, unserializable } = serializeWorkspaceTolerant(db, 'local');

      expect(files.map((f) => f.path)).toEqual([]);
      expect(unserializable).toMatchObject([
        {
          kind: 'pipeline',
          name: 'Caller',
          ref: 'call',
          nodeId: 'c1',
          danglingId: calleeVersion.id,
        },
      ]);
    });

    it('tolerant: dropping an offender does NOT move a same-named survivor path', () => {
      // `resourceFilePaths` suffixes a colliding slug with the resourceId,
      // counted over the set it is given. If paths were computed AFTER the
      // offender was dropped, the survivor would lose its suffix and drift would
      // report a rename nobody performed.
      const { db } = freshDb();
      pipelineWithDeadConnection(db, 'Report');
      const survivor = createPipeline(db, { ownerId: 'local', name: 'Report' });
      createPipelineVersion(db, baseVersion(survivor.id));

      const { files } = serializeWorkspaceTolerant(db, 'local');

      expect(files.map((f) => f.path)).toEqual([`pipelines/report-${survivor.resourceId}.json`]);
    });

    it('strict: refuses the commit, naming EVERY offender and the node to fix', () => {
      const { db } = freshDb();
      pipelineWithDeadConnection(db, 'First');
      pipelineWithDeadConnection(db, 'Second');

      let thrown: unknown;
      try {
        serializeWorkspace(db, 'local');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(WorkspaceSerializeError);
      const error = thrown as WorkspaceSerializeError;
      // Both, not just the first — one at a time sends the operator round the
      // loop once per broken pipeline.
      expect(error.offenders.map((o) => o.name).sort()).toEqual(['First', 'Second']);
      expect(error.message).toContain('"First"');
      expect(error.message).toContain('"Second"');
      expect(error.message).toContain('node "n1"');
    });

    it('strict: the MESSAGE is capped, but `offenders` keeps every one', () => {
      // An unbounded list-into-one-string is the shape `capIssues` exists to
      // avoid in errors.ts, and this message goes straight into a 409 body.
      const { db } = freshDb();
      for (let i = 0; i < 8; i += 1) pipelineWithDeadConnection(db, `P${i}`);

      let thrown: unknown;
      try {
        serializeWorkspace(db, 'local');
      } catch (err) {
        thrown = err;
      }
      const error = thrown as WorkspaceSerializeError;

      expect(error.offenders).toHaveLength(8);
      expect(error.message).toContain('8 resource(s) cannot be committed');
      expect(error.message).toContain('and 3 more');
      // Counted, not named — WHICH five get named is `listPipelines`' order,
      // which is not insertion order, so asserting on a particular name here
      // would be a flake rather than a check.
      expect(error.message.match(/references connection/g)).toHaveLength(5);
    });

    it('strict: a non-serialize error is NEVER reported as a dangling ref', () => {
      // The tolerant catch is narrowed to its own error type on purpose: a Zod
      // failure inside serialize is a different fault, and folding it into
      // `unserializable` would name a node and a ref that were never the problem.
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      createPipelineVersion(db, baseVersion(pipeline.id));
      const boom = new Error('not a ref problem');
      const spy = vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => {
        throw boom;
      });

      expect(() => serializeWorkspaceTolerant(db, 'local')).toThrow(boom);
      spy.mockRestore();
    });
  });

  it('excludes another owner and returns [] for an empty workspace', () => {
    const { db } = freshDb();
    const other = createPipeline(db, { ownerId: 'someone-else', name: 'Theirs' });
    createPipelineVersion(db, baseVersion(other.id));

    expect(serializeWorkspace(db, 'local')).toEqual([]);
  });

  it('skips a version-less pipeline (no committable content yet)', () => {
    const { db } = freshDb();
    createPipeline(db, { ownerId: 'local', name: 'Empty Shell' });
    expect(serializeWorkspace(db, 'local')).toEqual([]);
  });

  // #666 / #3 G5b — git represents an archived pipeline as file ABSENCE (the
  // reconcile delete-classification), so serialize must OMIT it AND its now-
  // disabled dependent triggers; otherwise archive → Commit → import would
  // RESURRECT the pipeline on the next round-trip.
  it('OMITS an archived pipeline (git = file-absence for archive)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Gone' });
    createPipelineVersion(db, baseVersion(pipeline.id));
    archivePipeline(db, pipeline.id);

    expect(serializeWorkspace(db, 'local')).toEqual([]);
  });

  it('OMITS a trigger bound to an archived pipeline (its disabled dependent)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'Gone' });
    const version = createPipelineVersion(db, baseVersion(pipeline.id));
    createTrigger(db, {
      ownerId: 'local',
      name: 'Dependent',
      pipelineVersionId: version.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });
    // archivePipeline disables this trigger; serialize must then omit it (its
    // pipeline file is absent, so a serialized binding would dangle in git).
    archivePipeline(db, pipeline.id);

    expect(serializeWorkspace(db, 'local')).toEqual([]);
  });

  it('still serializes a LIVE pipeline whose call_pipeline targets an archived version (faithful; dangle is import-side)', () => {
    const { db } = freshDb();
    const child = createPipeline(db, { ownerId: 'local', name: 'Child' });
    const childVersion = createPipelineVersion(db, baseVersion(child.id));
    const parent = createPipeline(db, { ownerId: 'local', name: 'Parent' });
    createPipelineVersion(db, {
      ...baseVersion(parent.id),
      nodes: [
        {
          id: 'call1',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: childVersion.id, params: {} },
        },
      ],
    });
    archivePipeline(db, child.id);

    const files = serializeWorkspace(db, 'local');
    // The archived child's own file is gone...
    expect(files.find((f) => f.path.startsWith('pipelines/child'))).toBeUndefined();
    // ...but the LIVE parent still serializes, its call ref remapped to the
    // (still-real) version resourceId — the dangle-on-import is G7's charter.
    const parentEnv = envelopeAt(files, 'pipelines/parent.json');
    expect(parentEnv.data.versions[0].nodes[0].call.pipelineVersionId).toBe(
      childVersion.resourceId,
    );
  });

  it('leaves an unrelated live trigger untouched when another pipeline is archived', () => {
    const { db } = freshDb();
    const archived = createPipeline(db, { ownerId: 'local', name: 'Archived' });
    createPipelineVersion(db, baseVersion(archived.id));
    archivePipeline(db, archived.id);

    const live = createPipeline(db, { ownerId: 'local', name: 'Live' });
    const liveVersion = createPipelineVersion(db, baseVersion(live.id));
    createTrigger(db, {
      ownerId: 'local',
      name: 'Keeper',
      pipelineVersionId: liveVersion.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const files = serializeWorkspace(db, 'local');
    expect(files.map((f) => f.path).sort()).toEqual([
      'pipelines/live.json',
      'triggers/keeper.json',
    ]);
    expect(envelopeAt(files, 'triggers/keeper.json').data.pipelineVersionId).toBe(
      liveVersion.resourceId,
    );
  });

  it('does NOT suffix a live pipeline slug just because an archived one shared its name', () => {
    const { db } = freshDb();
    const archived = createPipeline(db, { ownerId: 'local', name: 'Report' });
    createPipelineVersion(db, baseVersion(archived.id));
    archivePipeline(db, archived.id);

    const live = createPipeline(db, { ownerId: 'local', name: 'Report' });
    createPipelineVersion(db, baseVersion(live.id));

    // The archived one is omitted, so the live one keeps the clean, un-suffixed
    // slug (path disambiguation is computed over the EMITTED set only).
    expect(serializeWorkspace(db, 'local').map((f) => f.path)).toEqual(['pipelines/report.json']);
  });
});

// #1018 — `ownedVersionForms(...).compare` is the SSOT both the reconcile
// PREVIEW and the reconcile APPLY judge a branch version with, so the masking
// rule is pinned here rather than twice over at each consumer.
describe('ownedVersionForms — compare (#1018)', () => {
  /** A workspace holding one pipeline whose only version uses `conn`, plus the
   * branch snapshot taken while that connection still existed. */
  function heldVersionUsing(db: ReturnType<typeof freshDb>['db']) {
    const conn = createConnection(db, {
      ownerId: 'local',
      name: 'My Conn',
      kind: 'http',
      config: { baseUrl: 'https://x' },
      secretRef: null,
    });
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'a', type: 'string' }],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: conn.id,
          position: { x: 0, y: 0 },
        },
      ],
    });
    const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local')).pipelines[0]!.data
      .versions[0]!;
    return { conn, version, branch };
  }

  const compareFor = (db: ReturnType<typeof freshDb>['db'], versionRid: string) =>
    ownedVersionForms(db, 'local', new Set([versionRid])).get(versionRid)!.compare;

  // #844 V1 — the stored row always carries `variables` (`[]` for none), while a
  // pre-V1 branch file has no key. That pair must judge IDENTICAL, or every
  // re-pull after V1 would mint a duplicate version; and a branch file that
  // declares variables must NOT, or an authored declaration would be discarded
  // as `superseded`.
  // #1 F8a — the stored row always carries both fields, while a pre-F8a branch
  // file has neither key: that pair must judge IDENTICAL (or every re-pull mints
  // a duplicate version), and an authored value must NOT (or it is discarded as
  // `superseded`).
  it('#1 F8a — an absent description/annotations match stored empties; authored ones differ', () => {
    const { db } = freshDb();
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(db, baseVersion(pipe.id));
    const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local')).pipelines[0]!.data
      .versions[0]!;
    expect(Object.keys(branch)).not.toContain('description');
    expect(Object.keys(branch)).not.toContain('annotations');

    const compare = compareFor(db, version.resourceId);
    expect(compare(branch).identical).toBe(true);
    expect(compare({ ...branch, description: 'Nightly' }).identical).toBe(false);
    expect(compare({ ...branch, annotations: ['prod'] }).identical).toBe(false);
  });

  it('#844 V1 — an absent `variables` matches a stored `[]`; a declared one differs', () => {
    const { db } = freshDb();
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(db, baseVersion(pipe.id));
    const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local')).pipelines[0]!.data
      .versions[0]!;
    expect(version.variables).toEqual([]);
    expect(Object.keys(branch)).not.toContain('variables');

    const compare = compareFor(db, version.resourceId);
    expect(compare(branch).identical).toBe(true);
    expect(
      compare({ ...branch, variables: [{ name: 'n', type: 'number', default: 0 }] }).identical,
    ).toBe(false);
  });

  it('is identical with no undecidable refs while the connection still exists', () => {
    const db = freshDb().db;
    const { version, branch } = heldVersionUsing(db);

    expect(compareFor(db, version.resourceId)(branch)).toEqual({
      identical: true,
      undecidableRefs: 0,
    });
  });

  it('after the connection is DELETED, still identical — but says the ref could not be judged', () => {
    const db = freshDb().db;
    const { conn, version, branch } = heldVersionUsing(db);
    deleteConnection(db, conn.id);

    // Nothing about either document changed; only the reverse map lost an entry.
    // An unmasked comparison would call this "different content".
    expect(compareFor(db, version.resourceId)(branch)).toEqual({
      identical: true,
      undecidableRefs: 1,
    });
  });

  it('masks per NODE REF, so a hand-edit elsewhere in the same version still differs', () => {
    const db = freshDb().db;
    const { conn, version, branch } = heldVersionUsing(db);
    deleteConnection(db, conn.id);

    const tampered = { ...branch, outputs: [{ name: 'tampered', type: 'string' as const }] };

    expect(compareFor(db, version.resourceId)(tampered)).toEqual({
      identical: false,
      undecidableRefs: 1,
    });
  });

  // M1 (#1104) — the compare direction is where a forgotten field does its worst
  // damage: if the stored form kept DB ids while the branch form holds
  // resourceIds, the two can never match and the version re-classifies as an
  // UPDATE on every single import, forever. That is silent churn, not a failure.
  describe('a paired node (M1)', () => {
    function pairedVersionUsing(db: ReturnType<typeof freshDb>['db']) {
      const src = createConnection(db, {
        ownerId: 'local',
        name: 'Src',
        kind: 'http',
        config: {},
        secretRef: null,
      });
      const snk = createConnection(db, {
        ownerId: 'local',
        name: 'Snk',
        kind: 'http',
        config: {},
        secretRef: null,
      });
      const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
      const version = createPipelineVersion(db, {
        ...baseVersion(pipe.id),
        nodes: [
          {
            id: 'n1',
            type: 'llm_call',
            config: { prompt: 'p' },
            connectionIds: { source: src.id, sink: snk.id },
            position: { x: 0, y: 0 },
          },
        ],
      });
      const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local')).pipelines[0]!.data
        .versions[0]!;
      return { src, snk, version, branch };
    }

    it('compares IDENTICAL round-tripped — no phantom update on every import', () => {
      const db = freshDb().db;
      const { version, branch } = pairedVersionUsing(db);

      expect(compareFor(db, version.resourceId)(branch)).toEqual({
        identical: true,
        undecidableRefs: 0,
      });
    });

    it('masks only the DELETED end — the surviving end still speaks', () => {
      const db = freshDb().db;
      const { snk, version, branch } = pairedVersionUsing(db);
      deleteConnection(db, snk.id);

      // Only the sink became unjudgeable; the source is decidable and unchanged.
      expect(compareFor(db, version.resourceId)(branch)).toEqual({
        identical: true,
        undecidableRefs: 1,
      });

      // Over-masking would hide this: the SOURCE end was hand-edited on the
      // branch, and that is a real difference even though the sink is dangling.
      const tampered = {
        ...branch,
        nodes: [
          { ...branch.nodes[0]!, connectionIds: { source: 'someone-elses-ref', sink: null } },
        ],
      };
      expect(compareFor(db, version.resourceId)(tampered).identical).toBe(false);
    });
  });

  // M3 (#1117) — the same compare hazard, one map further out. `ownedVersionForms`
  // builds its own `OwnerRefMaps`; if it forgets to seed the DATASET map, every
  // literal dataset end reads as undecidable, BOTH sides get masked, and a real
  // hand-edit to a dataset ref compares `identical`. That is silent, and only on
  // the read-only preview path.
  describe('a dataset-addressed node (M3)', () => {
    function datasetVersionUsing(db: ReturnType<typeof freshDb>['db']) {
      const store = createConnection(db, {
        ownerId: 'local',
        name: 'Store',
        kind: 'http',
        config: {},
        secretRef: null,
      });
      const mk = (name: string) =>
        createDataset(db, {
          ownerId: 'local',
          name,
          connectionId: store.id,
          kind: 'table',
          config: {},
          columns: [],
        });
      const src = mk('Src');
      const snk = mk('Snk');
      const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
      const version = createPipelineVersion(db, {
        ...baseVersion(pipe.id),
        nodes: [
          {
            id: 'n1',
            type: 'llm_call',
            config: { prompt: 'p' },
            datasetIds: { source: src.id, sink: snk.id },
            position: { x: 0, y: 0 },
          },
        ],
      });
      const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local')).pipelines[0]!.data
        .versions[0]!;
      return { src, snk, version, branch };
    }

    it('compares IDENTICAL round-tripped, with NO undecidable refs', () => {
      const db = freshDb().db;
      const { version, branch } = datasetVersionUsing(db);

      expect(compareFor(db, version.resourceId)(branch)).toEqual({
        identical: true,
        undecidableRefs: 0,
      });
    });

    it('masks only the DELETED dataset end — the surviving end still speaks', () => {
      const db = freshDb().db;
      const { snk, version, branch } = datasetVersionUsing(db);
      deleteDataset(db, snk.id);

      expect(compareFor(db, version.resourceId)(branch)).toEqual({
        identical: true,
        undecidableRefs: 1,
      });

      // Over-masking would hide this: the SOURCE end was hand-edited on the
      // branch, and that is a real difference even though the sink is dangling.
      const tampered = {
        ...branch,
        nodes: [{ ...branch.nodes[0]!, datasetIds: { source: 'someone-elses-ref', sink: null } }],
      };
      expect(compareFor(db, version.resourceId)(tampered).identical).toBe(false);
    });

    // M12 slice 1 (#1220) — the drift compare has TWO producers of a `NodeExport`
    // (`remapNode` writes the branch, `forwardRemapNode` re-derives the DB side),
    // and they must agree on how a source-only pair is shaped. If one omits the
    // sink key and the other emits `sink: null`, a source-only node reads as
    // DRIFTED forever — a permanent phantom diff on a node nobody edited, which
    // no amount of committing would clear.
    it('M12 (#1220) — a source-only node is IDENTICAL, not permanently drifted', () => {
      const db = freshDb().db;
      const store = createConnection(db, {
        ownerId: 'local',
        name: 'Store',
        kind: 'http',
        config: {},
        secretRef: null,
      });
      const src = createDataset(db, {
        ownerId: 'local',
        name: 'Src',
        connectionId: store.id,
        kind: 'table',
        config: {},
        columns: [],
      });
      const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
      const version = createPipelineVersion(db, {
        ...baseVersion(pipe.id),
        nodes: [
          {
            id: 'n1',
            type: 'llm_call',
            config: { prompt: 'p' },
            datasetIds: { source: src.id },
            position: { x: 0, y: 0 },
          },
        ],
      });
      const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local')).pipelines[0]!.data
        .versions[0]!;

      expect(compareFor(db, version.resourceId)(branch)).toEqual({
        identical: true,
        undecidableRefs: 0,
      });
    });
  });

  // #1106 — the commit direction (`serializeWorkspace`, which writes the branch)
  // and the compare direction (`compare`, which re-derives the stored row in
  // resourceId-space) must agree on EVERY ref position at once. The per-position
  // round-trips above each cover one; this pins all five in one version, plus a
  // `call` ref and a `${}` dynamic end, which none of them reach. A drift between
  // the two directions reads as a permanent phantom "changed" on a version nobody
  // edited.
  it('#1106 — every ref position round-trips IDENTICAL, `call` and a dynamic end included', () => {
    const db = freshDb().db;
    const conn = (name: string) =>
      createConnection(db, { ownerId: 'local', name, kind: 'http', config: {}, secretRef: null });
    const single = conn('Single');
    const src = conn('Src');
    const store = conn('Store');
    const ds = (name: string) =>
      createDataset(db, {
        ownerId: 'local',
        name,
        connectionId: store.id,
        kind: 'table',
        config: {},
        columns: [],
      });
    const dsSrc = ds('DsSrc');
    const dsSnk = ds('DsSnk');
    const callee = createPipeline(db, { ownerId: 'local', name: 'Callee' });
    const calleeVersion = createPipelineVersion(db, baseVersion(callee.id));
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    const at = { x: 0, y: 0 };
    const version = createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      params: [{ name: 'target', type: 'string', required: true }],
      nodes: [
        {
          id: 'one',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionId: single.id,
          position: at,
        },
        {
          id: 'pair',
          type: 'llm_call',
          config: { prompt: 'p' },
          connectionIds: { source: src.id, sink: '${params.target}' },
          datasetIds: { source: dsSrc.id, sink: dsSnk.id },
          position: at,
        },
        {
          id: 'call',
          type: 'call_pipeline',
          config: {},
          position: at,
          call: { pipelineVersionId: calleeVersion.id, params: {} },
        },
      ],
    });
    const branch = parseWorkspaceFiles(serializeWorkspace(db, 'local'))
      .pipelines.flatMap((p) => p.data.versions)
      .find((v) => v.resourceId === version.resourceId)!;

    // The branch really is in resourceId-space, and the dynamic end survived
    // verbatim — otherwise IDENTICAL below could be two identical mistakes.
    const [one, pair, call] = branch.nodes;
    expect(one!.connectionId).toBe(single.resourceId);
    expect(pair!.connectionIds).toEqual({ source: src.resourceId, sink: '${params.target}' });
    expect(pair!.datasetIds).toEqual({ source: dsSrc.resourceId, sink: dsSnk.resourceId });
    expect(call!.call!.pipelineVersionId).toBe(calleeVersion.resourceId);

    expect(compareFor(db, version.resourceId)(branch)).toEqual({
      identical: true,
      undecidableRefs: 0,
    });
  });
});
