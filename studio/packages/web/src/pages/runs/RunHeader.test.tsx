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
import { activityRun } from '../../testing/activityRun';

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
  parentActivity: null,
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

function header(run: Run, over: Record<string, unknown> = {}, names: RunHeaderNames = NAMES) {
  render(
    <MemoryRouter>
      <RunHeader
        runId={run.id}
        run={run}
        doc={doc(over)}
        names={names}
        status={run.status}
        startedAt={run.startedAt}
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
  it("a debug run's editor icon opens the pipeline, with no version to preview (#1566)", () => {
    header(RUN, {}, { ...NAMES, debug: true });
    expect(screen.getByRole('link', { name: 'Open the pipeline in the editor' })).toHaveAttribute(
      'href',
      '/author/pipelines/pl_1',
    );
  });

  it('names the exact version, what triggered the run, its timing and its id in one band', () => {
    header(RUN);
    expect(screen.getByRole('heading', { level: 2, name: 'Nightly load v3' })).toBeInTheDocument();
    // #1566 — the name is this page's subject, not a way out of it; the editor
    // is the labelled icon, at the version that ran.
    expect(screen.queryByRole('link', { name: 'Nightly load' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Open v3 in the editor' })).toHaveAttribute(
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

  it("#1569 — the pipeline's name hovers with the bound version's description", () => {
    header(RUN, { description: 'Loads the nightly extract' });
    expect(screen.getByText('Nightly load', { selector: 'span' })).toHaveAttribute(
      'title',
      'Loads the nightly extract',
    );
    // The heading's name is still the pipeline and version, not the hover.
    expect(screen.getByRole('heading', { level: 2, name: 'Nightly load v3' })).toBeInTheDocument();
  });

  it('#1569 — no description, no hover', () => {
    header(RUN);
    expect(screen.getByText('Nightly load', { selector: 'span' })).not.toHaveAttribute('title');
  });

  it('shows the scheduled occurrence and the git source when the run has them', () => {
    const triggerContext: TriggerContext = {
      triggerId: 'trg_1',
      scheduledTime: '2026-10-04T12:59:59.500Z',
      body: null,
    };
    header({ ...RUN, triggerContext }, { sourceCommit: '0123456789abcdef', sourceBranch: 'main' });
    expect(fact('Scheduled')?.textContent).toMatch(/:59:59\.500/);
    expect(fact('Source')?.textContent).toBe('main @ 0123456');
  });

  it('#1541 — a called run names its parent pipeline and the activity that called it', () => {
    header(
      { ...RUN, parentRunId: 'run_parent_1' },
      {},
      {
        ...NAMES,
        triggeredByKind: 'call',
        parentPipelineName: 'Orchestrate',
        parentActivity: 'Execute pipeline 2',
      },
    );
    expect(fact('Parent')).toHaveTextContent(/^Orchestrate · Execute pipeline 2$/);
    expect(screen.getByRole('link', { name: 'Orchestrate' })).toHaveAttribute(
      'href',
      '/monitor/runs/run_parent_1',
    );
  });

  it('#1541 — a parent whose caller is not known is named by its pipeline alone', () => {
    header(
      { ...RUN, parentRunId: 'run_parent_1' },
      {},
      { ...NAMES, parentPipelineName: 'Orchestrate' },
    );
    expect(fact('Parent')).toHaveTextContent(/^Orchestrate$/);
  });

  it("#1541 — Rerun of names the source run's pipeline beside its id", () => {
    header({ ...RUN, rerunOf: 'run_source_12345678' });
    expect(fact('Rerun of')).toHaveTextContent(/^Nightly load · 12345678$/);
    expect(screen.getByRole('link', { name: 'Source run run_source_12345678' })).toBeVisible();
  });

  it('a trigger deleted since the run leaves its kind and no link', () => {
    header({ ...RUN, triggerId: null });
    expect(fact('Triggered by')?.textContent).toBe('Schedule');
    expect(screen.queryByRole('link', { name: 'Every night' })).toBeNull();
  });

  it('counts an unfinished run as "so far"', () => {
    header({ ...RUN, status: 'running', finishedAt: null });
    expect(fact('Duration')?.textContent).toMatch(/so far/);
  });
});

const failedRow = (over: Partial<ActivityRun> = {}): ActivityRun =>
  activityRun({
    key: 'copy#2',
    nodeId: 'copy',
    activityId: 'copy',
    attemptId: 'copy#2',
    attempt: 2,
    status: 'failure',
    error: {
      message: 'database is locked\nat sqlite',
      kind: 'transient',
      code: null,
      connectionId: null,
    },
    ...over,
  });

describe('RunFailureBanner (#1484 OR35 M2)', () => {
  const banner = (failure: Parameters<typeof RunFailureBanner>[0]['failure']) => {
    const onShow = vi.fn();
    render(
      <MemoryRouter>
        <RunFailureBanner
          failure={failure}
          nameOf={(id) => ({ copy: 'Copy data 1', loop: 'Until 1' })[id] ?? null}
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
    expect(group).toHaveTextContent('Failed: Copy data 1');
    expect(group).toHaveTextContent('transient');
    expect(group).toHaveTextContent('attempt 2');
    // The first line is the summary; the whole error opens beneath it.
    expect(screen.getByText('database is locked', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
      'href',
      '/author/pipelines/pl_1?version=3',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show activity' }));
    // With the button, so the drawer it opens can hand focus back to it.
    expect(onShow).toHaveBeenCalledWith(
      'copy#2',
      screen.getByRole('button', { name: 'Show activity' }),
    );
  });

  it('says a container failed on its own, with no row to show', () => {
    banner({ kind: 'container', containerId: 'loop', reason: 'timeout' });
    expect(screen.getByRole('group', { name: 'Failure' })).toHaveTextContent(
      'Failed: Until 1 · timeout',
    );
    expect(screen.queryByRole('button', { name: 'Show activity' })).toBeNull();
  });

  it('a run-level failure states the engine’s reason', () => {
    banner({ kind: 'run', reason: 'stalled' });
    expect(screen.getByRole('group', { name: 'Failure' })).toHaveTextContent(
      'Run failed · stalled',
    );
  });
});

describe('ActivityRunsTable — the row "Show activity" asked for', () => {
  it('marks it current and scrolls to it, leaving focus with the asker', () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const rows = [failedRow({ key: 'a', nodeId: 'a', activityId: 'a' }), failedRow()];
      render(
        <MemoryRouter>
          <ActivityRunsTable
            rows={rows}
            groups={[]}
            error={null}
            runStatus="failure"
            nameOf={() => null}
            typeOf={() => null}
            containerNameOf={() => null}
            selected={{ key: 'copy#2' }}
          />
        </MemoryRouter>,
      );
      const current = document.querySelector('tr[aria-current="true"]');
      expect(current?.getAttribute('data-activity-id')).toBe('copy');
      expect(document.querySelectorAll('tr[aria-current]')).toHaveLength(1);
      expect(scrolled).toEqual([current]);
      expect(document.activeElement).not.toBe(current);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});
