import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import {
  CATALOG_VERSION,
  PipelineVersionSchema,
  type ActivityRun,
  type Run,
  type TriggerContext,
} from '@autonomy-studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { RunHeader, type RunHeaderNames } from './RunHeader';
import { RunFailureBanner } from './RunFailureBanner';
import { ActivityRunsTable } from './ActivityRunsTable';

const RUN: Run = {
  id: 'run_1',
  ownerId: 'local',
  pipelineVersionId: 'pv_1',
  triggerId: 'trg_1',
  parentRunId: null,
  params: {},
  status: 'success',
  leaseUntil: null,
  heartbeatAt: null,
  queuedAt: null,
  triggerContext: null,
  rerunOf: null,
  startedAt: Date.UTC(2026, 9, 4, 13, 0, 0, 0),
  finishedAt: Date.UTC(2026, 9, 4, 13, 2, 3, 0),
};

const NAMES: RunHeaderNames = {
  pipeline: 'Nightly load',
  trigger: 'Every night',
  debug: false,
  triggeredByKind: 'schedule',
  parentPipelineName: null,
};

const doc = (over: Record<string, unknown> = {}) =>
  PipelineVersionSchema.parse({
    id: 'pv_1',
    resourceId: 'res_1',
    pipelineId: 'pl_1',
    version: 3,
    params: [],
    outputs: [],
    nodes: [],
    edges: [],
    containers: [],
    catalogVersion: CATALOG_VERSION,
    createdAt: 0,
    ...over,
  });

function header(run: Run, over: Record<string, unknown> = {}) {
  render(
    <MemoryRouter>
      <RunHeader
        runId={run.id}
        run={run}
        doc={doc(over)}
        names={NAMES}
        status={run.status}
        statusPill={<span>success</span>}
        endedAt={run.finishedAt}
        counting={false}
        actions={<button type="button">Act</button>}
      />
    </MemoryRouter>,
  );
}

const fact = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;

describe('RunHeader (#1484 OR35 M2)', () => {
  it('names the exact version, what triggered the run, its timing and its id in one band', () => {
    header(RUN);
    expect(screen.getByRole('heading', { level: 2, name: 'Nightly load v3' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Nightly load' })).toHaveAttribute(
      'href',
      '/author/pipelines/pl_1?version=3',
    );
    expect(fact('Triggered by')?.textContent).toBe('Schedule · Every night');
    expect(screen.getByRole('link', { name: 'Every night' })).toHaveAttribute(
      'href',
      '/monitor/runs?trigger=trg_1',
    );
    expect(fact('Duration')?.textContent).toBe('2m 03s');
    expect(fact('Ended')?.textContent).toMatch(/:02:03\.000/);
    expect(fact('Run ID')?.querySelector('[title="run_1"]')).not.toBeNull();
    // Facts this run does not have are absent, not dashes.
    for (const absent of ['Scheduled', 'Parent', 'Rerun of', 'Source', 'Pipeline'])
      expect(screen.queryByText(absent, { selector: 'dt' })).toBeNull();
  });

  it('shows the scheduled occurrence and the git source when the run has them', () => {
    const triggerContext: TriggerContext = {
      triggerId: 'trg_1',
      scheduledTime: '2026-10-04T12:59:59.500Z',
      body: null,
    };
    header(
      { ...RUN, triggerContext },
      { sourceCommit: '0123456789abcdef', sourceBranch: 'main' },
    );
    expect(fact('Scheduled')?.textContent).toMatch(/:59:59\.500/);
    expect(fact('Source')?.textContent).toBe('main @ 0123456');
  });

  it('counts an unfinished run as "so far"', () => {
    header({ ...RUN, status: 'running', finishedAt: null });
    expect(fact('Duration')?.textContent).toMatch(/so far/);
  });
});

const failedRow = (over: Partial<ActivityRun> = {}): ActivityRun => ({
  key: 'copy#2',
  nodeId: 'copy',
  activityId: 'copy',
  attemptId: 'copy#2',
  attempt: 2,
  status: 'failure',
  reused: false,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  iteration: null,
  branch: null,
  rowsRead: null,
  rowsWritten: null,
  bytesRead: null,
  bytesWritten: null,
  childRunId: null,
  childRun: null,
  error: { message: 'database is locked\nat sqlite', kind: 'transient', code: null, connectionId: null },
  ...over,
});

describe('RunFailureBanner (#1484 OR35 M2)', () => {
  const banner = (failure: Parameters<typeof RunFailureBanner>[0]['failure']) => {
    const onShow = vi.fn();
    render(
      <MemoryRouter>
        <RunFailureBanner
          failure={failure}
          nameOf={(id) => ({ copy: 'Copy Data 1', loop: 'Until 1' })[id] ?? null}
          versionHref="/author/pipelines/pl_1?version=3"
          onShowActivity={onShow}
        />
      </MemoryRouter>,
    );
    return onShow;
  };

  it('names the failed activity, its kind, its attempt and its error, with the way to both', async () => {
    const row = failedRow();
    const onShow = banner({ kind: 'activity', nodeId: 'copy', activityId: 'copy', row });
    const group = screen.getByRole('group', { name: 'Failure' });
    expect(group).toHaveTextContent('Failed: Copy Data 1');
    expect(group).toHaveTextContent('transient');
    expect(group).toHaveTextContent('attempt 2');
    // The first line is the summary; the whole error opens beneath it.
    expect(screen.getByText('database is locked', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
      'href',
      '/author/pipelines/pl_1?version=3',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show activity' }));
    expect(onShow).toHaveBeenCalledWith('copy#2');
  });

  it('says a container failed on its own, with no row to show', () => {
    banner({ kind: 'container', containerId: 'loop', reason: 'timeout' });
    expect(screen.getByRole('group', { name: 'Failure' })).toHaveTextContent('Failed: Until 1 · timeout');
    expect(screen.queryByRole('button', { name: 'Show activity' })).toBeNull();
  });

  it('a run-level failure states the engine’s reason', () => {
    banner({ kind: 'run', reason: 'stalled' });
    expect(screen.getByRole('group', { name: 'Failure' })).toHaveTextContent('Run failed · stalled');
  });
});

describe('ActivityRunsTable — the row "Show activity" asked for', () => {
  it('marks it current and gives it focus', () => {
    const rows = [failedRow({ key: 'a', nodeId: 'a', activityId: 'a' }), failedRow()];
    render(
      <MemoryRouter>
        <ActivityRunsTable
          rows={rows}
          error={null}
          runStatus="failure"
          nameOf={() => null}
          typeOf={() => null}
          selected={{ key: 'copy#2' }}
        />
      </MemoryRouter>,
    );
    const current = document.querySelector('tr[aria-current="true"]');
    expect(current?.getAttribute('data-activity-id')).toBe('copy');
    expect(document.querySelectorAll('tr[aria-current]')).toHaveLength(1);
    expect(document.activeElement).toBe(current);
  });
});
