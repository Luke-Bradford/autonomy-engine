import { describe, expect, it } from 'vitest';
import { connectionContentForm, pipelineContentForm, triggerContentForm } from '../content-form.js';
import type {
  ConnectionExportData,
  NodeExport,
  PipelineExportData,
  TriggerExportData,
} from '../envelope.js';

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

function pipelineData(
  overrides: {
    pipeline?: Partial<PipelineExportData['pipeline']>;
    version?: Partial<PipelineExportData['versions'][number]>;
  } = {},
): PipelineExportData {
  return {
    pipeline: {
      id: 'pl_1',
      resourceId: 'res_pl_1',
      ownerId: 'local',
      name: 'My Pipeline',
      concurrency: null,
      createdAt: 111,
      updatedAt: 222,
      ...overrides.pipeline,
    },
    versions: [
      {
        id: 'pv_1',
        resourceId: 'res_pv_1',
        pipelineId: 'pl_1',
        version: 1,
        params: [],
        outputs: [],
        nodes: [node()],
        edges: [],
        containers: [],
        catalogVersion: 5,
        createdAt: 333,
        ...overrides.version,
      },
    ],
    strippedConnectionRefs: [],
  };
}

function connectionData(overrides: Partial<ConnectionExportData> = {}): ConnectionExportData {
  return {
    id: 'cn_1',
    resourceId: 'res_cn_1',
    ownerId: 'local',
    name: 'My Conn',
    kind: 'http',
    config: { baseUrl: 'https://x' },
    parameters: [],
    requiresSecret: false,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function triggerData(overrides: Partial<TriggerExportData> = {}): TriggerExportData {
  return {
    id: 'tr_1',
    resourceId: 'res_tr_1',
    ownerId: 'local',
    name: 'My Trigger',
    pipelineVersionId: 'res_pv_1',
    params: {},
    mode: 'manual',
    schedule: null,
    recurrence: null,
    webhook: null,
    event: null,
    window: null,
    concurrency: { policy: 'queue' },
    runWindows: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe('pipelineContentForm', () => {
  it('is EQUAL when only resource identity / timestamps differ (cross-machine)', () => {
    const a = pipelineData();
    const b = pipelineData({
      pipeline: { id: 'pl_OTHER', resourceId: 'res_OTHER', createdAt: 999, updatedAt: 888 },
      version: {
        id: 'pv_OTHER',
        resourceId: 'res_pv_OTHER',
        pipelineId: 'pl_OTHER',
        version: 7,
        catalogVersion: 9,
        createdAt: 777,
      },
    });
    expect(pipelineContentForm(a)).toBe(pipelineContentForm(b));
  });

  it('is EQUAL when only the display name differs (a rename is not a content edit)', () => {
    expect(pipelineContentForm(pipelineData({ pipeline: { name: 'Renamed' } }))).toBe(
      pipelineContentForm(pipelineData()),
    );
  });

  it('is EQUAL when only a node POSITION differs (canvas geometry is not behaviour)', () => {
    const moved = pipelineData({ version: { nodes: [node({ position: { x: 500, y: 900 } })] } });
    expect(pipelineContentForm(moved)).toBe(pipelineContentForm(pipelineData()));
  });

  it('DIFFERS when a node CONFIG changes (a real edit)', () => {
    const edited = pipelineData({ version: { nodes: [node({ config: { prompt: 'CHANGED' } })] } });
    expect(pipelineContentForm(edited)).not.toBe(pipelineContentForm(pipelineData()));
  });

  it('DIFFERS when an author-assigned node id changes (node id is graph content, never stripped)', () => {
    const renamedNode = pipelineData({ version: { nodes: [node({ id: 'differentNodeId' })] } });
    expect(pipelineContentForm(renamedNode)).not.toBe(pipelineContentForm(pipelineData()));
  });

  it('DIFFERS when the concurrency cap changes (authoring content)', () => {
    expect(pipelineContentForm(pipelineData({ pipeline: { concurrency: 3 } }))).not.toBe(
      pipelineContentForm(pipelineData()),
    );
  });

  it('is insensitive to object key ordering (canonical)', () => {
    const reordered = pipelineData();
    reordered.versions[0]!.nodes[0]!.config = { z: 1, a: 2 };
    const ordered = pipelineData();
    ordered.versions[0]!.nodes[0]!.config = { a: 2, z: 1 };
    expect(pipelineContentForm(reordered)).toBe(pipelineContentForm(ordered));
  });
});

describe('connectionContentForm', () => {
  it('is EQUAL when only identity / requiresSecret differ (requiresSecret is local readiness state)', () => {
    const a = connectionData({ requiresSecret: false });
    const b = connectionData({
      id: 'cn_OTHER',
      resourceId: 'res_OTHER',
      name: 'Other name',
      requiresSecret: true,
      createdAt: 9,
      updatedAt: 9,
    });
    expect(connectionContentForm(a)).toBe(connectionContentForm(b));
  });

  it('DIFFERS when config changes', () => {
    expect(connectionContentForm(connectionData({ config: { baseUrl: 'https://y' } }))).not.toBe(
      connectionContentForm(connectionData()),
    );
  });
});

describe('triggerContentForm', () => {
  it('is EQUAL when only identity / timestamps / name differ', () => {
    const a = triggerData();
    const b = triggerData({
      id: 'tr_OTHER',
      resourceId: 'res_OTHER',
      name: 'Other',
      createdAt: 9,
      updatedAt: 9,
    });
    expect(triggerContentForm(a)).toBe(triggerContentForm(b));
  });

  it('DIFFERS when the binding (pipelineVersionId) changes — a rebind IS content', () => {
    expect(triggerContentForm(triggerData({ pipelineVersionId: 'res_pv_DIFFERENT' }))).not.toBe(
      triggerContentForm(triggerData()),
    );
  });

  it('DIFFERS when enabled flips (authored intent)', () => {
    expect(triggerContentForm(triggerData({ enabled: false }))).not.toBe(
      triggerContentForm(triggerData()),
    );
  });
});
