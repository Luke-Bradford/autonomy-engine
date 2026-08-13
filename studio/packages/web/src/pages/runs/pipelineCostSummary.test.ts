import { describe, expect, it } from 'vitest';
import { rollupFromAggregates, type PipelineCostAggregates } from '@autonomy-studio/shared';
import { pipelineCostSummary } from './pipelineCostSummary';

/**
 * #931 (U27 slice 2) — the PIPELINE-level reading. Built from real
 * `rollupFromAggregates` output rather than object literals, so a test can never
 * describe a rollup the fail-closed derivation could not actually produce.
 */
function rollup(over: Partial<PipelineCostAggregates> = {}) {
  return rollupFromAggregates({
    responseCount: 4,
    pricedResponseCount: 4,
    unpricedResponseCount: 0,
    totalCostEstimate: 1.5,
    inputTokens: 1000,
    outputTokens: 250,
    inputReportedResponseCount: 4,
    outputReportedResponseCount: 4,
    runCount: 2,
    incompleteRunCount: 0,
    ...over,
  });
}

describe('pipelineCostSummary', () => {
  it('states the figure from the SAME authority the run list and detail page use', () => {
    expect(pipelineCostSummary(rollup()).figure).toBe('$1.50');
  });

  it('says how many runs it folded, and that they are ALL of them', () => {
    const summary = pipelineCostSummary(rollup({ runCount: 7 }));
    expect(summary.scope).toContain('7 runs');
    expect(summary.scope).toContain('every version');
    /* The rows on screen are narrowed by status/window/trigger and the origin
       tab, so the figure must never read as their total. */
    expect(summary.scope).toContain('not just the runs listed');
  });

  it('uses the shared reading sentence rather than a second wording', () => {
    const summary = pipelineCostSummary(
      rollup({ responseCount: 4, pricedResponseCount: 3, incompleteRunCount: 1 }),
    );
    expect(summary.figure).toBe('At least $1.50');
    expect(summary.reading).toContain('4 billed exchanges');
    expect(summary.reading).toContain('1 could not be priced');
  });

  it('names the runs whose spend is only a lower bound', () => {
    const summary = pipelineCostSummary(
      rollup({ responseCount: 4, pricedResponseCount: 3, runCount: 5, incompleteRunCount: 2 }),
    );
    expect(summary.incomplete).toBe('2 of the 5 runs had spend nobody could price.');
  });

  it('says nothing about incompleteness when every run priced cleanly', () => {
    expect(pipelineCostSummary(rollup()).incomplete).toBeNull();
  });

  it('discloses the sub-pipeline spend the rollup does NOT contain', () => {
    /* The rollup is scoped by `pipelineVersions.pipelineId`, and a `call_pipeline`
       child runs against the CALLED pipeline's version — so a caller's rollup
       excludes every penny its children spent. Understating is safe only once it
       is said. */
    expect(pipelineCostSummary(rollup()).excludes).toContain('sub-pipeline');
  });

  it('warns that an in-flight run is already contributing, unconditionally', () => {
    /* The rollup carries no running-run count, so this cannot be conditioned —
       and deriving it from the visible rows would read a filtered set as if it
       were the pipeline. */
    expect(pipelineCostSummary(rollup()).excludes).toContain('still running');
  });

  it('reports tokens through the shared token line', () => {
    expect(pipelineCostSummary(rollup()).tokens).toBe('1,000 in · 250 out');
  });

  describe('a pipeline that has never run', () => {
    const never = rollup({
      runCount: 0,
      responseCount: 0,
      pricedResponseCount: 0,
      totalCostEstimate: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputReportedResponseCount: 0,
      outputReportedResponseCount: 0,
    });

    it('says so instead of stating a measurement of nothing', () => {
      const summary = pipelineCostSummary(never);
      expect(summary.figure).toBeNull();
      expect(summary.reading).toBe('This pipeline has not run yet.');
    });

    it('shows no token line, which would otherwise read "0 in · 0 out"', () => {
      /* `tokenSideReported` answers TRUE at zero exchanges by design (a measured
         nothing), which is right for a run that ran and billed nothing — and
         wrong here, where it would look like a reading was taken. */
      expect(pipelineCostSummary(never).tokens).toBeNull();
    });

    it('drops every caveat, since there is no figure to qualify', () => {
      expect(pipelineCostSummary(never).excludes).toBeNull();
      expect(pipelineCostSummary(never).incomplete).toBeNull();
      expect(pipelineCostSummary(never).scope).toContain('not run yet');
    });
  });

  it('distinguishes runs that produced NO billed exchange from no runs at all', () => {
    /* `runCount > 0` with `responseCount === 0` is a real, different fact: the
       pipeline ran and billed nothing. */
    const ranButFree = rollup({
      runCount: 3,
      responseCount: 0,
      pricedResponseCount: 0,
      totalCostEstimate: 0,
      inputTokens: 0,
      outputTokens: 0,
      inputReportedResponseCount: 0,
      outputReportedResponseCount: 0,
    });
    const summary = pipelineCostSummary(ranButFree);
    expect(summary.figure).toBe('No billed exchange');
    expect(summary.reading).toContain('Nothing was billed under this pipeline');
    expect(summary.scope).toContain('3 runs');
    /* And its token line is a MEASURED zero, not a withheld one — the pipeline
       ran, so nobody failed to count anything. Only the never-run case above has
       no measurement to report. */
    expect(summary.tokens).toBe('0 in · 0 out');
  });

  it('reads an all-subscription pipeline as a known zero, not an unknown', () => {
    const covered = rollup({
      responseCount: 4,
      pricedResponseCount: 0,
      unpricedResponseCount: 4,
      totalCostEstimate: 0,
    });
    expect(pipelineCostSummary(covered).figure).toBe('No marginal cost');
  });

  it('pluralises one run', () => {
    expect(pipelineCostSummary(rollup({ runCount: 1 })).scope).toContain('1 run,');
  });
});
