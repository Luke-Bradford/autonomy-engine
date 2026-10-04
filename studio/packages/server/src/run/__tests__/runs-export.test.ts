import { describe, expect, it } from 'vitest';
import type { RunSummary, RunSummaryPage } from '@autonomy-studio/shared';
import { collectRunsForExport, runExportRow, RUNS_EXPORT_COLUMNS } from '../runs-export.js';

/** A list of `total` runs read in keyset pages, recording each page's limit. */
function pagedList(ids: string[]) {
  const limits: number[] = [];
  const readPage = (limit: number, cursor: string | undefined): RunSummaryPage => {
    limits.push(limit);
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = ids.slice(start, start + limit).map((id) => ({ id }) as RunSummary);
    const next = start + limit;
    // The list's probe: a cursor only when a further row really exists.
    return { items, nextCursor: next < ids.length ? String(next) : null };
  };
  return { readPage, limits };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `run_${i}`);

describe('collectRunsForExport (#1484)', () => {
  it('walks every page in order and is not truncated when the list ends first', async () => {
    const { readPage, limits } = pagedList(ids(5));
    const out = await collectRunsForExport(readPage, 2, 10);
    expect(out.runs.map((r) => r.id)).toEqual(ids(5));
    expect(out.truncated).toBe(false);
    expect(limits).toEqual([2, 2, 2]);
  });

  it('stops at max and says truncated only when a further run exists', async () => {
    const more = pagedList(ids(7));
    const cut = await collectRunsForExport(more.readPage, 2, 5);
    expect(cut.runs.map((r) => r.id)).toEqual(ids(5));
    expect(cut.truncated).toBe(true);
    // The last page asks only for what is still wanted.
    expect(more.limits).toEqual([2, 2, 1]);

    const exact = await collectRunsForExport(pagedList(ids(5)).readPage, 2, 5);
    expect(exact.runs).toHaveLength(5);
    expect(exact.truncated).toBe(false);
  });

  it('drops a run a later page repeats (a non-default sort moved it)', async () => {
    const pages: RunSummaryPage[] = [
      { items: [{ id: 'a' }, { id: 'b' }] as RunSummary[], nextCursor: '1' },
      { items: [{ id: 'b' }, { id: 'c' }] as RunSummary[], nextCursor: null },
    ];
    let i = 0;
    const out = await collectRunsForExport(() => pages[i++]!, 2, 10);
    expect(out.runs.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a cursor that does not advance rather than looping', async () => {
    const page: RunSummaryPage = { items: [{ id: 'a' }] as RunSummary[], nextCursor: 'same' };
    await expect(collectRunsForExport(() => page, 1, 10)).rejects.toThrow(/cursor/);
  });

  it('refuses a cursor that comes round again (A → B → A)', async () => {
    const next: Record<string, string> = { start: 'A', A: 'B', B: 'A' };
    await expect(
      collectRunsForExport(
        (_limit, cursor) => ({
          items: [{ id: 'a' }] as RunSummary[],
          nextCursor: next[cursor ?? 'start']!,
        }),
        1,
        10,
      ),
    ).rejects.toThrow(/cursor/);
  });

  it('yields to the event loop between pages', async () => {
    const { readPage } = pagedList(ids(4));
    // A macrotask queued during each page must have run before the next page
    // is read — which a walk that never yields would not allow.
    let ran = true;
    let pagesRead = 0;
    await collectRunsForExport(
      (limit, cursor) => {
        expect(ran).toBe(true);
        ran = false;
        setImmediate(() => (ran = true));
        pagesRead += 1;
        return readPage(limit, cursor);
      },
      1,
      10,
    );
    expect(pagesRead).toBe(4);
  });
});

describe('runExportRow', () => {
  const run = {
    id: 'run_1',
    pipelineName: 'Orders',
    pipelineId: 'pl_1',
    pipelineVersion: 3,
    debug: false,
    status: 'success',
    triggeredByKind: 'schedule',
    triggerName: 'Nightly',
    triggerId: 'tr_1',
    queuedAt: null,
    startedAt: Date.UTC(2026, 9, 4, 12, 0, 0, 5),
    finishedAt: Date.UTC(2026, 9, 4, 12, 0, 1, 239),
    activities: { succeeded: 8, failed: 1, skipped: 2, reused: 0, unfinished: 0 },
    rowsWritten: 49,
    parentRunId: null,
    parentPipelineName: null,
    rerunOf: null,
    childRunCount: 0,
    annotations: ['etl', 'nightly'],
    cost: { totalCostEstimate: 0.25, complete: true },
    params: { secret: 'hunter2' },
  } as unknown as RunSummary;

  const byHeader = (r: RunSummary) =>
    Object.fromEntries(RUNS_EXPORT_COLUMNS.map((c, i) => [c.header, runExportRow(r)[i]]));

  it('writes machine values: ISO UTC times, ms durations, vocabulary keys', () => {
    expect(byHeader(run)).toMatchObject({
      run_id: 'run_1',
      pipeline: 'Orders',
      version: 3,
      status: 'success',
      triggered_by: 'schedule',
      started_at: '2026-10-04T12:00:00.005Z',
      finished_at: '2026-10-04T12:00:01.239Z',
      duration_ms: 1234,
      activities_failed: 1,
      rows_written: 49,
      annotations: 'etl; nightly',
      cost_usd: 0.25,
    });
  });

  it('has no start or duration for a queued run, whose startedAt is a placeholder', () => {
    const queued = { ...run, status: 'queued', queuedAt: run.startedAt, finishedAt: null };
    expect(byHeader(queued as RunSummary)).toMatchObject({
      queued_at: '2026-10-04T12:00:00.005Z',
      started_at: null,
      duration_ms: null,
    });
  });

  it('has no duration while a run is unfinished, and never exports params', () => {
    const running = { ...run, status: 'running', finishedAt: null } as RunSummary;
    expect(byHeader(running).duration_ms).toBeNull();
    expect(JSON.stringify(runExportRow(run))).not.toContain('hunter2');
  });
});
