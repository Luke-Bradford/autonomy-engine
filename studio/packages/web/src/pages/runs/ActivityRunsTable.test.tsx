import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ActivityRun, ActivityRunGroup } from '@autonomy-studio/shared';
import { describe, expect, it } from 'vitest';
import { ActivityRunsTable } from './ActivityRunsTable';
import { ACTIVITY_RUN_COLUMNS, iterationText } from './activityRunsColumns';

const BASE: ActivityRun = {
  key: 'a#0',
  nodeId: 'a',
  activityId: 'a',
  containerId: null,
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
  skipReason: null,
};

function show(rows: ActivityRun[] | null, error: string | null = null) {
  render(
    <MemoryRouter>
      <ActivityRunsTable
        rows={rows}
        groups={[]}
        error={error}
        runStatus="failure"
        nameOf={(id) => ({ a: 'Copy 1', w: 'HTTP Request 1' })[id] ?? null}
        typeOf={(id) => ({ a: 'Copy', w: 'HTTP Request' })[id] ?? null}
        containerNameOf={() => null}
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

  it('says why a skipped row was skipped, after its status', () => {
    show([
      {
        ...BASE,
        key: 'skip:w:1',
        nodeId: 'w',
        activityId: 'w',
        attemptId: null,
        attempt: null,
        status: 'skipped',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        skipReason: { kind: 'upstream', from: 'a', outcome: 'failure' },
      },
      { ...BASE, key: 'skip:a:2', status: 'skipped', skipReason: null },
    ]);
    const [why, bare] = screen.getAllByRole('row').slice(1);
    expect(cellsOf(why!).Status).toBe('skipped · upstream failed: Copy 1');
    // A skip the read model could not give a reason for is just skipped.
    expect(cellsOf(bare!).Status).toBe('skipped');
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

describe('#1484 M2 ActivityRunsTable — container groups', () => {
  const GROUP: ActivityRunGroup = {
    containerId: 'fe',
    kind: 'foreach',
    status: 'failure',
    reason: 'child_failed:w@1',
    skipReason: null,
    reused: false,
    startedAt: BASE.startedAt,
    finishedAt: BASE.finishedAt,
    durationMs: 1234,
    itemCount: 2,
    iterations: [
      {
        index: 0,
        count: 2,
        item: 'a.csv',
        status: 'success',
        startedAt: null,
        finishedAt: null,
        durationMs: 5,
      },
      {
        index: 1,
        count: 2,
        item: 'b.csv',
        status: 'failure',
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      },
    ],
    position: 0,
  };
  const item = (index: number): ActivityRun => ({
    ...BASE,
    key: `w#${index}`,
    nodeId: `w@${index}`,
    activityId: 'w',
    containerId: 'fe',
    iteration: { containerId: 'fe', index, count: 2, item: index === 0 ? 'a.csv' : 'b.csv' },
  });

  const table = (selected: { key: string } | null = null, group: ActivityRunGroup = GROUP) => (
    <MemoryRouter>
      <ActivityRunsTable
        rows={[item(0), item(1)]}
        groups={[group]}
        error={null}
        runStatus="failure"
        nameOf={(id) => ({ w: 'HTTP Request 1' })[id] ?? null}
        typeOf={() => null}
        containerNameOf={(id) => ({ fe: 'ForEach 1' })[id] ?? null}
        selected={selected}
      />
    </MemoryRouter>
  );
  const showGroups = (group: ActivityRunGroup = GROUP) => render(table(null, group));

  it('says why a skipped container was skipped, after its status', () => {
    showGroups({
      ...GROUP,
      status: 'skipped',
      reason: null,
      skipReason: { kind: 'upstream', from: 'w', outcome: 'failure' },
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      itemCount: null,
      iterations: [],
    });
    expect(cellsOf(screen.getAllByRole('row')[1]!).Status).toBe(
      'skipped · upstream failed: HTTP Request 1',
    );
  });

  it('names a container that caused a skip by its container name', () => {
    render(
      <MemoryRouter>
        <ActivityRunsTable
          rows={[
            {
              ...item(0),
              containerId: null,
              iteration: null,
              status: 'skipped',
              skipReason: { kind: 'timeout', containerId: 'fe' },
            },
          ]}
          groups={[]}
          error={null}
          runStatus="failure"
          nameOf={() => null}
          typeOf={() => null}
          containerNameOf={(id) => ({ fe: 'ForEach 1' })[id] ?? null}
        />
      </MemoryRouter>,
    );
    expect(cellsOf(screen.getAllByRole('row')[1]!).Status).toBe(
      'skipped · loop timed out: ForEach 1',
    );
  });
  const bodyRows = () => screen.getAllByRole('row').slice(1);

  it('heads its rows with the container, then a line per item', () => {
    showGroups();
    const [g, i0, r0, i1, r1] = bodyRows();
    expect(within(g!).getByRole('button', { name: 'ForEach 1' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(cellsOf(g!)).toMatchObject({
      Type: 'ForEach',
      Status: 'failure',
      Duration: '1.234s',
      Iteration: '2 items',
      Error: 'child_failed:w@1',
    });
    expect(within(i0!).getByRole('button', { name: 'Item 1 of 2 · a.csv' })).toBeVisible();
    expect(cellsOf(i0!).Status).toBe('success');
    expect(within(i1!).getByRole('button', { name: 'Item 2 of 2 · b.csv' })).toBeVisible();
    expect(cellsOf(i1!).Status).toBe('failure');
    expect(r0!.dataset.activityId).toBe('w');
    expect(r0!.dataset.depth).toBe('2');
    expect(cellsOf(r1!).Iteration).toBe('2 of 2 · b.csv');
    // Every line has a cell under every column.
    for (const tr of bodyRows())
      expect(within(tr).getAllByRole('cell')).toHaveLength(ACTIVITY_RUN_COLUMNS.length);
  });

  it('collapses a group or an item to its own line, and opens it again', () => {
    showGroups();
    fireEvent.click(screen.getByRole('button', { name: /Item 1 of 2/ }));
    expect(bodyRows()).toHaveLength(4);
    expect(screen.getByRole('button', { name: /Item 1 of 2/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    const container = screen.getByRole('button', { name: /ForEach 1/ });
    fireEvent.click(container);
    expect(bodyRows()).toHaveLength(1);
    expect(container).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(container);
    // The item collapsed before stays collapsed.
    expect(bodyRows()).toHaveLength(4);
  });

  it('opens the group and item an asked-for row is in, and focuses it', () => {
    const view = showGroups();
    fireEvent.click(screen.getByRole('button', { name: /ForEach 1/ }));
    expect(bodyRows()).toHaveLength(1);

    view.rerender(table({ key: 'w#1' }));
    expect(bodyRows()).toHaveLength(5);
    const current = bodyRows().find((tr) => tr.getAttribute('aria-current') === 'true');
    expect(current?.dataset.activityId).toBe('w');
    expect(current).toHaveFocus();
  });

  it('shows a group whose activities never ran', () => {
    render(
      <MemoryRouter>
        <ActivityRunsTable
          rows={[]}
          groups={[
            {
              ...GROUP,
              status: 'skipped',
              reason: null,
              skipReason: null,
              startedAt: null,
              finishedAt: null,
              iterations: [],
            },
          ]}
          error={null}
          runStatus="failure"
          nameOf={() => null}
          typeOf={() => null}
          containerNameOf={() => null}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'fe' })).toBeVisible();
    expect(cellsOf(bodyRows()[0]!).Status).toBe('skipped');
  });

  it('opens a collapsed item an asked-for row is in, leaving the group as it was', () => {
    const view = showGroups();
    fireEvent.click(screen.getByRole('button', { name: /Item 2 of 2/ }));
    expect(bodyRows()).toHaveLength(4);

    view.rerender(table({ key: 'w#1' }));
    expect(bodyRows()).toHaveLength(5);
    expect(screen.getByRole('button', { name: /Item 2 of 2/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('waits for an asked-for row the table has not read yet', () => {
    // The same ask throughout: only the rows change.
    const ask = { key: 'w#9' };
    const view = render(table(ask));
    expect(bodyRows().some((tr) => tr.getAttribute('aria-current') === 'true')).toBe(false);
    view.rerender(
      <MemoryRouter>
        <ActivityRunsTable
          rows={[item(0), item(1), { ...item(1), key: 'w#9' }]}
          groups={[GROUP]}
          error={null}
          runStatus="failure"
          nameOf={() => null}
          typeOf={() => null}
          containerNameOf={() => null}
          selected={ask}
        />
      </MemoryRouter>,
    );
    const current = bodyRows().find((tr) => tr.getAttribute('aria-current') === 'true');
    expect(current).toHaveFocus();
  });

  it('labels an Until by its rounds', () => {
    showGroups({
      ...GROUP,
      kind: 'loop',
      itemCount: null,
      iterations: GROUP.iterations.map((it) => ({ ...it, count: null, item: null })),
    });
    expect(cellsOf(bodyRows()[0]!)).toMatchObject({ Type: 'Until', Iteration: '2 rounds' });
    expect(screen.getByRole('button', { name: 'Round 1' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Round 2' })).toBeVisible();
  });
});
