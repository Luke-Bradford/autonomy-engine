import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion } from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createSecret,
  createTrigger,
} from '../../repo/index.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { serializeWorkspace, WorkspaceSerializeError } from '../workspace-serialize.js';

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
          config: {},
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
          config: {},
          connectionId: '${params.conn}',
          position: { x: 0, y: 0 },
        },
      ],
    });

    const env = envelopeAt(serializeWorkspace(db, 'local'), 'pipelines/dyn.json');
    expect(env.data.versions[0].nodes[0].connectionId).toBe('${params.conn}');
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
          config: {},
          connectionId: 'conn_does_not_exist',
          position: { x: 0, y: 0 },
        },
      ],
    });

    expect(() => serializeWorkspace(db, 'local')).toThrow(WorkspaceSerializeError);
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
});
