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
  getTrigger,
  getTriggerByResourceId,
  listConnections,
  listPipelineVersions,
  listPipelines,
  listTriggers,
  updateConnection,
  updatePipeline,
  updateTrigger,
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

/** #3 G6b — a deterministic git blob sha for a file path (the git reader would
 * supply the real one; the DB-snapshot path leaves it `null`). */
const blobShaFor = (path: string) => `blob-${path}`;

/** #3 G6b — a branch snapshot as the git reader would deliver it: every pipeline
 * file carries the git blob sha of its content, so an apply mint can stamp
 * provenance. Mirrors `readWorkspaceFilesAtRef` populating `WorkspaceFile.blobSha`. */
function gitSnapshot(db: ReturnType<typeof freshDb>['db'], ownerId = 'local'): ParsedWorkspace {
  const ws = snapshot(db, ownerId);
  return {
    ...ws,
    pipelines: ws.pipelines.map((p) => ({ ...p, blobSha: blobShaFor(p.path) })),
  };
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
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');

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
    applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);

    const again = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
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
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);

    createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'v2', type: 'string' }],
    });
    const result = applyWorkspace(tgt, 'local', snapshot(db), 'sha2', 'main');
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
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;

    updatePipeline(db, pipe.id, { name: 'New Name' });
    const result = applyWorkspace(tgt, 'local', snapshot(db), 'sha2', 'main');

    expect(result.applied.find((a) => a.kind === 'pipeline')?.action).toBe('renamed');
    expect(getPipeline(tgt, tgtPipe.id)!.name).toBe('New Name');
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1); // no mint
  });

  it('a pure CONCURRENCY change patches the row and mints NO version (G2)', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, baseVersion(pipe.id));
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;

    updatePipeline(db, pipe.id, { concurrency: 3 });
    const result = applyWorkspace(tgt, 'local', snapshot(db), 'sha2', 'main');

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

    const result = applyWorkspace(db, 'local', incoming, 'sha1', 'main');

    const restored = result.applied.find((a) => a.kind === 'pipeline');
    expect(restored?.action).toBe('restored');
    // Un-archive ONLY — the version was already materialised, so nothing minted.
    expect(restored?.versionMinted).toBe(false);
    expect(getPipeline(db, pipe.id)!.archived).toBe(false);
    // No duplicate row under the same resourceId.
    expect(listPipelines(db, 'local').filter((p) => p.resourceId === pipe.resourceId)).toHaveLength(
      1,
    );
    // The already-materialised version is not re-minted (skip-if-present guard).
    expect(listPipelineVersions(db, pipe.id)).toHaveLength(1);
  });

  it('RESTORE also fails closed on a reused immutable version id with divergent content', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    createPipelineVersion(db, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'orig', type: 'string' }],
    });
    const incoming = snapshot(db);
    archivePipeline(db, pipe.id);
    // Tamper the reappearing file: SAME version resourceId, different content —
    // the restore path must not silently drop the edit (the review's BLOCKING gap).
    incoming.pipelines[0]!.data.versions[0]!.outputs = [{ name: 'tampered', type: 'string' }];

    expect(() => applyWorkspace(db, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
    // Atomic: the pipeline stays archived, nothing half-restored.
    expect(getPipeline(db, pipe.id)!.archived).toBe(true);
  });

  it('#672 — a RESTORE that also advances the version reports restored + versionMinted:true', () => {
    // src authors v1, then (after tgt has it archived) advances to v2.
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'v1', type: 'string' }],
    });

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    archivePipeline(tgt, tgtPipe.id);
    expect(getPipeline(tgt, tgtPipe.id)!.archived).toBe(true);

    // A NEW immutable version (fresh resourceId, changed content) reappears while
    // the DB row is still archived — un-archive AND mint, both signalled.
    createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'v2', type: 'string' }],
    });
    const result = applyWorkspace(tgt, 'local', snapshot(src), 'sha2', 'main');

    const applied = result.applied.find((a) => a.kind === 'pipeline');
    expect(applied?.action).toBe('restored');
    expect(applied?.versionMinted).toBe(true);
    expect(getPipeline(tgt, tgtPipe.id)!.archived).toBe(false);
    // Both versions now present in the restored pipeline (v1 kept, v2 minted).
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(2);
    expect(getLatestPipelineVersion(tgt, tgtPipe.id)!.outputs[0]!.name).toBe('v2');
  });

  it('#672 — versionMinted tracks the immutable-version mint independent of action', () => {
    // A fresh create carrying a version, a rename, and a connection in one apply.
    const src = freshDb().db;
    createConnection(src, {
      ownerId: 'local',
      name: 'C',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    createPipelineVersion(src, baseVersion(pipe.id));

    const tgt = freshDb().db;
    const created = applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    // created pipeline mints its first version; created connection never mints.
    expect(created.applied.find((a) => a.kind === 'pipeline')).toMatchObject({
      action: 'created',
      versionMinted: true,
    });
    expect(created.applied.find((a) => a.kind === 'connection')).toMatchObject({
      action: 'created',
      versionMinted: false,
    });

    // A pure rename patches the row, mints nothing → versionMinted:false.
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    updatePipeline(src, pipe.id, { name: 'P renamed' });
    const renamed = applyWorkspace(tgt, 'local', snapshot(src), 'sha2', 'main');
    expect(renamed.applied.find((a) => a.kind === 'pipeline')).toMatchObject({
      action: 'renamed',
      versionMinted: false,
    });
    expect(getPipeline(tgt, tgtPipe.id)!.name).toBe('P renamed');

    // A version-doc edit → updated + versionMinted:true.
    createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'x', type: 'string' }],
    });
    const updated = applyWorkspace(tgt, 'local', snapshot(src), 'sha3', 'main');
    expect(updated.applied.find((a) => a.kind === 'pipeline')).toMatchObject({
      action: 'updated',
      versionMinted: true,
    });

    // Re-applying the same branch → unchanged + versionMinted:false.
    const again = applyWorkspace(tgt, 'local', snapshot(src), 'sha3', 'main');
    expect(again.applied.every((a) => a.versionMinted === false)).toBe(true);
    expect(again.applied.every((a) => a.action === 'unchanged')).toBe(true);
  });

  it('ARCHIVES a DB pipeline absent from the branch and disables its dependent trigger', () => {
    const db = freshDb().db;
    const gone = createPipeline(db, { ownerId: 'local', name: 'Gone' });
    const version = createPipelineVersion(db, baseVersion(gone.id));
    const trig = createTrigger(db, triggerOn(version.id));

    const result = applyWorkspace(db, 'local', parseWorkspaceFiles([]), 'sha1', 'main');

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
    applyWorkspace(tgt, 'local', snapshot(db), 'sha1', 'main');
    const tgtConn = getConnectionByResourceId(tgt, 'local', conn.resourceId)!;

    // A content edit (config) → 'updated', config carried over.
    updateConnection(db, conn.id, { config: { baseUrl: 'https://b' } });
    const r1 = applyWorkspace(tgt, 'local', snapshot(db), 'sha2', 'main');
    expect(r1.applied.find((a) => a.kind === 'connection')?.action).toBe('updated');
    expect(getConnectionByResourceId(tgt, 'local', conn.resourceId)!.config).toEqual({
      baseUrl: 'https://b',
    });

    // A pure rename → 'renamed', name changed, config untouched.
    updateConnection(db, conn.id, { name: 'Renamed' });
    const r2 = applyWorkspace(tgt, 'local', snapshot(db), 'sha3', 'main');
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
    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
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

    expect(() => applyWorkspace(db, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
  });

  it('REFUSES a NEW pipeline whose version reuses an existing version id (create-path fail-open)', () => {
    const db = freshDb().db;
    const a = createPipeline(db, { ownerId: 'local', name: 'A' });
    const aV = createPipelineVersion(db, baseVersion(a.id));

    // A branch describing a NEW pipeline B whose version reuses A's version
    // resourceId (globally unique by construction) — a corrupt/hand-crafted
    // branch. The create path must fail closed, not create a version-less shell.
    const src = freshDb().db;
    const b = createPipeline(src, { ownerId: 'local', name: 'B' });
    createPipelineVersion(src, baseVersion(b.id));
    const incoming = snapshot(src);
    incoming.pipelines[0]!.data.versions[0]!.resourceId = aV.resourceId;

    expect(() => applyWorkspace(db, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
    // Atomic: B was never created (and A untouched).
    expect(listPipelines(db, 'local').map((p) => p.name)).toEqual(['A']);
  });

  it('REFUSES a branch where two pipelines share a version resourceId (intra-batch dup)', () => {
    const src = freshDb().db;
    const a = createPipeline(src, { ownerId: 'local', name: 'A' });
    createPipelineVersion(src, baseVersion(a.id));
    const b = createPipeline(src, { ownerId: 'local', name: 'B' });
    const bV = createPipelineVersion(src, baseVersion(b.id));
    const incoming = snapshot(src);
    // Force A's file to claim B's version resourceId — two NEW pipelines in one
    // batch sharing a version id would otherwise both mint and mis-wire refs.
    const aFile = incoming.pipelines.find((p) => p.resourceId === a.resourceId)!;
    aFile.data.versions[0]!.resourceId = bV.resourceId;

    const tgt = freshDb().db;
    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
    // Atomic: neither pipeline was created.
    expect(listPipelines(tgt, 'local')).toHaveLength(0);
  });

  it('REFUSES the whole import (nothing written) when the branch has any parse diagnostic', () => {
    const db = freshDb().db;
    const incoming = parseWorkspaceFiles([
      { path: 'pipelines/x.json', contents: 'not valid json{' },
    ]);
    expect(incoming.diagnostics.length).toBeGreaterThan(0);

    const result = applyWorkspace(db, 'local', incoming, 'sha1', 'main');
    expect(result.refused).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(listPipelines(db, 'local')).toHaveLength(0);
  });

  it('APPLIES a trigger from a branch (#3 G5c-2), preserving resourceId + remapping the binding', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    const srcTrig = createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');

    // Triggers are no longer deferred — they land in `applied`, deferred is empty.
    expect(result.deferred).toHaveLength(0);
    const appliedTrig = result.applied.find((a) => a.kind === 'trigger');
    expect(appliedTrig?.action).toBe('created');
    expect(appliedTrig?.versionMinted).toBe(false); // triggers have no versions

    const tgtTrig = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId);
    expect(tgtTrig).not.toBeNull();
    // resourceId preserved (a re-pull recognises the same trigger).
    expect(tgtTrig!.resourceId).toBe(srcTrig.resourceId);
    // The binding is remapped to the TARGET version's DB id — not the source id,
    // not the resourceId.
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    const tgtVersion = getLatestPipelineVersion(tgt, tgtPipe.id)!;
    expect(tgtTrig!.pipelineVersionId).toBe(tgtVersion.id);
    expect(tgtTrig!.pipelineVersionId).not.toBe(version.id);
    // A resolved binding preserves the authored `enabled`.
    expect(tgtTrig!.enabled).toBe(true);
  });

  it('is idempotent for triggers: re-applying writes nothing new', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(listTriggers(tgt, { ownerId: 'local' })).toHaveLength(1);

    const again = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(again.applied.find((a) => a.kind === 'trigger')?.action).toBe('unchanged');
    expect(listTriggers(tgt, { ownerId: 'local' })).toHaveLength(1);
  });

  it('a trigger CONTENT edit → updated; a pure RENAME → renamed', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    const srcTrig = createTrigger(src, triggerOn(version.id));
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    const tgtTrig0 = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!;

    // A content edit (schedule) → 'updated', schedule carried over, binding kept.
    updateTrigger(src, srcTrig.id, { schedule: '0 5 * * *' });
    const r1 = applyWorkspace(tgt, 'local', snapshot(src), 'sha2', 'main');
    expect(r1.applied.find((a) => a.kind === 'trigger')?.action).toBe('updated');
    const afterEdit = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!;
    expect(afterEdit.schedule).toBe('0 5 * * *');
    expect(afterEdit.id).toBe(tgtTrig0.id); // same row, never re-created

    // A pure rename → 'renamed', name changed, schedule untouched.
    updateTrigger(src, srcTrig.id, { name: 'Renamed Trigger' });
    const r2 = applyWorkspace(tgt, 'local', snapshot(src), 'sha3', 'main');
    expect(r2.applied.find((a) => a.kind === 'trigger')?.action).toBe('renamed');
    const afterRename = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!;
    expect(afterRename.name).toBe('Renamed Trigger');
    expect(afterRename.schedule).toBe('0 5 * * *');
  });

  it('an UNRESOLVED literal binding reconciles to null + force-disables (G7 belt)', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);
    // Tamper: the trigger binds a literal version resourceId absent from branch + DB.
    incoming.triggers[0]!.data.pipelineVersionId = 'res_nonexistent';

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(result.refused).toBe(false);
    const tgtTrig = listTriggers(tgt, { ownerId: 'local' })[0]!;
    // Unbound (null) — NOT an aborted apply (that is the node-ref hard-abort).
    expect(tgtTrig.pipelineVersionId).toBeNull();
    // Belt-and-braces: an unbound trigger is force-disabled.
    expect(tgtTrig.enabled).toBe(false);
  });

  it('an authored NULL binding with enabled:true is force-disabled (finding 1)', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);
    // A branch trigger that is unbound (null) yet authored enabled:true — a
    // nonsensical inert state the apply must not persist as enabled.
    incoming.triggers[0]!.data.pipelineVersionId = null;
    incoming.triggers[0]!.data.enabled = true;

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    const tgtTrig = listTriggers(tgt, { ownerId: 'local' })[0]!;
    expect(tgtTrig.pipelineVersionId).toBeNull();
    expect(tgtTrig.enabled).toBe(false);
  });

  it('a hand-crafted ${} trigger binding reconciles to unbound + disabled (FK, never dynamic)', () => {
    // A trigger's pipelineVersionId is a FOREIGN KEY (unlike a node call ref), so
    // a `${}` value could never be stored. One arriving on a hand-edited branch
    // must reconcile to unbound + disabled, NOT FK-crash the insert.
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);
    incoming.triggers[0]!.data.pipelineVersionId = '${trigger.version}';
    incoming.triggers[0]!.data.enabled = true;

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(result.refused).toBe(false); // reconciled, not refused
    const tgtTrig = listTriggers(tgt, { ownerId: 'local' })[0]!;
    expect(tgtTrig.pipelineVersionId).toBeNull();
    expect(tgtTrig.enabled).toBe(false);
  });

  it('#3 G7: an unresolvable-bound trigger re-imported is now idempotent (unchanged, no churn)', () => {
    // A trigger authored enabled+bound to a version ABSENT from this workspace:
    // the first apply reconciles it to (null, disabled) — the "absent → disabled"
    // charter. A SECOND import of the SAME branch must now classify `unchanged`:
    // the resolved-space content compare normalizes the branch's dangling binding
    // to (null, disabled) too, matching the persisted DB row. (Was a DOCUMENTED
    // perpetual-`update` non-idempotency until G7.)
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);
    // The binding is a literal version resourceId absent from the TARGET workspace.
    incoming.triggers[0]!.data.pipelineVersionId = 'res_absent';

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    const first = listTriggers(tgt, { ownerId: 'local' })[0]!;
    expect(first.pipelineVersionId).toBeNull();
    expect(first.enabled).toBe(false);

    const again = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(again.applied.find((a) => a.kind === 'trigger')?.action).toBe('unchanged');
  });

  it('#3 G7: a trigger bound to a NON-LATEST but still-existing owned version stays bound + unchanged', () => {
    // serialize emits only the latest version per pipeline, but the resolution
    // domain is ALL owned versions — so a trigger pinned to an OLDER owned version
    // resolves and stays bound; it is NOT over-disabled. Only a truly ABSENT
    // version disables. (Regression guard for the resolved-space normalization.)
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(src, baseVersion(pipe.id));
    createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      outputs: [{ name: 'o', type: 'string' }], // v2 — a newer, distinct version
    });
    createTrigger(src, triggerOn(v1.id)); // pinned to the OLDER version
    const incoming = snapshot(src);
    expect(incoming.triggers[0]!.data.pipelineVersionId).toBe(v1.resourceId);

    // Reconcile the DB against its own branch (a re-pull): the v1 binding survives.
    const result = applyWorkspace(src, 'local', incoming, 'sha1', 'main');
    expect(result.applied.find((a) => a.kind === 'trigger')?.action).toBe('unchanged');
    const t = listTriggers(src, { ownerId: 'local' })[0]!;
    expect(t.pipelineVersionId).toBe(v1.id); // still bound to v1, NOT disabled
    expect(t.enabled).toBe(true);
  });

  it('binds a trigger to a co-created pipeline version minted in the SAME apply', () => {
    // The trigger's binding resolves only AFTER the version mint loop runs — the
    // ordering guarantee (triggers applied after mints).
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, triggerOn(version.id));
    const incoming = snapshot(src);

    const tgt = freshDb().db; // pipeline AND trigger are both fresh creates here
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(result.refused).toBe(false);
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    const tgtVersion = getLatestPipelineVersion(tgt, tgtPipe.id)!;
    const tgtTrig = listTriggers(tgt, { ownerId: 'local' })[0]!;
    expect(tgtTrig.pipelineVersionId).toBe(tgtVersion.id);
  });

  it('REFUSES + rolls back when a non-tumbling trigger binds ${trigger.windowStart}', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, {
      ...triggerOn(version.id),
      mode: 'schedule',
      params: { win: '${trigger.windowStart}' }, // window binding on a NON-tumbling trigger
    });
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
    // Atomic: the pipeline the loop created BEFORE the trigger is rolled back.
    expect(listPipelines(tgt, 'local')).toHaveLength(0);
    expect(listTriggers(tgt, { ownerId: 'local' })).toHaveLength(0);
  });

  it('round-trips an EVENT-mode trigger (create then unchanged), event subscription intact', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    const srcTrig = createTrigger(src, {
      ...triggerOn(version.id),
      mode: 'event',
      schedule: null,
      event: { name: 'order.created' },
    });
    const tgt = freshDb().db;
    const created = applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    expect(created.applied.find((a) => a.kind === 'trigger')?.action).toBe('created');
    const tgtTrig = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!;
    expect(tgtTrig.mode).toBe('event');
    expect(tgtTrig.event).toEqual({ name: 'order.created' });

    // Re-applying the same branch → unchanged (idempotent for event triggers too).
    const again = applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    expect(again.applied.find((a) => a.kind === 'trigger')?.action).toBe('unchanged');
  });

  it('DOCUMENTED non-idempotency: a webhook trigger created cross-workspace re-classifies update (G8)', () => {
    // The source's secret serializes to a public `{}`; the target create forces
    // webhook null (no secret to reconstruct), so the target serializes null.
    // `{}` ≠ null in the content form → the branch re-classifies `update` on the
    // NEXT import until the operator provisions the secret (G8 charter). Pinned
    // so a future `triggerContentForm` webhook-presence exclusion is a conscious
    // change, not a silent regression.
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    createTrigger(src, {
      ownerId: 'local',
      name: 'Hook',
      pipelineVersionId: version.id,
      params: {},
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'src_only_secret' },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main'); // cross-workspace CREATE
    // The target trigger has no secret (never imported).
    const t = listTriggers(tgt, { ownerId: 'local' })[0]!;
    expect(t.webhook).toBeNull();
    // Re-import the SAME branch → not `unchanged` but `updated` (the known churn).
    const again = applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    expect(again.applied.find((a) => a.kind === 'trigger')?.action).toBe('updated');
  });

  it('forces event null off event-mode and window null off tumbling-mode (import.ts parity)', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    // A schedule trigger carrying a stray `event` subscription AND a stray
    // `window` geometry — both mode-inconsistent; the apply must null both.
    createTrigger(src, {
      ...triggerOn(version.id),
      mode: 'schedule',
      event: { name: 'stray' },
      window: { frequency: 'hour', interval: 1, startTime: '2026-01-01T00:00:00.000Z' },
    });
    const incoming = snapshot(src);

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    const tgtTrig = listTriggers(tgt, { ownerId: 'local' })[0]!;
    expect(tgtTrig.event).toBeNull();
    expect(tgtTrig.window).toBeNull();
  });

  it('a webhook trigger round-trips UNCHANGED and never drops its local secret', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(db, baseVersion(pipe.id));
    const trig = createTrigger(db, {
      ownerId: 'local',
      name: 'Hook',
      pipelineVersionId: version.id,
      params: {},
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'secret_stays_local' },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    // Same-workspace round-trip: the existing row already holds the secret, so
    // the serialized public `{}` equals both sides → unchanged, secret intact.
    const result = applyWorkspace(db, 'local', snapshot(db), 'sha1', 'main');
    expect(result.applied.find((a) => a.kind === 'trigger')?.action).toBe('unchanged');
    expect(getTrigger(db, trig.id)!.webhook).toEqual({ secretRef: 'secret_stays_local' });
  });

  it('UPDATE preserves the existing webhook secret across a content edit that stays webhook-mode', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    const srcTrig = createTrigger(src, {
      ownerId: 'local',
      name: 'Hook',
      pipelineVersionId: version.id,
      params: {},
      mode: 'webhook',
      schedule: null,
      webhook: { secretRef: 'src_secret' },
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');
    // Provision a DIFFERENT local secret on the target (the collaborator's own).
    const tgtTrig = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!;
    updateTrigger(tgt, tgtTrig.id, { webhook: { secretRef: 'tgt_local_secret' } });

    // A content edit on the source (rename is not enough — change concurrency).
    updateTrigger(src, srcTrig.id, { concurrency: { policy: 'skip_if_running' } });
    const r = applyWorkspace(tgt, 'local', snapshot(src), 'sha2', 'main');
    expect(r.applied.find((a) => a.kind === 'trigger')?.action).toBe('updated');
    const after = getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!;
    // The content edit applied...
    expect(after.concurrency.policy).toBe('skip_if_running');
    // ...but the TARGET's local secret is untouched (never overwritten by the branch).
    expect(after.webhook).toEqual({ secretRef: 'tgt_local_secret' });
  });

  it('REFUSES an UPDATE whose resolved write violates a write-boundary rule (parallel⇒max)', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'P' });
    const version = createPipelineVersion(src, baseVersion(pipe.id));
    const srcTrig = createTrigger(src, triggerOn(version.id));
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', snapshot(src), 'sha1', 'main');

    // A hand-edited branch update carrying a write-invalid concurrency (parallel
    // with no `max`). The lenient `updateTrigger` would persist it silently; the
    // apply's `NewTriggerSchema` gate must refuse it, symmetric with create.
    const incoming = snapshot(src);
    incoming.triggers[0]!.data.name = 'Edited'; // force a content change → update path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (incoming.triggers[0]!.data.concurrency as any) = { policy: 'parallel' };

    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha2', 'main')).toThrow();
    // Atomic: the target trigger keeps its original (valid) concurrency.
    expect(getTriggerByResourceId(tgt, 'local', srcTrig.resourceId)!.concurrency.policy).toBe(
      'skip_if_running',
    );
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
    expect(() => applyWorkspace(tgt, 'local', incoming, 'sha1', 'main')).toThrow(
      WorkspaceApplyError,
    );
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
    const result = applyWorkspace(tgt, 'local', incoming, 'sha1', 'main');
    expect(result.refused).toBe(false);

    const tgtParent = getPipelineByResourceId(tgt, 'local', parent.resourceId)!;
    const tgtChild = getPipelineByResourceId(tgt, 'local', child.resourceId)!;
    const tgtChildV = getLatestPipelineVersion(tgt, tgtChild.id)!;
    const tgtParentV = getLatestPipelineVersion(tgt, tgtParent.id)!;
    // The parent's call node is remapped to the TARGET child version's DB id.
    expect(tgtParentV.nodes[0]!.call!.pipelineVersionId).toBe(tgtChildV.id);
  });
});

describe('applyWorkspace — #3 G6b git provenance on minted versions', () => {
  it('stamps source commit / branch / file path / blob sha on a minted version', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'Prov' });
    createPipelineVersion(src, {
      ...baseVersion(pipe.id),
      params: [{ name: 'p', type: 'string', required: false }],
    });
    const incoming = gitSnapshot(src);
    const filePath = incoming.pipelines[0]!.path;

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', incoming, 'commit-abc', 'feature/x');
    expect(result.refused).toBe(false);

    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    const minted = getLatestPipelineVersion(tgt, tgtPipe.id)!;
    expect(minted.sourceCommit).toBe('commit-abc');
    expect(minted.sourceBranch).toBe('feature/x');
    expect(minted.sourceFilePath).toBe(filePath);
    expect(minted.sourceBlobSha).toBe(blobShaFor(filePath));
  });

  it('tolerates a null branch — stamps sourceBranch:null without error (defensive: prod always passes collabBranch)', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'NullBranch' });
    createPipelineVersion(src, baseVersion(pipe.id));

    const tgt = freshDb().db;
    const result = applyWorkspace(tgt, 'local', gitSnapshot(src), 'commit-abc', null);
    expect(result.refused).toBe(false);
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    const minted = getLatestPipelineVersion(tgt, tgtPipe.id)!;
    expect(minted.sourceBranch).toBeNull();
    // The other three are still stamped from the (non-null) import context.
    expect(minted.sourceCommit).toBe('commit-abc');
    expect(minted.sourceBlobSha).toBe(blobShaFor(minted.sourceFilePath!));
  });

  it('leaves provenance null on a NON-git mint (the create route funnels through createPipelineVersion with no opts)', () => {
    const db = freshDb().db;
    const pipe = createPipeline(db, { ownerId: 'local', name: 'DbAuthored' });
    const v = createPipelineVersion(db, baseVersion(pipe.id));
    expect(v.sourceCommit).toBeNull();
    expect(v.sourceBranch).toBeNull();
    expect(v.sourceFilePath).toBeNull();
    expect(v.sourceBlobSha).toBeNull();
    // The re-read (not the create response) confirms the columns persisted null.
    const reread = getLatestPipelineVersion(db, pipe.id)!;
    expect(reread.sourceCommit).toBeNull();
    expect(reread.sourceBlobSha).toBeNull();
  });

  it('CHURN GUARD — a re-import of identical content at a NEW commit/blob mints nothing and never re-stamps the immutable first provenance', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'Stable' });
    createPipelineVersion(src, baseVersion(pipe.id));
    const first = gitSnapshot(src);
    const filePath = first.pipelines[0]!.path;

    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', first, 'commit-1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);
    const v1 = getLatestPipelineVersion(tgt, tgtPipe.id)!;
    expect(v1.sourceCommit).toBe('commit-1');
    expect(v1.sourceBlobSha).toBe(blobShaFor(filePath));

    // SAME authoring content, but the branch moved: a new commit AND a new blob
    // sha for the (byte-identical) file. Provenance is machine-local derived
    // state, excluded from the content form (VERSION_VOLATILE) + never serialized
    // (PipelineVersionExportSchema) — so this MUST be a no-op: no new version, and
    // the immutable v1 keeps its ORIGINAL provenance (the no-update trigger would
    // abort a re-stamp anyway).
    const second: ParsedWorkspace = {
      ...first,
      pipelines: first.pipelines.map((p) => ({ ...p, blobSha: `blob2-${p.path}` })),
    };
    const result = applyWorkspace(tgt, 'local', second, 'commit-2', 'main');
    expect(result.applied).toEqual([
      expect.objectContaining({
        resourceId: tgtPipe.resourceId,
        action: 'unchanged',
        versionMinted: false,
      }),
    ]);
    expect(listPipelineVersions(tgt, tgtPipe.id)).toHaveLength(1);
    const still = getLatestPipelineVersion(tgt, tgtPipe.id)!;
    expect(still.id).toBe(v1.id);
    expect(still.sourceCommit).toBe('commit-1');
    expect(still.sourceBlobSha).toBe(blobShaFor(filePath));
  });

  it('does NOT serialize provenance into the committed workspace files (re-serialize is byte-stable)', () => {
    const src = freshDb().db;
    const pipe = createPipeline(src, { ownerId: 'local', name: 'NoLeak' });
    createPipelineVersion(src, baseVersion(pipe.id));

    // Import a version so it carries real provenance in the DB...
    const tgt = freshDb().db;
    applyWorkspace(tgt, 'local', gitSnapshot(src), 'commit-1', 'main');
    const tgtPipe = getPipelineByResourceId(tgt, 'local', pipe.resourceId)!;
    expect(getLatestPipelineVersion(tgt, tgtPipe.id)!.sourceCommit).toBe('commit-1');

    // ...then serialize the target: the file bytes must not mention provenance
    // (it would leak the local commit + make the file's own blob sha
    // self-referential — the churn loop the exclusion prevents).
    const files = serializeWorkspace(tgt, 'local');
    const pipelineFile = files.find((f) => f.path.startsWith('pipelines/'))!;
    expect(pipelineFile.contents).not.toContain('sourceCommit');
    expect(pipelineFile.contents).not.toContain('sourceBlobSha');
    expect(pipelineFile.contents).not.toContain('commit-1');
  });
});
