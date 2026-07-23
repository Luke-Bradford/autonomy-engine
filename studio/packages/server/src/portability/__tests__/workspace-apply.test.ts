import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, type NewPipelineVersion, type NewTrigger } from '@autonomy-studio/shared';
import {
  archivePipeline,
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
  getConnectionByResourceId,
  getLatestPipelineVersion,
  getPipeline,
  getPipelineByResourceId,
  listConnections,
  listPipelineVersions,
  listPipelines,
  listTriggers,
  updateConnection,
  updatePipeline,
} from '../../repo/index.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { applyWorkspace, WorkspaceApplyError } from '../workspace-apply.js';
import { parseWorkspaceFiles, type ParsedWorkspace } from '../workspace-parse.js';
import { serializeWorkspace } from '../workspace-serialize.js';

/** The branch snapshot of a DB workspace: serialize + parse through the same
 * path a real committed branch takes. This IS the `incoming` an import applies. */
function snapshot(db: ReturnType<typeof freshDb>['db'], ownerId = 'local'): ParsedWorkspace {
  return parseWorkspaceFiles(serializeWorkspace(db, ownerId));
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

function triggerOn(pipelineVersionId: string): NewTrigger {
  return {
    ownerId: 'local',
    name: 'Nightly',
    pipelineVersionId,
    params: {},
    mode: 'schedule',
    schedule: '0 2 * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: true,
  };
}

describe('applyWorkspace (#3 G5c-1)', () => {
  it('creates connections + pipelines from a branch, preserving resourceIds and remapping node refs', () => {
    const src = freshDb().db;
    const conn = createConnection(src, {
      ownerId: 'local',
      name: 'My Conn',
      kind: 'http',
      config: { baseUrl: 'https://x' },
      secretRef: null,
    });
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const srcVersion = createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      nodes: [
        { id: 'n1', type: 'llm_call', config: {}, connectionId: conn.id, position: { x: 0, y: 0 } },
      ],
    });
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1');

    expect(result.refused).toBe(false);
    expect(result.head).toBe('sha1');
    expect(result.applied.map((a) => a.action)).toEqual(['created', 'created']);

    const tgtConn = getConnectionByResourceId(tgt, 'local', conn.resourceId);
    expect(tgtConn?.resourceId).toBe(conn.resourceId);
    // secretRef is never imported.
    expect(tgtConn?.secretRef).toBeNull();

    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId);
    expect(tgtPipe).not.toBeNull();
    const tgtVersion = getLatestPipelineVersion(tgt, tgtPipe!.id)!;
    // The version resourceId is PRESERVED (a re-pull recognises the same version).
    expect(tgtVersion.resourceId).toBe(srcVersion.resourceId);
    // The node's connectionId is remapped to the TARGET connection's DB id, not
    // the source id, not the resourceId.
    expect(tgtVersion.nodes[0]!.connectionId).toBe(tgtConn!.id);
    expect(tgtVersion.nodes[0]!.connectionId).not.toBe(conn.id);
  });

  it('is idempotent: re-applying the same branch writes nothing new', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    createPipelineVersion(src, baseVersion(pipe.id));
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', incoming, 'sha1');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);

    const again = applyWorkspace(tgt, 'local', incoming, 'sha1');
    expect(again.applied.every((a) => a.action === 'unchanged')).toBe(true);
    expect(listPipelines(tgt, 'local')).toHaveLength(1);
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);
  });

  it('a version-doc edit mints a NEW immutable version (the old one remains)', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'v1', type: 'string' }],
    });
    // Author a newer version, then reconcile the DB against its own latest branch
    // state after we roll the DB back to v1 — simplest: apply a snapshot taken
    // AFTER a second version into a fresh target that only has v1.
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);

    createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'v2', type: 'string' }],
    });
    const result = applyWorkspace(tgt, 'local', snapshot(db), 'sha2');
    expect(result.applied.find((a) => a.kind === 'pipeline')?.action).toBe('updated');
    const versions = listPipelineVersions(tgt, tgtPipe.id);
    expect(versions).toHaveLength(2);
    expect(getLatestPipelineVersion(tgt, tgtPipe.id)!.outputs[0]!.name).toBe('v2');
  });

  it('a pure RENAME patches the name and mints no version', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'Old' });
    createPipelineVersion(db, baseVersion(pipe.id));
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;

    updatePipeline(db, pipe.id, { name: 'New Name' });
    const result = applyWorkspace(tgt, 'local', snapshot(db), 'sha2');

    expect(result.applied.find((a) => a.kind === 'pipeline')?.action).toBe('renamed');
    expect(getPipeline(tgt, tgtPipe.id)!.name).toBe('New Name');
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1); // no mint
  });

  it('a pure CONCURRENCY change patches the row and mints NO version (G2)', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, baseVersion(pipe.id));
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;

    updatePipeline(db, pipe.id, { concurrency: 3 });
    const result = applyWorkspace(tgt, 'local', snapshot(db), 'sha2');

    expect(result.applied.find((a) => a.kind === 'pipeline')?.action).toBe('updated');
    expect(getPipeline(tgt, tgtPipe.id)!.concurrency).toBe(3);
    // The concurrency change must NOT manufacture a spurious immutable version.
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);
  });

  it('RESTORES an archived pipeline whose file reappears, never a duplicate (spec note 1)', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, baseVersion(pipe.id));
    const incoming = snapshot(db);
    archivePipeline(db, pipe.id);
    expect(getPipeline(db, pipe.id)!.archived).toBe(true);

    const result = applyWorkspace(db, 'local', incoming, 'sha1');

    expect(result.applied.find((a) => a.kind === 'pipeline')?.action).toBe('restored');
    expect(getPipeline(db, pipe.id)!.archived).toBe(false);
    // No duplicate row under the same resourceId.
    expect(listPipelines(db, 'local').filter((p) => p.resourceId === pipe.resourceId)).toHaveLength(
      1,
    );
    // The already-materialised version is not re-minted (skip-if-present guard).
    expect(listPipelineVersions(db, pipe.id)).toHaveLength(1);
  });

  it('ARCHIVES a DB pipeline absent from the branch and disables its dependent trigger', () => {
    const db = freshDb().db;
    const gone = createPipeline(db, { ownerId: 'local', name: 'Gone' });
    const version = createPipelineVersion(db, baseVersion(gone.id));
    const trig = createTrigger(db, triggerOn(version.id));

    const result = applyWorkspace(db, 'local', parseWorkspaceFiles([]), 'sha1');

    expect(result.archived).toHaveLength(1);
    expect(result.archived[0]!.resourceId).toBe(gone.resourceId);
    expect(result.archived[0]!.disabledTriggerIds).toContain(trig.id);
    expect(getPipeline(db, gone.id)!.archived).toBe(true);
    expect(listTriggers(db, { ownerId: 'local' }).find((t) => t.id === trig.id)!.enabled).toBe(
      false,
    );
  });

  it('updates a connection content edit and a pure rename independently (G3)', () => {
    const db = freshDb().db;
    const conn = createConnection(db, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: { baseUrl: 'https://a' },
      secretRef: null,
    });
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1');
    const tgtConn = getConnectionByResourceId(tgt, 'local', conn.resourceId)!;

    // A content edit (config) → 'updated', config carried over.
    updateConnection(db, conn.id, { config: { baseUrl: 'https://b' } });
    const r1 = applyWorkspace(tgt, 'local', snapshot(db), 'sha2');
    expect(r1.applied.find((a) => a.kind === 'connection')?.action).toBe('updated');
    expect(getConnectionByResourceId(tgt, 'local', conn.resourceId)!.config).toEqual({
      baseUrl: 'https://b',
    });

    // A pure rename → 'renamed', name changed, config untouched.
    updateConnection(db, conn.id, { name: 'Renamed' });
    const r2 = applyWorkspace(tgt, 'local', snapshot(db), 'sha3');
    expect(r2.applied.find((a) => a.kind === 'connection')?.action).toBe('renamed');
    const after = getConnectionByResourceId(tgt, 'local', conn.resourceId)!;
    expect(after.name).toBe('Renamed');
    expect(after.id).toBe(tgtConn.id); // same row, never re-created
  });

  it('ABORTS atomically when a call node references a version absent from branch and DB', () => {
    const src = freshDb().db;
    const child = createPipeline(src, { ownerId: 'local', name: 'Child' });
    const childV = createPipelineVersion(src, baseVersion(child.id));
    const parent = createPipeline(src, { ownerId: 'local', name: 'Parent' });
    createPipelineVersion(src, {
      ...baseVersion(parent.id),
      nodes: [
        {
          id: 'call1',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: childV.id, params: {} },
        },
      ],
    });
    // Drop the child pipeline file (by its resourceId) — the parent's call ref
    // now dangles against both the branch and the empty target DB.
    const files = serializeWorkspace(src, 'local').filter(
      (f) => JSON.parse(f.contents).data.pipeline?.resourceId !== child.resourceId,
    );
    const incoming = parseWorkspaceFiles(files);

    const tgt = freshDb().db;
    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha1')).toThrow(WorkspaceApplyError);
    // Atomic: the parent row written before the bad ref is rolled back.
    expect(listPipelines(tgt, 'local')).toHaveLength(0);
  });

  it('REFUSES a branch that reuses an immutable version id with divergent content (no silent drop)', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'orig', type: 'string' }],
    });
    const incoming = snapshot(db);
    // Tamper: keep the SAME version resourceId but change its content (a
    // hand-edit that did not mint a new version). The apply must not silently
    // skip the edit — it fails closed.
    incoming.pipelines[0]!.data.versions[0]!.outputs = [{ name: 'tampered', type: 'string' }];

    expect(() => applyWorkspace(db, 'local', incoming, 'sha1')).toThrow(WorkspaceApplyError);
  });

  it('REFUSES the whole import (nothing written) when the branch has any parse diagnostic', () => {
    const db = freshDb().db;
    const incoming = parseWorkspaceFiles([
      { path: 'pipelines/x.json', contents: 'not valid json{' },
    ]);
    expect(incoming.diagnostics.length).toBeGreaterThan(0);

    const result = applyWorkspace(db, 'local', incoming, 'sha1');
    expect(result.refused).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(listPipelines(db, 'local')).toHaveLength(0);
  });

  it('DEFERS triggers (G5c-2 #670): reported, never applied', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1');

    const deferredTrigger = result.deferred.find((d) => d.kind === 'trigger');
    expect(deferredTrigger).toBeDefined();
    expect(deferredTrigger!.disposition).toBe('create');
    // No trigger was actually written.
    expect(listTriggers(tgt, { ownerId: 'local' })).toHaveLength(0);
    // But the pipeline WAS applied.
    expect(getPipelineByResourceId(tgt, 'local', pipe.resourceId)).not.toBeNull();
  });

  it('ABORTS atomically (nothing written) when a node references an absent connection', () => {
    const src = freshDb().db;
    const conn = createConnection(src, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      nodes: [
        { id: 'n1', type: 'llm_call', config: {}, connectionId: conn.id, position: { x: 0, y: 0 } },
      ],
    });
    // Drop the connection file — the node's connection ref now dangles.
    const files = serializeWorkspace(src, 'local').filter(
      (f) => !f.path.startsWith('connections/'),
    );
    const incoming = parseWorkspaceFiles(files);

    const tgt = freshDb().db;
    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha1')).toThrow(WorkspaceApplyError);
    // Atomic: the pipeline the loop created BEFORE hitting the bad ref is rolled back.
    expect(listPipelines(tgt, 'local')).toHaveLength(0);
    expect(listConnections(tgt, 'local')).toHaveLength(0);
  });

  it('orders co-created call_pipeline chains topologically (callee minted before caller)', () => {
    const src = freshDb().db;
    // Parent is created FIRST, so its file sorts before the child's — a forward
    // reference the apply must reorder.
    const parent = createPipeline(src, { ownerId: 'local', name: 'Parent' });
    const child = createPipeline(src, { ownerId: 'local', name: 'Child' });
    const childV = createPipelineVersion(src, baseVersion(child.id));
    createPipelineVersion(src, {
      ...baseVersion(parent.id),
      nodes: [
        {
          id: 'call1',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: childV.id, params: {} },
        },
      ],
    });
    // Force the parent's file AHEAD of the child's so the call ref is a genuine
    // FORWARD reference the apply must reorder (topo), independent of serialize's
    // natural file order.
    const files = serializeWorkspace(src, 'local');
    const pipelineRid = (f: { contents: string }): string =>
      JSON.parse(f.contents).data.pipeline.resourceId;
    const parentFile = files.find(
      (f) => f.path.startsWith('pipelines/') && pipelineRid(f) === parent.resourceId,
    )!;
    const childFile = files.find(
      (f) => f.path.startsWith('pipelines/') && pipelineRid(f) === child.resourceId,
    )!;
    const incoming = parseWorkspaceFiles([parentFile, childFile]);
    expect(incoming.pipelines[0]!.resourceId).toBe(parent.resourceId);

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1');
    expect(result.refused).toBe(false);

    const tgtParent = getPipelineByResourceId(tgt, 'local', parent.resourceId)!;
    const tgtChild = getPipelineByResourceId(tgt, 'local', child.resourceId)!;
    const tgtChildV = getLatestPipelineVersion(tgt, tgtChild.id)!;
    const tgtParentV = getLatestPipelineVersion(tgt, tgtParent.id)!;
    // The parent's call node is remapped to the TARGET child version's DB id.
    expect(tgtParentV.nodes[0]!.call!.pipelineVersionId).toBe(tgtChildV.id);
  });
});
