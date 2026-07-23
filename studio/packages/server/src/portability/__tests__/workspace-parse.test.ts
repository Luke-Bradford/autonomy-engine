import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  SCHEMA_VERSION,
  canonicalStringify,
  type NewPipelineVersion,
} from '@autonomy-studio/shared';
import {
  createConnection,
  createPipeline,
  createPipelineVersion,
  createTrigger,
} from '../../repo/index.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { serializeWorkspace, type WorkspaceFile } from '../workspace-serialize.js';
import { parseWorkspaceFiles } from '../workspace-parse.js';

/**
 * #3 G4 — the workspace-git import PARSER. Its primary contract is a lossless
 * round-trip with `serializeWorkspace` (G3a): serialize a DB workspace to
 * canonical JSON files, parse them back, and every resource + remapped ref
 * survives. Parsing is PURE and NON-writing; cross-resource ref RESOLUTION and
 * DB reconcile are G5/G7's charter, not tested here.
 */

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

/** A minimal well-formed pipeline envelope file at an arbitrary path. */
function pipelineFile(path: string, resourceId: string | null, name = 'P'): WorkspaceFile {
  return {
    path,
    contents: canonicalStringify({
      schemaVersion: SCHEMA_VERSION,
      catalogVersion: CATALOG_VERSION,
      kind: 'pipeline',
      exportedAt: 0,
      data: {
        pipeline: {
          id: 'pl_x',
          resourceId,
          ownerId: 'local',
          name,
          createdAt: 0,
          updatedAt: 0,
        },
        versions: [],
        strippedConnectionRefs: [],
      },
    }),
  };
}

describe('parseWorkspaceFiles', () => {
  it('round-trips a serialized workspace: resources, ids, and remapped refs survive', () => {
    const { db } = freshDb();
    const connection = createConnection(db, {
      ownerId: 'local',
      name: 'My Conn',
      kind: 'http',
      config: {},
      secretRef: null,
    });
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'My Pipeline' });
    const version = createPipelineVersion(db, {
      ...baseVersion(pipeline.id),
      params: [{ name: 'conn', type: 'string', required: true }],
      nodes: [
        {
          id: 'n1',
          type: 'llm_call',
          config: {},
          connectionId: connection.id, // literal → remapped to resourceId
          position: { x: 0, y: 0 },
        },
        {
          id: 'n2',
          type: 'llm_call',
          config: {},
          connectionId: '${params.conn}', // dynamic → preserved verbatim
          position: { x: 0, y: 0 },
        },
      ],
    });
    const trigger = createTrigger(db, {
      ownerId: 'local',
      name: 'Hook',
      pipelineVersionId: version.id,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      concurrency: { policy: 'queue' },
      runWindows: null,
      enabled: true,
    });

    const parsed = parseWorkspaceFiles(serializeWorkspace(db, 'local'));

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.pipelines).toHaveLength(1);
    expect(parsed.connections).toHaveLength(1);
    expect(parsed.triggers).toHaveLength(1);

    // The pipeline resource is keyed on the pipeline ROW's resourceId.
    expect(parsed.pipelines[0]!.resourceId).toBe(pipeline.resourceId);
    // ...and the committed version resourceIds are surfaced for G7.
    expect(parsed.pipelines[0]!.versionResourceIds).toEqual([version.resourceId]);
    // Remapped literal ref → connection resourceId; dynamic ref → verbatim.
    const nodes = parsed.pipelines[0]!.data.versions[0]!.nodes;
    expect(nodes[0]!.connectionId).toBe(connection.resourceId);
    expect(nodes[1]!.connectionId).toBe('${params.conn}');

    expect(parsed.connections[0]!.resourceId).toBe(connection.resourceId);
    // The trigger resource is keyed on the TRIGGER's own resourceId...
    expect(parsed.triggers[0]!.resourceId).toBe(trigger.resourceId);
    // ...while its bound version ref is remapped to that version's resourceId.
    expect(parsed.triggers[0]!.data.pipelineVersionId).toBe(version.resourceId);
  });

  it('reports a malformed file as an unparseable diagnostic (not a throw, resource absent)', () => {
    const parsed = parseWorkspaceFiles([{ path: 'pipelines/broken.json', contents: '{ not json' }]);
    expect(parsed.pipelines).toEqual([]);
    expect(parsed.diagnostics).toEqual([
      { path: 'pipelines/broken.json', code: 'unparseable', message: expect.any(String) },
    ]);
  });

  it('reports an envelope whose kind disagrees with its directory as kind_mismatch', () => {
    // A connection envelope committed under pipelines/.
    const connEnv = canonicalStringify({
      schemaVersion: SCHEMA_VERSION,
      catalogVersion: CATALOG_VERSION,
      kind: 'connection',
      exportedAt: 0,
      data: {
        id: 'cn_x',
        resourceId: 'res_c',
        ownerId: 'local',
        name: 'C',
        kind: 'http',
        config: {},
        requiresSecret: false,
        createdAt: 0,
        updatedAt: 0,
      },
    });
    const parsed = parseWorkspaceFiles([{ path: 'pipelines/misplaced.json', contents: connEnv }]);
    expect(parsed.pipelines).toEqual([]);
    expect(parsed.connections).toEqual([]);
    expect(parsed.diagnostics[0]!.code).toBe('kind_mismatch');
  });

  it('reports a duplicate non-null resourceId within a kind, keeping the first', () => {
    const parsed = parseWorkspaceFiles([
      pipelineFile('pipelines/a.json', 'res_dup', 'A'),
      pipelineFile('pipelines/b.json', 'res_dup', 'B'),
    ]);
    expect(parsed.pipelines).toHaveLength(1);
    expect(parsed.pipelines[0]!.path).toBe('pipelines/a.json');
    expect(parsed.diagnostics[0]).toEqual({
      path: 'pipelines/b.json',
      code: 'duplicate_resource_id',
      message: expect.any(String),
    });
  });

  it('does NOT treat two null-resourceId files as a duplicate (null = legacy-no-identity)', () => {
    const parsed = parseWorkspaceFiles([
      pipelineFile('pipelines/a.json', null, 'A'),
      pipelineFile('pipelines/b.json', null, 'B'),
    ]);
    expect(parsed.pipelines).toHaveLength(2);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('flags a file outside the managed directories as unknown_dir', () => {
    const parsed = parseWorkspaceFiles([pipelineFile('random/x.json', 'res_x')]);
    expect(parsed.pipelines).toEqual([]);
    expect(parsed.diagnostics[0]!.code).toBe('unknown_dir');
  });

  it('upgrades a pre-G1 (schemaVersion 3) file, backfilling resourceId as null', () => {
    // A v3 pipeline envelope has NO resourceId anywhere — the v3→v4 upgrader
    // backfills null; the parser must accept it and treat it as no-identity.
    const legacy = JSON.stringify({
      schemaVersion: 3,
      catalogVersion: CATALOG_VERSION,
      kind: 'pipeline',
      exportedAt: 0,
      data: {
        pipeline: { id: 'pl_v3', ownerId: 'local', name: 'Legacy', createdAt: 0, updatedAt: 0 },
        versions: [],
        strippedConnectionRefs: [],
      },
    });
    const parsed = parseWorkspaceFiles([{ path: 'pipelines/legacy.json', contents: legacy }]);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.pipelines).toHaveLength(1);
    expect(parsed.pipelines[0]!.resourceId).toBeNull();
  });
});
