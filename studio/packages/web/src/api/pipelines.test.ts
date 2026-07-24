import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  listPipelines,
  listPipelineVersions,
} from './pipelines';

const pipeline = {
  id: 'pl_1',
  resourceId: 'res_pl1',
  ownerId: 'local',
  name: 'My pipeline',
  concurrency: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};

const version = {
  id: 'plv_1',
  resourceId: 'res_plv1',
  pipelineId: 'pl_1',
  version: 3,
  params: [],
  outputs: [],
  nodes: [],
  edges: [],
  containers: [],
  catalogVersion: 1,
  createdAt: 1,
  // #3 G6b — git provenance, `null` on a non-git version; the client parses
  // responses through `PipelineVersionSchema`, which fills these defaults.
  sourceCommit: null,
  sourceBranch: null,
  sourceFilePath: null,
  sourceBlobSha: null,
};

function stubFetch(status: number, jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(jsonBody),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pipelines API', () => {
  it('lists pipelines and hits GET /api/pipelines (paginated envelope, #534)', async () => {
    const fetchMock = stubFetch(200, { items: [pipeline], nextCursor: null });
    const out = await listPipelines();
    expect(out).toEqual([pipeline]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines?limit=100');
  });

  it('lists a pipeline’s versions and encodes the id in the path', async () => {
    const fetchMock = stubFetch(200, [version]);
    const out = await listPipelineVersions('pl/1');
    expect(out).toEqual([version]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines/pl%2F1/versions');
  });

  it('validates versions through the shared schema — a bad row rejects', async () => {
    const bad: Record<string, unknown> = { ...version };
    delete bad.version;
    stubFetch(200, [bad]);
    await expect(listPipelineVersions('pl_1')).rejects.toThrow();
  });

  it('createPipeline POSTs the write body and returns the parsed pipeline', async () => {
    const fetchMock = stubFetch(201, pipeline);
    const out = await createPipeline({ name: 'My pipeline' });
    expect(out).toEqual(pipeline);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    // The write schema's default makes the uncapped state explicit on create.
    expect(JSON.parse(init.body as string)).toEqual({ name: 'My pipeline', concurrency: null });
  });

  it('deletePipeline DELETEs and resolves void on 204', async () => {
    const fetchMock = stubFetch(204, undefined);
    await expect(deletePipeline('pl/1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines/pl%2F1');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('createPipelineVersion POSTs to the versions path and parses the result', async () => {
    const fetchMock = stubFetch(201, version);
    const out = await createPipelineVersion('pl/1', {
      params: [],
      outputs: [],
      containers: [],
      nodes: [],
      edges: [],
    });
    expect(out).toEqual(version);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines/pl%2F1/versions');
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
  });
});
