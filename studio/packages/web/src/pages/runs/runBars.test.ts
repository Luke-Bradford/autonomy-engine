import { describe, expect, it } from 'vitest';
import { RunStatusSchema, type RunStatus, type RunSummary } from '@autonomy-studio/shared';
import { groupRuns, toRunBar, unplottableReason, type RunGroup } from './runBars';

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
    debug: false,
    annotations: [],
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

const groupRunsByPipeline = (runs: RunSummary[]) => groupRuns(runs, 'pipeline');
const groupRunsByAnnotation = (runs: RunSummary[]) => groupRuns(runs, 'annotation');
const pipelineIdsOf = (groups: RunGroup[]) =>
  groups.map((g) => (g.lane.kind === 'pipeline' ? g.lane.pipelineId : `not a pipeline: ${g.key}`));

describe('U29 groupRuns by pipeline', () => {
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
    expect(pipelineIdsOf(groups)).toEqual(['pipe_a', 'pipe_b']);
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
    expect(pipelineIdsOf(groups)).toEqual(['pipe_a', 'pipe_m', 'pipe_z']);
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
    expect(pipelineIdsOf(groups)).toEqual(['pipe_b']);
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

describe('#1016 groupRuns by annotation', () => {
  /**
   * A tag list is a set: a run whose version carries two tags is in BOTH lanes.
   * Picking one would make an order nobody chose decide where the run appears,
   * and would leave the other lane claiming that tag's workload was lighter.
   */
  it('draws a run carrying several tags in EACH of their lanes', () => {
    const { groups } = groupRunsByAnnotation([
      run({ id: 'r1', annotations: ['finance', 'nightly'], startedAt: 100, finishedAt: 200 }),
      run({ id: 'r2', annotations: ['nightly'], startedAt: 300, finishedAt: 400 }),
    ]);
    expect(groups.map((g) => [g.label, g.bars.map((b) => b.run.id)])).toEqual([
      ['finance', ['r1']],
      ['nightly', ['r1', 'r2']],
    ]);
  });

  /** Property 3 — a run with no tag ran, so it is in a lane, not missing. */
  it('puts every run with no tag in ONE untagged lane', () => {
    const { groups } = groupRunsByAnnotation([
      run({ id: 'r1', pipelineId: 'pipe_a', annotations: [] }),
      run({ id: 'r2', pipelineId: 'pipe_b', annotations: [] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lane).toEqual({ kind: 'untagged' });
    expect(groups[0]?.label).toBe('Runs with no annotation');
    expect(groups[0]?.bars.map((b) => b.run.id)).toEqual(['r1', 'r2']);
  });

  /**
   * The untagged lane is not a tag. A real tag spelled like its label, or like
   * its key, must still be a lane of its own — merging them would put tagged
   * runs among the untagged ones.
   */
  it('never merges a tag spelled like the untagged lane into it', () => {
    const { groups } = groupRunsByAnnotation([
      run({ id: 'none', annotations: [] }),
      run({ id: 'label', annotations: ['Runs with no annotation'] }),
      run({ id: 'key', annotations: ['untagged'] }),
    ]);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((g) => g.key)).size).toBe(3);
    const untagged = groups.filter((g) => g.lane.kind === 'untagged');
    expect(untagged.map((g) => g.bars.map((b) => b.run.id))).toEqual([['none']]);
  });

  /** Exact and case-sensitive, as U26's filter is — the two must agree on a tag. */
  it('keeps two tags differing only in case apart', () => {
    const { groups } = groupRunsByAnnotation([
      run({ id: 'r1', annotations: ['Prod'] }),
      run({ id: 'r2', annotations: ['prod'] }),
    ]);
    expect(groups.map((g) => g.label).sort()).toEqual(['Prod', 'prod']);
  });

  /** A refusal is about the ROW, so it is listed once however many tags it has. */
  it('lists an unplottable multi-tag run ONCE, in no lane', () => {
    const { groups, unplottable } = groupRunsByAnnotation([
      run({ id: 'q', status: 'queued', finishedAt: null, annotations: ['a', 'b'] }),
    ]);
    expect(groups).toEqual([]);
    expect(unplottable.map((u) => u.run.id)).toEqual(['q']);
  });

  it('measures ONE window across the lanes, unmoved by a run drawn twice', () => {
    const { window } = groupRunsByAnnotation([
      run({ id: 'r1', annotations: ['a', 'b'], startedAt: 100, finishedAt: 200 }),
      run({ id: 'r2', annotations: [], startedAt: 500, finishedAt: 3_000 }),
    ]);
    expect(window).toEqual({ from: 100, to: 3_000 });
  });

  it('orders lanes by their earliest bar, then by label — and the untagged lane LAST', () => {
    const { groups } = groupRunsByAnnotation([
      run({ id: 'r0', annotations: [], startedAt: 50 }),
      run({ id: 'r1', annotations: ['zulu'], startedAt: 900 }),
      run({ id: 'r2', annotations: ['beta', 'alpha'], startedAt: 100 }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'alpha',
      'beta',
      'zulu',
      'Runs with no annotation',
    ]);
  });

  /** Only the write schema refuses a repeat; a stored one is still one run. */
  it('draws a run whose stored tags repeat ONCE in that lane', () => {
    const { groups } = groupRunsByAnnotation([run({ id: 'r1', annotations: ['a', 'a'] })]);
    expect(groups.map((g) => [g.label, g.bars.length])).toEqual([['a', 1]]);
  });
});
