import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ActivityRun } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { ActivityRunsTable } from './ActivityRunsTable';
import { ACTIVITY_RUN_COLUMNS, iterationText } from './activityRunsColumns';

const BASE: ActivityRun = {
  key: 'a#0',
  nodeId: 'a',
  activityId: 'a',
  attemptId: 'a#0',
  attempt: 1,
  status: 'success',
  reused: false,
  startedAt: Date.UTC(2026, 9, 4, 13, 5, 7, 123),
  finishedAt: Date.UTC(2026, 9, 4, 13, 5, 8, 357),
  durationMs: 1234,
  iteration: null,
  branch: null,
  rowsRead: null,
  rowsWritten: null,
  bytesRead: null,
  bytesWritten: null,
  childRunId: null,
  childRun: null,
  error: null,
};

function show(rows: ActivityRun[] | null, error: string | null = null) {
  render(
    <MemoryRouter>
      <ActivityRunsTable
        rows={rows}
        error={error}
        runStatus="failure"
        nameOf={(id) => ({ a: 'Copy 1', w: 'HTTP Request 1' })[id] ?? null}
        typeOf={(id) => ({ a: 'Copy', w: 'HTTP Request' })[id] ?? null}
      />
    </MemoryRouter>,
  );
}

/** The row's cells, keyed by column header. */
function cellsOf(row: HTMLElement): Record<string, string> {
  const cells = within(row).getAllByRole('cell');
  return Object.fromEntries(ACTIVITY_RUN_COLUMNS.map((c, i) => [c, cells[i]?.textContent ?? '']));
}

describe('#1484 M2 ActivityRunsTable', () => {
  it('lists every column, in order', () => {
    show([BASE]);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      ...ACTIVITY_RUN_COLUMNS,
    ]);
  });

  it('names the activity and its type, and times it to the millisecond', () => {
    show([{ ...BASE, rowsRead: 49, rowsWritten: 1200, bytesRead: 4096 }]);
    const cells = cellsOf(screen.getAllByRole('row')[1]!);
    expect(cells).toMatchObject({
      Activity: 'Copy 1',
      Type: 'Copy',
      Duration: '1.234s',
      Attempt: '1',
      'Rows read': '49',
      'Rows written': '1,200',
      Bytes: '4,096 read',
    });
    expect(cells.Start).toMatch(/^\d\d:\d\d:07\.123$/);
    expect(cells.End).toMatch(/^\d\d:\d\d:08\.357$/);
  });

  it("states an item's place in its ForEach, the branch taken, and a failure with its class", () => {
    show([
      {
        ...BASE,
        key: 'w@1#0',
        nodeId: 'w@1',
        activityId: 'w',
        attempt: 2,
        status: 'failure',
        iteration: { containerId: 'fe', index: 1, count: 2, item: 'orders.csv' },
        branch: 'true',
        error: {
          message: 'HTTP 503\nretry later',
          kind: 'transient',
          code: null,
          connectionId: null,
        },
      },
    ]);
    const cells = cellsOf(screen.getAllByRole('row')[1]!);
    expect(cells).toMatchObject({
      Activity: 'HTTP Request 1',
      Status: 'failure',
      Attempt: '2',
      Iteration: '2 of 2 · orders.csv',
      Branch: 'true',
      Error: 'HTTP 503 (transient)',
    });
  });

  it('links a called run by its pipeline name, and keeps a bare id it cannot resolve', () => {
    show([
      {
        ...BASE,
        childRunId: 'run_child',
        childRun: { id: 'run_child', pipelineName: 'Load orders', status: 'success' },
      },
      { ...BASE, key: 'b#0', childRunId: 'run_gone', childRun: null },
    ]);
    expect(screen.getByRole('link', { name: 'Load orders' }).getAttribute('href')).toBe(
      '/monitor/runs/run_child',
    );
    expect(cellsOf(screen.getAllByRole('row')[2]!)['Child run']).toBe('run_gone');
  });

  it('marks what a rerun reused, and leaves its times empty', () => {
    show([
      {
        ...BASE,
        key: 'reused:a',
        reused: true,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      },
    ]);
    expect(cellsOf(screen.getAllByRole('row')[1]!)).toMatchObject({
      Status: 'reused',
      Start: '—',
      Duration: '',
    });
  });

  it('keeps the rows it has when a re-read fails, and says so', () => {
    show([BASE], 'HTTP 500');
    expect(screen.getByRole('alert').textContent).toContain('HTTP 500');
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });
});

describe('iterationText', () => {
  it('counts from 1, and a loop has no total', () => {
    expect(iterationText({ containerId: 'l', index: 0, count: null, item: null })).toBe('1');
    expect(iterationText({ containerId: 'f', index: 2, count: 5, item: null })).toBe('3 of 5');
  });
});
