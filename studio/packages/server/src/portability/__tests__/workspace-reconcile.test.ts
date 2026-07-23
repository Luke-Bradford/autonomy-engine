import { describe, expect, it } from 'vitest';
import type {
  ConnectionExportData,
  NodeExport,
  PipelineExportData,
  TriggerExportData,
} from '@autonomy-studio/shared';
import { classifyWorkspace } from '../workspace-reconcile.js';
import type {
  ParsedConnection,
  ParsedPipeline,
  ParsedTrigger,
  ParsedWorkspace,
} from '../workspace-parse.js';

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

const dispositionOf = (plan: ReturnType<typeof classifyWorkspace>, resourceId: string) =>
  plan.resources.find((r) => r.resourceId === resourceId);

describe('classifyWorkspace', () => {
  it('classifies an incoming resourceId absent from the DB as create', () => {
    const plan = classifyWorkspace(ws(), ws({ pipelines: [parsedPipeline('res_new', 'Fresh')] }));
    expect(dispositionOf(plan, 'res_new')).toMatchObject({
      disposition: 'create',
      nameChanged: false,
      contentChanged: false,
    });
    expect(plan.archive).toEqual([]);
  });

  it('classifies a pre-G1 file (null resourceId) as create', () => {
    const plan = classifyWorkspace(ws(), ws({ pipelines: [parsedPipeline(null, 'Legacy')] }));
    expect(plan.resources[0]).toMatchObject({ resourceId: null, disposition: 'create' });
  });

  it('classifies an identical resource (same content + name) as unchanged', () => {
    const db = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    const incoming = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    expect(dispositionOf(classifyWorkspace(db, incoming), 'res_1')).toMatchObject({
      disposition: 'unchanged',
      nameChanged: false,
      contentChanged: false,
    });
  });

  it('ignores cross-machine identity/timestamps when deciding unchanged', () => {
    // The DB side would carry different DB ids / createdAt; content form excludes
    // them, so an otherwise-identical resource is unchanged.
    const db: ParsedWorkspace = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    db.pipelines[0]!.data.pipeline.id = 'pl_DB';
    db.pipelines[0]!.data.pipeline.createdAt = 9999;
    db.pipelines[0]!.data.versions[0]!.id = 'pv_DB';
    db.pipelines[0]!.data.versions[0]!.version = 42;
    const incoming = ws({ pipelines: [parsedPipeline('res_1', 'Same')] });
    expect(dispositionOf(classifyWorkspace(db, incoming), 'res_1')?.disposition).toBe('unchanged');
  });

  it('classifies a content edit as update (contentChanged true)', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_1', 'P', node({ config: { prompt: 'old' } }))],
    });
    const incoming = ws({
      pipelines: [parsedPipeline('res_1', 'P', node({ config: { prompt: 'NEW' } }))],
    });
    expect(dispositionOf(classifyWorkspace(db, incoming), 'res_1')).toMatchObject({
      disposition: 'update',
      contentChanged: true,
      nameChanged: false,
    });
  });

  it('classifies a pure rename (name differs, content same) as rename', () => {
    const db = ws({ pipelines: [parsedPipeline('res_1', 'Old Name')] });
    const incoming = ws({ pipelines: [parsedPipeline('res_1', 'New Name')] });
    expect(dispositionOf(classifyWorkspace(db, incoming), 'res_1')).toMatchObject({
      disposition: 'rename',
      nameChanged: true,
      contentChanged: false,
    });
  });

  it('labels a rename-AND-edit as update but keeps nameChanged true (no lost signal)', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_1', 'Old', node({ config: { prompt: 'old' } }))],
    });
    const incoming = ws({
      pipelines: [parsedPipeline('res_1', 'New', node({ config: { prompt: 'new' } }))],
    });
    expect(dispositionOf(classifyWorkspace(db, incoming), 'res_1')).toMatchObject({
      disposition: 'update',
      nameChanged: true,
      contentChanged: true,
    });
  });

  it('proposes archiving a DB pipeline whose resourceId is absent from the branch', () => {
    const db = ws({
      pipelines: [parsedPipeline('res_keep', 'Keep'), parsedPipeline('res_gone', 'Gone')],
    });
    const incoming = ws({ pipelines: [parsedPipeline('res_keep', 'Keep')] });
    const plan = classifyWorkspace(db, incoming);
    expect(plan.archive).toEqual([
      { path: 'pipelines/gone.json', kind: 'pipeline', resourceId: 'res_gone', name: 'Gone' },
    ]);
    expect(dispositionOf(plan, 'res_keep')?.disposition).toBe('unchanged');
  });

  it('does NOT propose archiving a connection or trigger absent from the branch (deferred to G5c)', () => {
    const db = ws({
      connections: [parsedConnection('res_c', 'C')],
      triggers: [parsedTrigger('res_t', 'T')],
    });
    const plan = classifyWorkspace(db, ws());
    expect(plan.archive).toEqual([]);
    expect(plan.resources).toEqual([]);
  });

  it('classifies connections and triggers by resourceId too', () => {
    const db = ws({
      connections: [parsedConnection('res_c', 'C', 'https://old')],
      triggers: [parsedTrigger('res_t', 'T', true)],
    });
    const incoming = ws({
      connections: [parsedConnection('res_c', 'C', 'https://new')],
      triggers: [parsedTrigger('res_t', 'T', false)],
    });
    const plan = classifyWorkspace(db, incoming);
    expect(dispositionOf(plan, 'res_c')).toMatchObject({
      kind: 'connection',
      disposition: 'update',
    });
    expect(dispositionOf(plan, 'res_t')).toMatchObject({ kind: 'trigger', disposition: 'update' });
  });

  it('ignores a null-resourceId row on the DB side (defensive — serialize never emits one)', () => {
    // A DB-side pipeline with a null resourceId is a can't-happen shape
    // (serializeWorkspace always mints real ids); the classifier must not let it
    // become a spurious match/archive. An incoming pipeline reusing that name is
    // a plain create, and the null-id DB row is not proposed for archive.
    const db = ws({ pipelines: [parsedPipeline(null, 'Ghost')] });
    const incoming = ws({ pipelines: [parsedPipeline('res_new', 'Ghost')] });
    const plan = classifyWorkspace(db, incoming);
    expect(dispositionOf(plan, 'res_new')?.disposition).toBe('create');
    expect(plan.archive).toEqual([]);
  });

  it('orders resources pipelines → connections → triggers, following the incoming snapshot', () => {
    const incoming = ws({
      pipelines: [parsedPipeline('res_p', 'P')],
      connections: [parsedConnection('res_c', 'C')],
      triggers: [parsedTrigger('res_t', 'T')],
    });
    expect(classifyWorkspace(ws(), incoming).resources.map((r) => r.kind)).toEqual([
      'pipeline',
      'connection',
      'trigger',
    ]);
  });
});
