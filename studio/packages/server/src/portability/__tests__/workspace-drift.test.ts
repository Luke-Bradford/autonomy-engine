import { describe, expect, it } from 'vitest';
import type {
  ConnectionExportData,
  NodeExport,
  PipelineExportData,
  TriggerExportData,
} from '@autonomy-studio/shared';
import { computeDrift } from '../workspace-drift.js';
import type {
  ParsedConnection,
  ParsedPipeline,
  ParsedTrigger,
  ParsedWorkspace,
} from '../workspace-parse.js';

// Fixtures mirror workspace-reconcile.test.ts (the pull-direction dual): the DB
// and committed sides are both `ParsedWorkspace`, so the same builders serve
// both. `IGNORED` version/pipeline `resourceId`s are cross-machine identity the
// content form strips — only the ROW `resourceId` passed here is the match key.

function node(overrides: Partial<NodeExport> = {}): NodeExport {
  return {
    id: 'n1',
    type: 'llm_call',
    config: { prompt: 'hi' },
    connectionId: null,
    position: { x: 0, y: 0 },
    ...overrides,
  };
}

function pipelineData(name: string, node0: NodeExport = node()): PipelineExportData {
  return {
    pipeline: {
      id: 'pl',
      resourceId: 'IGNORED',
      ownerId: 'local',
      name,
      concurrency: null,
      createdAt: 1,
      updatedAt: 1,
    },
    versions: [
      {
        id: 'pv',
        resourceId: 'IGNORED',
        pipelineId: 'pl',
        version: 1,
        params: [],
        outputs: [],
        nodes: [node0],
        edges: [],
        containers: [],
        catalogVersion: 5,
        createdAt: 1,
      },
    ],
    strippedConnectionRefs: [],
  };
}

function parsedPipeline(
  resourceId: string | null,
  name: string,
  node0?: NodeExport,
): ParsedPipeline {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    path: `pipelines/${slug}.json`,
    blobSha: null,
    resourceId,
    versionResourceIds: [],
    data: pipelineData(name, node0),
  };
}

function connectionData(name: string, baseUrl = 'https://x'): ConnectionExportData {
  return {
    id: 'cn',
    resourceId: 'IGNORED',
    ownerId: 'local',
    name,
    kind: 'http',
    config: { baseUrl },
    parameters: [],
    requiresSecret: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function parsedConnection(
  resourceId: string | null,
  name: string,
  baseUrl?: string,
): ParsedConnection {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { path: `connections/${slug}.json`, resourceId, data: connectionData(name, baseUrl) };
}

function triggerData(name: string, enabled = true): TriggerExportData {
  return {
    id: 'tr',
    resourceId: 'IGNORED',
    ownerId: 'local',
    name,
    pipelineVersionId: null,
    params: {},
    mode: 'manual',
    schedule: null,
    recurrence: null,
    webhook: null,
    event: null,
    window: null,
    concurrency: { policy: 'queue' },
    runWindows: null,
    enabled,
    createdAt: 1,
    updatedAt: 1,
  };
}

function parsedTrigger(resourceId: string | null, name: string, enabled?: boolean): ParsedTrigger {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return { path: `triggers/${slug}.json`, resourceId, data: triggerData(name, enabled) };
}

function ws(overrides: Partial<ParsedWorkspace> = {}): ParsedWorkspace {
  return { pipelines: [], connections: [], triggers: [], diagnostics: [], ...overrides };
}

describe('computeDrift', () => {
  it('reports no changes for two empty workspaces', () => {
    expect(computeDrift(ws(), ws())).toEqual([]);
  });

  it('reports a DB resource absent from the branch as added', () => {
    expect(computeDrift(ws({ pipelines: [parsedPipeline('res_1', 'Fresh')] }), ws())).toEqual([
      {
        path: 'pipelines/fresh.json',
        kind: 'pipeline',
        resourceId: 'res_1',
        name: 'Fresh',
        change: 'added',
      },
    ]);
  });

  it('reports a branch resource absent from the DB as removed', () => {
    expect(computeDrift(ws(), ws({ pipelines: [parsedPipeline('res_1', 'Gone')] }))).toEqual([
      {
        path: 'pipelines/gone.json',
        kind: 'pipeline',
        resourceId: 'res_1',
        name: 'Gone',
        change: 'removed',
      },
    ]);
  });

  it('reports a content edit as modified', () => {
    const db = ws({ connections: [parsedConnection('res_c', 'API', 'https://new')] });
    const committed = ws({ connections: [parsedConnection('res_c', 'API', 'https://old')] });
    expect(computeDrift(db, committed)).toEqual([
      {
        path: 'connections/api.json',
        kind: 'connection',
        resourceId: 'res_c',
        name: 'API',
        change: 'modified',
      },
    ]);
  });

  it('reports a name-only change as renamed (content form identical)', () => {
    // Same resourceId + same content (baseUrl), only the display name differs.
    const db = ws({ connections: [parsedConnection('res_c', 'New Name')] });
    const committed = ws({ connections: [parsedConnection('res_c', 'Old Name')] });
    expect(computeDrift(db, committed)).toEqual([
      {
        path: 'connections/new-name.json',
        kind: 'connection',
        resourceId: 'res_c',
        name: 'New Name',
        change: 'renamed',
      },
    ]);
  });

  it('a content edit that also renames is modified (content supersedes)', () => {
    const db = ws({ connections: [parsedConnection('res_c', 'New Name', 'https://new')] });
    const committed = ws({ connections: [parsedConnection('res_c', 'Old Name', 'https://old')] });
    expect(computeDrift(db, committed)[0]!.change).toBe('modified');
  });

  it('a volatile-only re-mint (new version id/number, moved node) is NOT drift', () => {
    // The exact case blob/byte equality would over-report: a fresh immutable
    // version with identical content form. #662 defines drift by content form
    // (version id/number, createdAt, node.position all excluded), so this is clean.
    const db = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    db.pipelines[0]!.data.pipeline.id = 'pl_DB';
    db.pipelines[0]!.data.pipeline.createdAt = 9999;
    db.pipelines[0]!.data.versions[0]!.id = 'pv_DB';
    db.pipelines[0]!.data.versions[0]!.version = 42;
    db.pipelines[0]!.data.versions[0]!.createdAt = 9999;
    db.pipelines[0]!.data.versions[0]!.nodes[0]!.position = { x: 500, y: 500 };
    const committed = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    expect(computeDrift(db, committed)).toEqual([]);
  });

  it('treats a pre-G1 committed file (null resourceId) as removed', () => {
    expect(computeDrift(ws(), ws({ pipelines: [parsedPipeline(null, 'Legacy')] }))).toEqual([
      {
        path: 'pipelines/legacy.json',
        kind: 'pipeline',
        resourceId: null,
        name: 'Legacy',
        change: 'removed',
      },
    ]);
  });

  it('surfaces DB-only connections AND triggers as added (unlike the pull classifier)', () => {
    // classifyWorkspace only surfaces DB-only PIPELINES (as archive proposals);
    // the commit-direction differ must report every kind's added resources.
    const drift = computeDrift(
      ws({
        connections: [parsedConnection('res_c', 'Conn')],
        triggers: [parsedTrigger('res_t', 'Trig')],
      }),
      ws(),
    );
    expect(drift).toEqual([
      {
        path: 'connections/conn.json',
        kind: 'connection',
        resourceId: 'res_c',
        name: 'Conn',
        change: 'added',
      },
      {
        path: 'triggers/trig.json',
        kind: 'trigger',
        resourceId: 'res_t',
        name: 'Trig',
        change: 'added',
      },
    ]);
  });

  it('reports drift across kinds in pipeline→connection→trigger order', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_p', 'Kept')],
      connections: [parsedConnection('res_c', 'Added')],
      triggers: [parsedTrigger('res_t', 'Renamed')],
    });
    const committed = ws({
      pipelines: [parsedPipeline('res_p', 'Kept')], // clean → omitted
      triggers: [parsedTrigger('res_t', 'Old')], // rename
    });
    expect(computeDrift(db, committed)).toEqual([
      {
        path: 'connections/added.json',
        kind: 'connection',
        resourceId: 'res_c',
        name: 'Added',
        change: 'added',
      },
      {
        path: 'triggers/renamed.json',
        kind: 'trigger',
        resourceId: 'res_t',
        name: 'Renamed',
        change: 'renamed',
      },
    ]);
  });
});
