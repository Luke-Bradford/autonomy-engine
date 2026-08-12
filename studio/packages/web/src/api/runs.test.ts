import { computeRunCost } from '@autonomy-studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRun, getRunEvents, listExternalWaits, listRuns } from './runs';

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
  /* #931 — the summary now carries the run's cost. `computeRunCost([])` rather
     than a literal, so the fixture cannot drift from `RunCost`'s own shape. */
  cost: computeRunCost([]),
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

/** One pending external wait, in the shape the route serves (#900). */
const samplePendingWait = {
  nodeId: 'approve',
  attemptId: 'approve#0',
  expiresAt: 1_700_000_900_000,
  callbackPath: '/api/external-wait/tok_abc',
};

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

  /**
   * U26 — the filter axes ride as query params. Only SET axes reach the wire:
   * an empty string is NOT "no filter" to the server (`pipelineId` is `min(1)`,
   * `status`/`since` are closed enums), so sending one would be a 400 where the
   * caller meant "unfiltered".
   */
  it('sends only the filter axes that are set, and omits the query string entirely when none are', async () => {
    const bare = stubFetch(200, []);
    await listRuns({});
    expect(bare.mock.calls[0]![0]).toBe('/api/runs');

    const empties = stubFetch(200, []);
    await listRuns({ pipelineId: '', triggerId: undefined });
    expect(empties.mock.calls[0]![0]).toBe('/api/runs');

    const filtered = stubFetch(200, []);
    await listRuns({ status: 'failure', pipelineId: 'pl_1', triggerId: 'trg_1', since: '24h' });
    const url = new URL(filtered.mock.calls[0]![0] as string, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'failure',
      pipelineId: 'pl_1',
      triggerId: 'trg_1',
      since: '24h',
    });
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

  /* #900 — the pending external waits, and the callback path that resumes each. */

  it('lists external waits and hits GET /api/runs/:id/external-waits (id encoded)', async () => {
    const fetchMock = stubFetch(200, [samplePendingWait]);
    const out = await listExternalWaits('run 1');
    expect(out).toEqual([samplePendingWait]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/runs/run%201/external-waits');
  });

  it('returns an empty list for a run that owes no callback', async () => {
    // Not an error case: a run parked on a TIMER is equally `waiting` and has no
    // pending wait, so `[]` must parse rather than throw.
    stubFetch(200, []);
    await expect(listExternalWaits('run_1')).resolves.toEqual([]);
  });

  it('applies the shared contract — a wait with no callbackPath rejects', async () => {
    /* The field the whole surface exists to render. A server that dropped it must
       fail loudly here, not leave the monitor showing a reveal button that reveals
       nothing. */
    const bad: Record<string, unknown> = { ...samplePendingWait };
    delete bad.callbackPath;
    stubFetch(200, [bad]);
    await expect(listExternalWaits('run_1')).rejects.toThrow();
  });
});
