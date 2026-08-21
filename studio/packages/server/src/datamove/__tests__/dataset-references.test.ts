import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type ActivityCatalogEntry,
  type Dataset,
  type NewTrigger,
  type Node,
} from '@autonomy-studio/shared';
import { createConnection } from '../../repo/connections.js';
import { createDataset } from '../../repo/datasets.js';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion } from '../../repo/pipeline-versions.js';
import { createTrigger } from '../../repo/triggers.js';
import { archivePipeline } from '../../repo/archive.js';
import { createWorkspaceGit } from '../../repo/workspace-git.js';
import { appendWorkspaceEvent } from '../../repo/workspace-events.js';
import { getPipeline } from '../../repo/pipelines.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import type { Db } from '../../repo/types.js';
import { datasetReferences, type CatalogOverride } from '../dataset-references.js';

const OWNER = 'local';

function store(db: Db): string {
  return createConnection(db, {
    ownerId: OWNER,
    name: 'S',
    kind: 'sqlite',
    config: { path: 'x.db' },
    secretRef: null,
  }).id;
}

function table(db: Db, connectionId: string, columns: Dataset['columns'], name = 'D'): Dataset {
  return createDataset(db, {
    ownerId: OWNER,
    name,
    kind: 'table',
    connectionId,
    config: { table: name },
    columns,
  });
}

/** A `copy` node bound to `source`/`sink`, carrying `mapping` verbatim. */
function copyNode(source: string, sink: string, mapping: unknown, id = 'n1', type = 'copy'): Node {
  return {
    id,
    type,
    config: { mapping, mode: 'append' },
    connectionIds: { source: 'c', sink: 'c' },
    datasetIds: { source, sink },
    position: { x: 0, y: 0 },
  };
}

function versionOf(db: Db, pipelineId: string, nodes: Node[]): string {
  return createPipelineVersion(db, {
    pipelineId,
    params: [{ name: 'which', type: 'string', required: false }],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  }).id;
}

function pipelineWith(
  db: Db,
  nodes: Node[],
  name = 'P',
): { pipelineId: string; versionId: string } {
  const pipeline = createPipeline(db, { ownerId: OWNER, name });
  return { pipelineId: pipeline.id, versionId: versionOf(db, pipeline.id, nodes) };
}

function bindTrigger(db: Db, versionId: string): string {
  const input: NewTrigger = {
    ownerId: OWNER,
    name: 'T',
    pipelineVersionId: versionId,
    params: {},
    mode: 'schedule',
    schedule: '0 2 * * *',
    webhook: null,
    concurrency: { policy: 'skip_if_running' },
    runWindows: null,
    enabled: true,
  };
  return createTrigger(db, input).id;
}

const ROW = (source: string, sink: string) => ({ source, sink, type: 'string', onError: 'fail' });

describe('datasetReferences (#996 M9)', () => {
  it('finds the node that reads the dataset, and says which end it is bound to', () => {
    const { db } = freshDb();
    const conn = store(db);
    const src = table(db, conn, [{ name: 'id', type: 'string', nullable: false }], 'Src');
    const sink = table(db, conn, [{ name: 'id', type: 'string', nullable: false }], 'Sink');
    pipelineWith(db, [copyNode(src.id, sink.id, [ROW('id', 'id')])]);

    const { references } = datasetReferences(db, OWNER, src);
    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      end: 'source',
      nodeId: 'n1',
      nodeType: 'copy',
      status: 'agrees',
      boundBy: ['latest'],
      pipelineArchived: false,
    });
  });

  it('reports BOTH ends when one node reads and writes the same dataset', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: false }]);
    pipelineWith(db, [copyNode(ds.id, ds.id, [ROW('id', 'id')])]);

    const ends = datasetReferences(db, OWNER, ds).references.map((r) => r.end);
    expect(ends).toEqual(['source', 'sink']);
  });

  it('flags a source mapping naming a column the dataset no longer declares', () => {
    const { db } = freshDb();
    const conn = store(db);
    const src = table(db, conn, [{ name: 'id', type: 'string', nullable: true }], 'Src');
    const sink = table(db, conn, [{ name: 'id', type: 'string', nullable: true }], 'Sink');
    pipelineWith(db, [copyNode(src.id, sink.id, [ROW('renamed', 'id')])]);

    const [ref] = datasetReferences(db, OWNER, src).references;
    expect(ref?.status).toBe('disagrees');
    expect(ref?.agreement?.disagreements).toContainEqual({
      kind: 'source_missing',
      columns: ['renamed'],
    });
  });

  it('flags a sink whose NOT NULL column the pinned mapping writes nothing into', () => {
    const { db } = freshDb();
    const conn = store(db);
    const src = table(db, conn, [{ name: 'id', type: 'string', nullable: true }], 'Src');
    const sink = table(
      db,
      conn,
      [
        { name: 'id', type: 'string', nullable: true },
        { name: 'added', type: 'string', nullable: false },
      ],
      'Sink',
    );
    pipelineWith(db, [copyNode(src.id, sink.id, [ROW('id', 'id')])]);

    const [ref] = datasetReferences(db, OWNER, sink).references;
    expect(ref?.status).toBe('disagrees');
    expect(ref?.agreement?.disagreements).toContainEqual({
      kind: 'sink_required_unwritten',
      columns: ['added'],
    });
  });

  it('counts the rows the verdict was computed over, so an EMPTY mapping is visible', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    // A row naming no sink column. The #444 write gate admits it (its three
    // cross-row rules are about identifiers and duplicates, not emptiness),
    // and it claims nothing — so the mapping is READABLE and disagrees with
    // nothing on the source side. The counts are the only thing that says the
    // copy moves no column at all.
    pipelineWith(db, [
      copyNode(ds.id, ds.id, [{ source: 'id', sink: '', type: 'string', onError: 'fail' }]),
    ]);

    const [source] = datasetReferences(db, OWNER, ds).references;
    expect(source?.status).toBe('agrees');
    expect(source?.mappedRows).toBe(0);
    expect(source?.unnamedRows).toBe(1);
  });

  it('reports an unreadable mapping as unreadable, never as agreement', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    pipelineWith(db, [copyNode(ds.id, ds.id, undefined)]);

    const [ref] = datasetReferences(db, OWNER, ds).references;
    expect(ref?.status).toBe('unreadable');
    expect(ref?.agreement).toBeNull();
    expect(ref?.unreadable).toContain('no column mapping');
  });

  it('names a `${}` end as dynamic rather than dropping it', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    pipelineWith(db, [copyNode('${params.which}', ds.id, [ROW('id', 'id')])]);

    const result = datasetReferences(db, OWNER, ds);
    expect(result.references.map((r) => r.end)).toEqual(['sink']);
    expect(result.dynamic).toEqual([
      expect.objectContaining({ end: 'source', nodeId: 'n1', nodeType: 'copy' }),
    ]);
  });

  it('walks a version an existing trigger pins, even once a newer version drops the dataset', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    const other = table(db, conn, [{ name: 'id', type: 'string', nullable: true }], 'Other');
    const { pipelineId, versionId } = pipelineWith(db, [copyNode(ds.id, ds.id, [ROW('id', 'id')])]);
    const triggerId = bindTrigger(db, versionId);
    // The author re-points the copy; the trigger still pins the OLD version.
    versionOf(db, pipelineId, [copyNode(other.id, other.id, [ROW('id', 'id')])]);

    const { references } = datasetReferences(db, OWNER, ds);
    expect(references).toHaveLength(2); // both ends of the pinned version
    expect(references[0]?.versionId).toBe(versionId);
    expect(references[0]?.boundBy).toEqual(['trigger']);
    expect(references[0]?.triggerIds).toEqual([triggerId]);
  });

  it('walks the ACTIVE PUBLISHED version in a git workspace, not just the latest', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    const other = table(db, conn, [{ name: 'id', type: 'string', nullable: true }], 'Other');
    const { pipelineId, versionId } = pipelineWith(db, [copyNode(ds.id, ds.id, [ROW('id', 'id')])]);
    // A newer, UNPUBLISHED version drops the dataset. In a git workspace a new
    // binding resolves to `active`, so the published version is what fires.
    versionOf(db, pipelineId, [copyNode(other.id, other.id, [ROW('id', 'id')])]);
    createWorkspaceGit(db, {
      ownerId: OWNER,
      repoUrl: '/repos/w',
      collabBranch: 'main',
      workingBranch: 'studio/local/work',
      observedCollabHead: 'a'.repeat(40),
      lastFetchAt: 1,
      lastFetchError: null,
    });
    appendWorkspaceEvent(db, OWNER, {
      type: 'pipeline.published',
      pipeline: getPipeline(db, pipelineId)!.resourceId,
      from: null,
      to: versionId,
      commit: 'c'.repeat(40),
      blob: 'b'.repeat(40),
      by: 'user_1',
    });

    const { references } = datasetReferences(db, OWNER, ds);
    expect(references).toHaveLength(2); // both ends of the published version
    expect(references[0]?.versionId).toBe(versionId);
    expect(references[0]?.boundBy).toEqual(['active']);
  });

  it('does NOT consult the published pointer when the workspace has no repo', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    const other = table(db, conn, [{ name: 'id', type: 'string', nullable: true }], 'Other');
    const { pipelineId, versionId } = pipelineWith(db, [copyNode(ds.id, ds.id, [ROW('id', 'id')])]);
    versionOf(db, pipelineId, [copyNode(other.id, other.id, [ROW('id', 'id')])]);
    appendWorkspaceEvent(db, OWNER, {
      type: 'pipeline.published',
      pipeline: getPipeline(db, pipelineId)!.resourceId,
      from: null,
      to: versionId,
      commit: 'c'.repeat(40),
      blob: 'b'.repeat(40),
      by: 'user_1',
    });

    // A DB-only workspace binds to LATEST, which no longer references it.
    expect(datasetReferences(db, OWNER, ds).references).toEqual([]);
  });

  it('reports an ARCHIVED pipeline, flagged — it can be un-archived', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    const { pipelineId } = pipelineWith(db, [copyNode(ds.id, ds.id, [ROW('id', 'id')])]);
    archivePipeline(db, pipelineId);

    const [ref] = datasetReferences(db, OWNER, ds).references;
    expect(ref?.pipelineArchived).toBe(true);
  });

  it('never reports another owner’s pipeline', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    const foreign = createPipeline(db, { ownerId: 'someone-else', name: 'Theirs' });
    versionOf(db, foreign.id, [copyNode(ds.id, ds.id, [ROW('id', 'id')])]);

    expect(datasetReferences(db, OWNER, ds).references).toEqual([]);
  });

  it('ignores a stray datasetIds on an activity the catalog gives no dataset ends', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    // `if` declares no `datasetKinds`, so its refs are never dispatched — and
    // reporting one would manufacture an `unreadable` copy that does not exist.
    pipelineWith(db, [
      {
        ...copyNode(ds.id, ds.id, undefined, 'n1', 'if'),
        config: { condition: '${params.which}' },
      },
    ]);

    const result = datasetReferences(db, OWNER, ds);
    expect(result.references).toEqual([]);
    expect(result.dynamic).toEqual([]);
  });

  it('asks the catalog for the SINK end, so a source-only activity contributes one ref', () => {
    const { db } = freshDb();
    const conn = store(db);
    const ds = table(db, conn, [{ name: 'id', type: 'string', nullable: true }]);
    pipelineWith(db, [copyNode(ds.id, ds.id, [ROW('id', 'id')], 'n1', 'lookup_stub')]);

    // M12's `lookup` reads a source only — `datasetKinds.sink` is optional.
    const sourceOnly: CatalogOverride = {
      get: (type: string) =>
        type === 'lookup_stub'
          ? ({ datasetKinds: { source: ['table'] } } as unknown as ActivityCatalogEntry)
          : undefined,
    };
    const { references } = datasetReferences(db, OWNER, ds, sourceOnly);
    expect(references.map((r) => r.end)).toEqual(['source']);
  });
});
