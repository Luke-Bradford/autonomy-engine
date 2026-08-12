import { describe, expect, it } from 'vitest';
import { RunStatusSchema, type RunStatus, type RunSummary } from '@autonomy-studio/shared';
import { groupRunsByPipeline, toRunBar, unplottableReason } from './runBars';

function run(over: Partial<RunSummary> & Pick<RunSummary, 'id'>): RunSummary {
  return {
    ownerId: 'local',
    pipelineVersionId: 'ver_1',
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
    pipelineName: 'A',
    pipelineVersion: 1,
    triggerName: null,
    cost: {
      totalCostEstimate: 0,
      responseCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      meteredCount: 0,
      unmeteredCount: 0,
    },
    ...over,
  } as RunSummary;
}

describe('U29 unplottableReason', () => {
  /**
   * The whole point of the named list: a row the chart refuses to draw is still
   * ACCOUNTED for. This asserts the classification is total — every status gets
   * a verdict — which is the property that stops a ninth `RunStatus` from
   * silently defaulting into "plottable" and onto the axis.
   */
  it('reaches a verdict for every DB run status', () => {
    for (const status of RunStatusSchema.options) {
      const verdict = unplottableReason(run({ id: `r_${status}`, status }));
      expect(verdict === null || verdict.length > 0, `no verdict for ${status}`).toBe(true);
    }
  });

  it('refuses a QUEUED run, because its start stamp is the enqueue stamp', () => {
    const reason = unplottableReason(run({ id: 'r1', status: 'queued', finishedAt: null }));
    expect(reason).toMatch(/enqueued/);
  });

  it('admits the statuses whose start stamp is a real start', () => {
    const honest: RunStatus[] = ['pending', 'running', 'waiting', 'success', 'failure'];
    for (const status of honest) {
      const finishedAt = status === 'success' || status === 'failure' ? 2_000 : null;
      expect(unplottableReason(run({ id: `r_${status}`, status, finishedAt })), status).toBeNull();
    }
  });

  /**
   * The two integrity cases. Both would otherwise fall into the OPEN arm and be
   * drawn hatched to the right edge — the visual claim "started here, still
   * going" — beside a `success` pill, while the Duration column says `0ms` for
   * the same row (`formatRunDuration` clamps). Two surfaces, contradictory
   * claims, one run.
   */
  it('refuses a settled run whose finish precedes its start', () => {
    const reason = unplottableReason(
      run({ id: 'r1', status: 'success', startedAt: 5_000, finishedAt: 4_000 }),
    );
    expect(reason).toMatch(/precedes/);
  });

  it('refuses a settled run that records no finish at all', () => {
    const reason = unplottableReason(run({ id: 'r1', status: 'failure', finishedAt: null }));
    expect(reason).toMatch(/no finish/);
  });
});

describe('U29 toRunBar', () => {
  it('carries an unfinished run as an OPEN span, never as a zero-length one', () => {
    const bar = toRunBar(run({ id: 'r1', status: 'running', startedAt: 7, finishedAt: null }));
    expect(bar.startedAtMs).toBe(7);
    expect(bar.endedAtMs).toBeUndefined();
  });

  it('carries a finished run as a measured span', () => {
    const bar = toRunBar(run({ id: 'r1', startedAt: 7, finishedAt: 11 }));
    expect(bar.endedAtMs).toBe(11);
  });
});

describe('U29 groupRunsByPipeline', () => {
  /**
   * The reason `pipelineId` was added to `RunSummary` at all. Two pipelines may
   * share a name — `pipelines` is unique on `(owner_id, resource_id)`, not on
   * `(owner_id, name)` — and merging them would make the chart assert that one
   * pipeline was busy when two were.
   */
  it('keeps two same-named pipelines apart', () => {
    const { groups } = groupRunsByPipeline([
      run({ id: 'r1', pipelineId: 'pipe_a', pipelineName: 'Nightly' }),
      run({ id: 'r2', pipelineId: 'pipe_b', pipelineName: 'Nightly' }),
    ]);
    expect(groups.map((g) => g.pipelineId)).toEqual(['pipe_a', 'pipe_b']);
  });

  it('collects a pipeline’s runs into ONE group, oldest bar first', () => {
    const { groups } = groupRunsByPipeline([
      run({ id: 'late', startedAt: 900, finishedAt: 950 }),
      run({ id: 'early', startedAt: 100, finishedAt: 150 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.bars.map((b) => b.run.id)).toEqual(['early', 'late']);
  });

  /**
   * Groups read top-to-bottom in the order the workspace got busy, which is the
   * Gantt convention and the only ordering that makes "did these two overlap"
   * legible at a glance. Deterministic all the way down — a tie on the earliest
   * start falls to the name and then to the id, so the chart never reshuffles
   * between two renders of the same data.
   */
  it('orders groups by their earliest bar, then by name, then by id', () => {
    const { groups } = groupRunsByPipeline([
      run({ id: 'r1', pipelineId: 'pipe_z', pipelineName: 'Zulu', startedAt: 500 }),
      // Fed in DESCENDING id order, so a stable sort with no id tiebreak would
      // preserve `pipe_m` first and fail. Feeding them in ascending order made
      // this assertion vacuous — V8's sort is stable, so insertion order alone
      // produced the expected answer.
      run({ id: 'r3', pipelineId: 'pipe_m', pipelineName: 'Alpha', startedAt: 100 }),
      run({ id: 'r2', pipelineId: 'pipe_a', pipelineName: 'Alpha', startedAt: 100 }),
    ]);
    expect(groups.map((g) => g.pipelineId)).toEqual(['pipe_a', 'pipe_m', 'pipe_z']);
  });

  /**
   * A group whose runs are ALL unplottable must not appear as an empty lane —
   * an empty lane reads as "this pipeline ran and we lost the data", when the
   * truth is in the named list beneath.
   */
  it('drops a group with no plottable bar, and names its runs instead', () => {
    const { groups, unplottable } = groupRunsByPipeline([
      run({ id: 'r1', pipelineId: 'pipe_a', status: 'queued', finishedAt: null }),
      run({ id: 'r2', pipelineId: 'pipe_b', startedAt: 100, finishedAt: 200 }),
    ]);
    expect(groups.map((g) => g.pipelineId)).toEqual(['pipe_b']);
    expect(unplottable.map((u) => u.run.id)).toEqual(['r1']);
    expect(unplottable[0]?.reason).toMatch(/enqueued/);
  });

  /**
   * The unplottable list is a PASS-THROUGH, not a sort. Pinned because the
   * rendered list reads newest-first and it would be easy to record that as a
   * guarantee of this function — it is the caller's (`listRunSummaries` orders
   * `desc(startedAt)`), and a caller with another order must get its own back
   * rather than a silently re-ordered one.
   */
  it('returns unplottable rows in the order they were given', () => {
    const { unplottable } = groupRunsByPipeline([
      run({ id: 'oldest', status: 'queued', startedAt: 100, finishedAt: null }),
      run({ id: 'newest', status: 'queued', startedAt: 900, finishedAt: null }),
    ]);
    expect(unplottable.map((u) => u.run.id)).toEqual(['oldest', 'newest']);
  });

  /**
   * THE claim U29 exists to support: every group shares ONE axis, so a bar's
   * position is comparable across lanes. A per-group window — an easy and
   * plausible implementation slip — would pass every other test in this file
   * while stretching each lane to full width independently, which is a chart
   * that answers no cross-run question at all.
   */
  it('measures ONE window across all groups', () => {
    // Each edge of the window comes from a DIFFERENT lane, so no single group's
    // own window can satisfy this. (It could before: with both edges owned by
    // one group, a per-group window over `groups[0]` produced the same answer
    // and the mutant passed.)
    const { window } = groupRunsByPipeline([
      run({ id: 'r1', pipelineId: 'pipe_a', startedAt: 100, finishedAt: 200 }),
      run({ id: 'r2', pipelineId: 'pipe_b', startedAt: 500, finishedAt: 3_000 }),
    ]);
    expect(window).toEqual({ from: 100, to: 3_000 });
  });

  it('has no window at all when nothing is plottable', () => {
    const { window, groups } = groupRunsByPipeline([
      run({ id: 'r1', status: 'queued', finishedAt: null }),
    ]);
    expect(window).toBeNull();
    expect(groups).toEqual([]);
  });

  /**
   * An OPEN run stretches the axis to its START and no further — the no-clock
   * property, at the window level. Were it allowed to reach some assumed
   * present, every settled bar beside it would be squeezed by a number nobody
   * measured.
   */
  it('lets an open run set the axis end by its START only', () => {
    const { window } = groupRunsByPipeline([
      run({ id: 'r1', startedAt: 100, finishedAt: 200 }),
      run({ id: 'r2', status: 'running', startedAt: 300, finishedAt: null }),
    ]);
    expect(window).toEqual({ from: 100, to: 300 });
  });
});
