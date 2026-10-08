import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { ActivityRun, ActivityRunGroup } from '@autonomy-studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityRunsTable } from './ActivityRunsTable';
import { ACTIVITY_RUN_COLUMNS, iterationText } from './activityRunsColumns';
import { nodeStatusLabel } from './nodeStatus';
import { activityRun } from '../../testing/activityRun';

const BASE: ActivityRun = activityRun({
  key: 'a#0',
  attemptId: 'a#0',
  attempt: 1,
  startedAt: Date.UTC(2026, 9, 4, 13, 5, 7, 123),
  finishedAt: Date.UTC(2026, 9, 4, 13, 5, 8, 357),
  durationMs: 1234,
});

function show(rows: ActivityRun[] | null, error: string | null = null, url = '/') {
  render(
    <MemoryRouter initialEntries={[url]}>
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
      Bytes: '4,096 data bytes read',
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
        childRun: {
          id: 'run_child',
          pipelineName: 'Load orders',
          status: 'success',
          startedAt: 10_000,
          finishedAt: 12_500,
        },
      },
      { ...BASE, key: 'b#0', childRunId: 'run_gone', childRun: null },
      {
        ...BASE,
        key: 'c#0',
        childRunId: 'run_queued',
        childRun: {
          id: 'run_queued',
          pipelineName: 'Later',
          status: 'queued',
          startedAt: 10_000,
          finishedAt: null,
        },
      },
    ]);
    expect(screen.getByRole('link', { name: 'Load orders' }).getAttribute('href')).toBe(
      '/monitor/runs/run_child',
    );
    // The called run's status and how long it took, from its own row.
    expect(cellsOf(screen.getAllByRole('row')[1]!)['Child run']).toBe(
      'Load orders · success · 2.5s',
    );
    expect(cellsOf(screen.getAllByRole('row')[2]!)['Child run']).toBe('run_gone');
    // A queued child has not started: its start is the enqueue placeholder.
    expect(cellsOf(screen.getAllByRole('row')[3]!)['Child run']).toBe('Later · queued (slot)');
  });

  it("counts a running called run's duration up only while the page is live", async () => {
    vi.useFakeTimers();
    try {
      const running = (live: boolean) => (
        <MemoryRouter>
          <ActivityRunsTable
            rows={[
              {
                ...BASE,
                childRunId: 'run_child',
                childRun: {
                  id: 'run_child',
                  pipelineName: 'Load orders',
                  status: 'running',
                  startedAt: Date.now() - 2_000,
                  finishedAt: null,
                },
              },
            ]}
            groups={[]}
            error={null}
            runStatus="running"
            nameOf={() => null}
            typeOf={() => null}
            containerNameOf={() => null}
            live={live}
          />
        </MemoryRouter>
      );
      const childCell = () => cellsOf(screen.getAllByRole('row')[1]!)['Child run'];
      const view = render(running(false));
      const frozen = childCell();
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(childCell()).toBe(frozen);
      view.rerender(running(true));
      const live = childCell();
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(childCell()).not.toBe(live);
    } finally {
      vi.useRealTimers();
    }
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

describe('#1484 M2 ActivityRunsTable — filter and sort', () => {
  const ROWS: ActivityRun[] = [
    { ...BASE, key: 'a#0', durationMs: 100 },
    {
      ...BASE,
      key: 'w#0',
      nodeId: 'w',
      activityId: 'w',
      attemptId: 'w#0',
      status: 'failure',
      durationMs: 900,
      error: { message: 'connect ECONNREFUSED', kind: 'transient', code: null, connectionId: null },
    },
    { ...BASE, key: 'a#1', attemptId: 'a#1', attempt: 2, durationMs: 400 },
  ];
  const bodyKeys = () =>
    screen
      .getAllByRole('row')
      .slice(1)
      .map((tr) => `${tr.dataset.activityId}:${within(tr).getAllByRole('cell')[6]?.textContent}`);

  it('filters to a status chosen from the statuses the run has', () => {
    show(ROWS);
    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(
      within(status)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([
      'All statuses',
      nodeStatusLabel('success', 'failure'),
      nodeStatusLabel('failure', 'failure'),
    ]);
    fireEvent.change(status, { target: { value: 'failure' } });
    expect(bodyKeys()).toEqual(['w:1']);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(bodyKeys()).toHaveLength(3);
  });

  it('reads its filters from the URL', () => {
    show(ROWS, null, '/?arType=Copy');
    expect(bodyKeys()).toEqual(['a:1', 'a:2']);
  });

  it('says when nothing matches, and Clear brings the rows back', () => {
    show(ROWS, null, '/?arQ=nothing-like-this');
    expect(screen.getByText('No matches.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(bodyKeys()).toHaveLength(3);
  });

  it('searches what it shows, once typing stops', async () => {
    vi.useFakeTimers();
    try {
      show(ROWS);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search activity runs' }), {
        target: { value: 'econnrefused' },
      });
      expect(bodyKeys()).toHaveLength(3);
      await act(async () => vi.advanceTimersByTimeAsync(300));
      expect(bodyKeys()).toEqual(['w:1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sorts by a header: natural direction, flipped, then run order again', () => {
    show(ROWS);
    const header = () => screen.getByRole('columnheader', { name: /Duration/ });
    fireEvent.click(within(header()).getByRole('button'));
    expect(header()).toHaveAttribute('aria-sort', 'descending');
    expect(bodyKeys()).toEqual(['w:1', 'a:2', 'a:1']);
    fireEvent.click(within(header()).getByRole('button'));
    expect(header()).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyKeys()).toEqual(['a:1', 'a:2', 'w:1']);
    fireEvent.click(within(header()).getByRole('button'));
    expect(header()).not.toHaveAttribute('aria-sort');
    expect(bodyKeys()).toEqual(['a:1', 'w:1', 'a:2']);
  });
});

describe('iterationText', () => {
  it('counts from 1, and a loop has no total', () => {
    expect(iterationText({ containerId: 'l', index: 0, count: null, item: null })).toBe('1');
    expect(iterationText({ containerId: 'f', index: 2, count: 5, item: null })).toBe('3 of 5');
  });
});

describe('#1484 M2 ActivityRunsTable — container groups', () => {
  /* jsdom has no `scrollIntoView`; record the rows an ask scrolled to. */
  let scrolled: Element[] = [];
  const scrolledTo = () => scrolled;
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
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

  const table = (
    selected: { key: string } | null = null,
    group: ActivityRunGroup = GROUP,
    url = '/',
  ) => (
    <MemoryRouter initialEntries={[url]}>
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

  it('opens the group and item an asked-for row is in, and scrolls to it', () => {
    const view = showGroups();
    fireEvent.click(screen.getByRole('button', { name: /ForEach 1/ }));
    expect(bodyRows()).toHaveLength(1);

    view.rerender(table({ key: 'w#1' }));
    expect(bodyRows()).toHaveLength(5);
    const current = bodyRows().find((tr) => tr.getAttribute('aria-current') === 'true');
    expect(current?.dataset.activityId).toBe('w');
    expect(scrolledTo()).toEqual([current]);
    // Focus stays with the asker: the drawer the ask opens takes it.
    expect(current).not.toHaveFocus();
  });

  it('keeps the group and item lines a matching row sits under', () => {
    render(table(null, GROUP, '/?arQ=b.csv'));
    expect(bodyRows().map((tr) => tr.className || tr.dataset.activityId)).toEqual([
      'activity-runs__group',
      'activity-runs__iteration',
      'w',
    ]);
  });

  it('sorts into one list that says which container each row ran in', () => {
    render(table(null, GROUP, '/?arSort=activity'));
    expect(bodyRows().map((tr) => within(tr).getAllByRole('cell')[0]?.textContent)).toEqual([
      'HTTP Request 1 · in ForEach 1',
      'HTTP Request 1 · in ForEach 1',
    ]);
  });

  it('drops a filter that hides the row the banner asked for', () => {
    const view = render(table(null, GROUP, '/?arStatus=failure'));
    expect(screen.getByText('No matches.')).toBeInTheDocument();
    view.rerender(table({ key: 'w#1' }, GROUP, '/?arStatus=failure'));
    const current = bodyRows().find((tr) => tr.getAttribute('aria-current') === 'true');
    expect(current?.dataset.activityId).toBe('w');
    expect(scrolledTo()).toEqual([current]);
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
  });

  it('answers an ask once: a filter set afterwards stands, even one that hides the row', async () => {
    vi.useFakeTimers();
    try {
      // One ask, as the page holds it across renders; a new object is a new ask.
      const ask = { key: 'w#1' };
      const view = render(table(ask));
      expect(scrolledTo()).toEqual([
        bodyRows().find((tr) => tr.getAttribute('aria-current') === 'true'),
      ]);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search activity runs' }), {
        target: { value: 'a.csv' },
      });
      await act(async () => vi.advanceTimersByTimeAsync(300));
      view.rerender(table(ask));
      await act(async () => vi.advanceTimersByTimeAsync(300));
      // Item 1 (`a.csv`) is shown; the asked-for row, in item 2, stays filtered out.
      expect(bodyRows().some((tr) => tr.getAttribute('aria-current') === 'true')).toBe(false);
      expect(screen.getByRole('searchbox', { name: 'Search activity runs' })).toHaveValue('a.csv');
    } finally {
      vi.useRealTimers();
    }
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
    expect(current).toBeDefined();
    expect(scrolledTo()).toEqual([current]);
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

describe('#1484 M2 ActivityRunsTable — a running row says how it is going', () => {
  const runningRow: ActivityRun = {
    ...BASE,
    status: 'dispatched',
    finishedAt: null,
    durationMs: null,
  };

  function showRunning(
    rows: ActivityRun[],
    latestOutputs: ReadonlyMap<string, { name: string; value: unknown }>,
    live = false,
  ) {
    return (
      <MemoryRouter>
        <ActivityRunsTable
          rows={rows}
          groups={[]}
          error={null}
          runStatus="running"
          nameOf={() => null}
          typeOf={() => null}
          containerNameOf={() => null}
          live={live}
          latestOutputs={latestOutputs}
        />
      </MemoryRouter>
    );
  }

  it("shows a running attempt's latest streamed value, and only that attempt's (#1299)", () => {
    render(
      showRunning(
        [runningRow, { ...runningRow, key: 'a#1', attemptId: 'a#1' }],
        new Map([['a#1', { name: 'rowsWritten', value: 1200 }]]),
      ),
    );
    const [first, second] = screen.getAllByRole('row').slice(1);
    expect(cellsOf(first!).Status).not.toContain('rowsWritten');
    expect(cellsOf(second!).Status).toContain('rowsWritten: 1200');
  });

  it('says a secure attempt’s output is withheld rather than printing the marker (#1312)', () => {
    render(
      showRunning(
        [runningRow],
        new Map([['a#0', { name: '[redacted: secure]', value: '[redacted: secure]' }]]),
      ),
    );
    const status = cellsOf(screen.getAllByRole('row')[1]!).Status;
    expect(status).toContain('output withheld: this node is secure');
    expect(status).not.toContain('[redacted: secure]');
  });

  it('says nothing streamed once the attempt has settled — its outputs are the truth', () => {
    render(showRunning([BASE], new Map([['a#0', { name: 'rowsWritten', value: 1200 }]])));
    expect(cellsOf(screen.getAllByRole('row')[1]!).Status).not.toContain('rowsWritten');
  });

  it("counts a running attempt's duration up only while the page is live (#890)", async () => {
    vi.useFakeTimers();
    try {
      const rows = [{ ...runningRow, startedAt: Date.now() - 2_000 }];
      const duration = () => cellsOf(screen.getAllByRole('row')[1]!).Duration;
      const view = render(showRunning(rows, new Map()));
      expect(duration()).toBe('');
      view.rerender(showRunning(rows, new Map(), true));
      const before = duration();
      expect(before).toMatch(/so far/);
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      expect(duration()).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('#1557 ActivityRunsTable — rows from the run log alone', () => {
  const showBased = (basis?: 'version' | 'log') =>
    render(
      <MemoryRouter>
        <ActivityRunsTable
          rows={[BASE]}
          groups={[]}
          {...(basis === undefined ? {} : { basis })}
          error={null}
          runStatus="failure"
          nameOf={() => null}
          typeOf={() => null}
          containerNameOf={() => null}
        />
      </MemoryRouter>,
    );

  it('says the version is unavailable, with what is missing behind ?', () => {
    showBased('log');
    expect(screen.getByText('Rows from the run log only')).toBeVisible();
    fireEvent.click(screen.getByTitle('About rows from the run log'));
    expect(screen.getByRole('note')).toHaveTextContent(
      /Containers, ForEach items, skipped activities, retry numbers and the activities a rerun reused inside a container are missing/,
    );
    // The rows are still the table.
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('says nothing of it for the full account', () => {
    showBased('version');
    expect(screen.queryByText(/Rows from the run log only/)).toBeNull();
    showBased();
    expect(screen.queryByText(/Rows from the run log only/)).toBeNull();
  });
});
