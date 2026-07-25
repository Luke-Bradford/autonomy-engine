import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  createPipeline,
  createPipelineVersion,
  deletePipeline,
  describeDeleteFailure,
  duplicatePipeline,
  getPipeline,
  latestVersion,
  listPipelines,
  listPipelineVersions,
  renamePipeline,
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

/**
 * A `fetch` that answers a SCRIPTED sequence of calls — `duplicatePipeline`
 * composes three requests, and asserting the composition means controlling each
 * hop independently. Anything past the script throws rather than silently
 * repeating the last answer, which would hide a lost or extra request.
 */
function stubFetchSequence(steps: readonly { status: number; body?: unknown }[]) {
  let call = 0;
  // Typed through `vi.fn<…>()` rather than by declaring parameters the body
  // never reads, so `mock.calls` is a real tuple and the accessors below need
  // no casts.
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(() => {
    const step = steps[call++];
    if (!step) throw new Error(`unexpected fetch call #${call}`);
    return Promise.resolve({
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: () => Promise.resolve(step.body),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The URL each scripted call was made against, in order. */
function urls(fetchMock: ReturnType<typeof stubFetchSequence>): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

/** The `RequestInit` of the nth scripted call. */
function initOf(fetchMock: ReturnType<typeof stubFetchSequence>, index: number): RequestInit {
  return fetchMock.mock.calls[index]![1]!;
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

  it('getPipeline GETs one pipeline by id and encodes it into the path', async () => {
    const fetchMock = stubFetch(200, pipeline);
    await expect(getPipeline('pl/1')).resolves.toEqual(pipeline);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines/pl%2F1');
  });

  it('renamePipeline PATCHes ONLY the name — a rename must not clear concurrency', async () => {
    const fetchMock = stubFetch(200, { ...pipeline, name: 'Renamed' });
    const out = await renamePipeline('pl/1', '  Renamed  ');
    expect(out.name).toBe('Renamed');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/pipelines/pl%2F1');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PATCH');
    // Exactly one key. The server's PATCH body is `.partial()`, so an absent
    // `concurrency` PRESERVES the cap while an explicit `null` would clear it.
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed' });
  });

  it('renamePipeline refuses an empty name before it reaches the network', async () => {
    const fetchMock = stubFetch(200, pipeline);
    await expect(renamePipeline('pl_1', '   ')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('latestVersion', () => {
    it('picks the highest version NUMBER, not the last element', () => {
      const v = (n: number) => ({ ...version, id: `plv_${n}`, version: n });
      expect(latestVersion([v(1), v(7), v(3)])?.version).toBe(7);
    });

    it('is null for a pipeline with no versions yet', () => {
      expect(latestVersion([])).toBeNull();
    });
  });

  describe('duplicatePipeline', () => {
    it('creates the copy, then copies the source’s LATEST version into it', async () => {
      const clone = { ...pipeline, id: 'pl_2', name: 'My pipeline (copy)' };
      const older = { ...version, id: 'plv_0', version: 1, catalogVersion: 4 };
      const fetchMock = stubFetchSequence([
        { status: 201, body: clone },
        { status: 200, body: [older, version] },
        { status: 201, body: { ...version, id: 'plv_2', pipelineId: 'pl_2', version: 1 } },
      ]);

      await expect(duplicatePipeline(pipeline, 'My pipeline (copy)')).resolves.toEqual(clone);
      expect(urls(fetchMock)).toEqual([
        '/api/pipelines',
        '/api/pipelines/pl_1/versions',
        '/api/pipelines/pl_2/versions',
      ]);
      const copied = JSON.parse(initOf(fetchMock, 2).body as string) as Record<string, unknown>;
      // A duplicate is a COPY, not a re-authoring: it carries the source's own
      // catalogVersion rather than being silently re-stamped with today's.
      expect(copied.catalogVersion).toBe(version.catalogVersion);
      expect(copied).toMatchObject({ params: [], outputs: [], nodes: [], edges: [] });
    });

    it('carries the source’s concurrency cap onto the copy', async () => {
      const capped = { ...pipeline, concurrency: 3 };
      const fetchMock = stubFetchSequence([
        { status: 201, body: { ...capped, id: 'pl_2' } },
        { status: 200, body: [] },
      ]);

      await duplicatePipeline(capped, 'Copy');

      // Letting the write schema's `.default(null)` stand would silently
      // UNCAP the copy — an absent fact manufactured as a benign default.
      expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({
        name: 'Copy',
        concurrency: 3,
      });
    });

    it('does NOT roll back when the create itself never produced a pipeline', async () => {
      // A 201 whose body fails `PipelineSchema` throws AFTER the server has
      // committed. Nothing is bound, so there is nothing to delete — and the
      // rollback must not fire on an undefined id.
      const fetchMock = stubFetchSequence([{ status: 201, body: { id: 'pl_2' } }]);

      await expect(duplicatePipeline(pipeline, 'Copy')).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips the version copy when the source has never been saved', async () => {
      const clone = { ...pipeline, id: 'pl_2' };
      const fetchMock = stubFetchSequence([
        { status: 201, body: clone },
        { status: 200, body: [] },
      ]);

      await expect(duplicatePipeline(pipeline, 'Empty copy')).resolves.toEqual(clone);
      expect(urls(fetchMock)).toHaveLength(2);
    });

    it('ROLLS BACK the half-made copy when the version copy fails', async () => {
      const clone = { ...pipeline, id: 'pl_2' };
      const fetchMock = stubFetchSequence([
        { status: 201, body: clone },
        { status: 200, body: [version] },
        { status: 400, body: { error: 'bad_request', message: 'nodes: invalid' } },
        { status: 204 },
      ]);

      // The ORIGINAL failure surfaces — never a rollback error standing in for it.
      await expect(duplicatePipeline(pipeline, 'Copy')).rejects.toThrow(/nodes: invalid/);
      expect(urls(fetchMock)[3]).toBe('/api/pipelines/pl_2');
      expect(initOf(fetchMock, 3).method).toBe('DELETE');
    });

    it('still reports the original failure when the rollback ITSELF fails', async () => {
      const fetchMock = stubFetchSequence([
        { status: 201, body: { ...pipeline, id: 'pl_2' } },
        { status: 200, body: [version] },
        { status: 400, body: { error: 'bad_request', message: 'nodes: invalid' } },
        { status: 500, body: { error: 'internal', message: 'rollback exploded' } },
      ]);

      await expect(duplicatePipeline(pipeline, 'Copy')).rejects.toThrow(/nodes: invalid/);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('describeDeleteFailure', () => {
    it('explains the 409 refusal in terms the user can act on', () => {
      expect(describeDeleteFailure('Nightly', new ApiError(409, 'pipeline_has_runs'))).toMatch(
        /run history/,
      );
    });

    it('passes any other failure through with its message', () => {
      expect(describeDeleteFailure('Nightly', new Error('offline'))).toMatch(/offline/);
    });
  });
});
