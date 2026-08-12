import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { RunSummary } from '@autonomy-studio/shared';
import { RunTimeline } from './RunTimeline';

const noSpend = {
  totalCostEstimate: 0,
  responseCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  meteredCount: 0,
  unmeteredCount: 0,
};

function run(over: Partial<RunSummary> & Pick<RunSummary, 'id'>): RunSummary {
  return {
    ownerId: 'local',
    pipelineVersionId: 'pv_1',
    triggerId: null,
    parentRunId: null,
    params: {},
    status: 'success',
    leaseUntil: null,
    heartbeatAt: null,
    queuedAt: null,
    triggerContext: null,
    rerunOf: null,
    startedAt: 1_000,
    finishedAt: 2_000,
    pipelineId: 'pipe_a',
    pipelineName: 'Alpha',
    pipelineVersion: 1,
    triggerName: null,
    cost: noSpend,
    ...over,
  } as RunSummary;
}

function renderTimeline(runs: RunSummary[]) {
  return render(
    <MemoryRouter>
      <RunTimeline runs={runs} />
    </MemoryRouter>,
  );
}

/** The bars, in DOM order, as `[left, width]` percentage strings. */
function bars(container: HTMLElement): { left: string; width: string; open: boolean }[] {
  return [...container.querySelectorAll('.timeline-span')].map((el) => {
    const style = (el as HTMLElement).style;
    return { left: style.left, width: style.width, open: el.getAttribute('data-open') === 'true' };
  });
}

describe('U29 RunTimeline', () => {
  it('draws one lane per pipeline, named and attached to its list', () => {
    renderTimeline([
      run({ id: 'r1', pipelineId: 'pipe_a', pipelineName: 'Alpha', startedAt: 100 }),
      run({ id: 'r2', pipelineId: 'pipe_b', pipelineName: 'Beta', startedAt: 200 }),
    ]);
    const lanes = screen.getAllByRole('list');
    // The lane's accessible name comes from its own heading, which is the only
    // way a reader landing on a bar learns which pipeline it belongs to.
    expect(lanes.map((l) => l.getAttribute('aria-labelledby'))).toEqual([
      'run-timeline-group-pipe_a',
      'run-timeline-group-pipe_b',
    ]);
    expect(within(lanes[0] as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
  });

  /**
   * THE cross-run claim, at the rendered level: two lanes, ONE axis. `pipe_b`'s
   * run starts halfway through the window, so its bar must be offset — a
   * per-lane axis would put both bars at 0%.
   */
  it('places every lane against the same axis', () => {
    const { container } = renderTimeline([
      run({ id: 'r1', pipelineId: 'pipe_a', pipelineName: 'Alpha', startedAt: 0, finishedAt: 100 }),
      run({ id: 'r2', pipelineId: 'pipe_b', pipelineName: 'Beta', startedAt: 50, finishedAt: 100 }),
    ]);
    expect(bars(container)).toEqual([
      { left: '0%', width: '100%', open: false },
      { left: '50%', width: '50%', open: false },
    ]);
  });

  it('draws an unfinished run hatched to the right edge, claiming no length', () => {
    const { container } = renderTimeline([
      run({ id: 'r1', startedAt: 0, finishedAt: 100 }),
      run({ id: 'r2', status: 'running', startedAt: 100, finishedAt: null }),
    ]);
    const drawn = bars(container);
    expect(drawn[1]?.open).toBe(true);
    expect(drawn[1]?.width).toBe('');
    // …and the row says so in words rather than only in stripes.
    expect(screen.getByTitle(/no finish on record/)).toBeTruthy();
  });

  /**
   * Property 4. The bar is floored at 2px by the stylesheet, so on a wide axis
   * it is not the carrier of the value — the text beside it is.
   */
  it('states each run’s measured length as text beside the bar', () => {
    const { container } = renderTimeline([
      run({ id: 'r1', startedAt: 0, finishedAt: 5_000 }),
      run({ id: 'r2', startedAt: 0, finishedAt: 1 }),
    ]);
    const lengths = [...container.querySelectorAll('.run-timeline-length')].map(
      (el) => el.textContent,
    );
    expect(lengths).toEqual(['5s', '1ms']);
  });

  /**
   * The named list, and the reason it exists: a queued run's start stamp is its
   * ENQUEUE stamp, so plotting it would claim it had been running since then.
   */
  it('names a run it will not plot, instead of dropping it', () => {
    renderTimeline([
      run({ id: 'r1', startedAt: 0, finishedAt: 100 }),
      run({ id: 'r2', status: 'queued', pipelineName: 'Beta', finishedAt: null }),
    ]);
    const named = screen.getByRole('heading', { name: 'Not on the timeline' }).parentElement;
    expect(named?.textContent).toContain('enqueued');
    expect(named?.textContent).toContain('Beta');
    // And it is NOT a bar.
    expect(
      screen.getAllByRole('listitem').filter((li) => li.querySelector('.timeline-span')),
    ).toHaveLength(1);
  });

  it('says so plainly when nothing in view can be plotted at all', () => {
    renderTimeline([run({ id: 'r1', status: 'queued', finishedAt: null })]);
    expect(screen.getByText(/no run in view has a start this chart can believe/)).toBeTruthy();
    expect(screen.queryByText(/of measured wall clock/)).toBeNull();
  });

  it('links every bar to its run', () => {
    renderTimeline([run({ id: 'run_abc', pipelineVersion: 3 })]);
    const link = screen.getByTitle('run_abc');
    expect(link.getAttribute('href')).toBe('/monitor/runs/run_abc');
    expect(link.textContent).toContain('v3');
  });

  /**
   * A bar's colour is its only visual statement of outcome, and a status with no
   * tone renders as the stylesheet's default grey — a failure reported as
   * neutral. `palette.test.ts` pins the CSS side; this pins that the run's own
   * status is what selects it.
   */
  it('tones a bar by the RUN’s status', () => {
    const { container } = renderTimeline([
      run({ id: 'r1', status: 'failure', startedAt: 0, finishedAt: 10 }),
      run({ id: 'r2', status: 'interrupted', pipelineId: 'pipe_b', startedAt: 0, finishedAt: 10 }),
      run({ id: 'r3', status: 'success', pipelineId: 'pipe_c', startedAt: 0, finishedAt: 10 }),
    ]);
    expect(
      [...container.querySelectorAll('.timeline-span')].map((el) => el.getAttribute('data-tone')),
    ).toEqual(['failure', 'failure', 'success']);
  });
});
