import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRun, getRunEvents, listRuns } from './runs';

const sampleRun = {
  id: 'run_1',
  ownerId: 'local',
  pipelineVersionId: 'pv_1',
  triggerId: 'trg_1',
  parentRunId: null,
  params: { greeting: 'hi' },
  status: 'running' as const,
  leaseUntil: null,
  heartbeatAt: null,
  startedAt: 100,
  finishedAt: null,
};

const sampleEvent = {
  id: 'evt_1',
  runId: 'run_1',
  seq: 0,
  type: 'run.started',
  payload: { type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} },
  ts: 101,
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

describe('runs API', () => {
  it('lists runs and hits GET /api/runs', async () => {
    const fetchMock = stubFetch(200, [sampleRun]);
    const out = await listRuns();
    expect(out).toEqual([sampleRun]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/runs');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('applies the shared run schema — a malformed row rejects', async () => {
    const bad: Record<string, unknown> = { ...sampleRun };
    delete bad.status;
    stubFetch(200, [bad]);
    await expect(listRuns()).rejects.toThrow();
  });

  it('gets one run and hits GET /api/runs/:id (id encoded)', async () => {
    const fetchMock = stubFetch(200, sampleRun);
    const out = await getRun('run 1');
    expect(out).toEqual(sampleRun);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/runs/run%201');
  });

  it('gets a run event log and hits GET /api/runs/:id/events', async () => {
    const fetchMock = stubFetch(200, [sampleEvent]);
    const out = await getRunEvents('run_1');
    expect(out).toEqual([sampleEvent]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/runs/run_1/events');
  });
});
