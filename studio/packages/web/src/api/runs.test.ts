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
  queuedAt: null,
  triggerContext: null,
  rerunOf: null,
  startedAt: 100,
  finishedAt: null,
};

/**
 * R2 — what `GET /api/runs` now returns: a run PLUS the joined names. Kept
 * separate from `sampleRun` (which the single-run route still returns bare) so
 * each fixture matches the shape of the route it stands for.
 */
const sampleRunSummary = {
  ...sampleRun,
  pipelineId: 'pl_1',
  pipelineName: 'Nightly report',
  pipelineVersion: 3,
  triggerName: 'Every morning',
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
    const fetchMock = stubFetch(200, [sampleRunSummary]);
    const out = await listRuns();
    expect(out).toEqual([sampleRunSummary]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/runs');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('applies the shared run schema — a malformed row rejects', async () => {
    const bad: Record<string, unknown> = { ...sampleRunSummary };
    delete bad.status;
    stubFetch(200, [bad]);
    await expect(listRuns()).rejects.toThrow();
  });

  /**
   * R2 — the list contract is the SUMMARY, not a bare `Run`. A server that
   * regressed to returning rows without the joined names must fail here loudly
   * rather than leave the page rendering `undefined` in its identity column.
   */
  it('rejects a bare Run — the list route must serve the joined names', async () => {
    stubFetch(200, [sampleRun]);
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
