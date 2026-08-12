import { describe, expect, it } from 'vitest';
import type { NodeCost } from '@autonomy-studio/shared';
import { childSpend, costSentence, readCost, reusedSpend, unsettledSentence } from './costReading';

/** A folded node cost, defaulted to "nothing billed" and overridden per case. */
function cost(fields: Partial<NodeCost> = {}): NodeCost {
  return {
    currency: 'USD',
    totalCostEstimate: 0,
    responseCount: 0,
    pricedResponseCount: 0,
    unpricedResponseCount: 0,
    costUnknownResponseCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    complete: true,
    inputReportedResponseCount: 0,
    outputReportedResponseCount: 0,
    providers: [],
    models: [],
    ...fields,
  };
}

describe('readCost (#866)', () => {
  it('reads NO billed exchange as an absence, not as a cost of zero', () => {
    expect(readCost(cost()).kind).toBe('none');
  });

  it('reads a fully-priced node as exact', () => {
    const r = readCost(
      cost({ responseCount: 2, pricedResponseCount: 2, totalCostEstimate: 0.031 }),
    );
    expect(r.kind).toBe('exact');
    expect(r.amount).toBeCloseTo(0.031, 10);
  });

  it('reads a partly-priced node as a LOWER BOUND, never as the total', () => {
    const r = readCost(
      cost({
        responseCount: 3,
        pricedResponseCount: 2,
        costUnknownResponseCount: 1,
        complete: false,
        totalCostEstimate: 0.02,
      }),
    );
    expect(r.kind).toBe('lower-bound');
    expect(r.unknownCount).toBe(1);
  });

  it('reads a node where NOTHING priced as unknown — never "at least $0.00"', () => {
    // The trap: `totalCostEstimate` is 0 because no cost was resolvable, not
    // because nothing was spent. Presenting that 0 as a floor states a figure
    // nobody measured.
    const r = readCost(cost({ responseCount: 2, costUnknownResponseCount: 2, complete: false }));
    expect(r.kind).toBe('unknown');
    expect(r.amount).toBe(0);
  });

  it('reads an all-subscription node as COVERED — a known zero, not a gap', () => {
    const r = readCost(
      cost({ responseCount: 2, unpricedResponseCount: 2, providers: ['agent_cli'] }),
    );
    expect(r.kind).toBe('covered');
    expect(r.coveredCount).toBe(2);
    expect(r.unknownCount).toBe(0);
  });

  it('flags an agent_cli exchange count as a FLOOR, not a census', () => {
    // One `cliSpendFact` per subprocess INVOCATION; the CLI reports none of the
    // model calls it drove internally.
    expect(
      readCost(cost({ responseCount: 1, unpricedResponseCount: 1, providers: ['agent_cli'] }))
        .exchangesAreFloor,
    ).toBe(true);
    expect(
      readCost(cost({ responseCount: 1, pricedResponseCount: 1, providers: ['anthropic_api'] }))
        .exchangesAreFloor,
    ).toBe(false);
  });

  it('says tokens were NOT reported, so a zero sum is never read as a measurement', () => {
    const r = readCost(cost({ responseCount: 1, unpricedResponseCount: 1 }));
    expect(r.inputTokensReported).toBe(false);
    expect(r.outputTokensReported).toBe(false);
  });

  it('answers PER SIDE — a one-sided count never lends credibility to the other', () => {
    /* The documented `meterUsage` case: a gateway sends `prompt_eval_count` and
       no `eval_count`. A single combined flag would call this response "reported"
       and render `4,000 in · 0 out` — a measurement nobody took. */
    const r = readCost(
      cost({
        responseCount: 1,
        costUnknownResponseCount: 1,
        complete: false,
        inputTokens: 4000,
        inputReportedResponseCount: 1,
        outputReportedResponseCount: 0,
      }),
    );
    expect(r.inputTokensReported).toBe(true);
    expect(r.outputTokensReported).toBe(false);
    // And neither side is "partial": input reported on every exchange there was.
    expect(r.inputTokensPartial).toBe(false);
  });

  it('says a side is PARTIAL when only some exchanges reported it', () => {
    const r = readCost(
      cost({
        responseCount: 3,
        pricedResponseCount: 3,
        inputReportedResponseCount: 2,
        outputReportedResponseCount: 3,
        inputTokens: 40,
      }),
    );
    expect(r.inputTokensPartial).toBe(true);
    expect(r.outputTokensPartial).toBe(false);
    expect(r.inputReportedCount).toBe(2);
  });

  it('does not call a fully-reporting node partial', () => {
    const r = readCost(
      cost({
        responseCount: 2,
        pricedResponseCount: 2,
        inputReportedResponseCount: 2,
        outputReportedResponseCount: 2,
      }),
    );
    expect(r.inputTokensPartial).toBe(false);
    expect(r.outputTokensPartial).toBe(false);
  });
});

/**
 * #930 — the wording, now that a SECOND scope reads the same five classifications.
 *
 * The `exact` arm is the load-bearing one. #866 could assert "all priced" because
 * a NODE binds one connection for the whole immutable run, so it can never hold a
 * priced and an `unpriced` response together. A RUN mixes nodes, so it can — and
 * the old sentence then described exchanges that were never priced as priced.
 */
describe('costSentence (#930 — the same reading, worded for a node or a run)', () => {
  it('names its subject, so a run is never described as a node', () => {
    const r = readCost(cost());
    expect(costSentence(r, 'node')).toContain('under this node');
    expect(costSentence(r, 'run')).toContain('under this run');
    expect(costSentence(r, 'run')).not.toContain('node');
  });

  it('does not claim "all priced" over a run that mixed priced and subscription calls', () => {
    const mixed = readCost(
      cost({
        responseCount: 5,
        pricedResponseCount: 3,
        unpricedResponseCount: 2,
        totalCostEstimate: 1.25,
        providers: ['anthropic_api', 'agent_cli'],
      }),
    );
    expect(mixed.kind).toBe('exact');
    const sentence = costSentence(mixed, 'run');
    expect(sentence).not.toContain('all priced');
    expect(sentence).toContain('3 priced');
    expect(sentence).toContain('2 a subscription or CLI call');
    /* The headline is still right, and the sentence must not undercut it: a
       covered exchange contributes a KNOWN zero, so the total is complete. */
    expect(sentence).toContain('The total is complete');
  });

  it('still says "all priced" when nothing was covered', () => {
    const pure = readCost(
      cost({ responseCount: 2, pricedResponseCount: 2, totalCostEstimate: 0.5 }),
    );
    expect(costSentence(pure, 'run')).toContain('all priced');
  });
});

describe('unsettledSentence (#930)', () => {
  it('qualifies the FIGURE only when a figure is on screen', () => {
    const withFigure = readCost(
      cost({ responseCount: 1, pricedResponseCount: 1, totalCostEstimate: 0.5 }),
    );
    expect(unsettledSentence(withFigure, 'run')).toContain('spent SO FAR');

    /* "This is what it has spent so far" under a headline reading "No billed
       exchange" would qualify a number that is not there. */
    const withoutFigure = readCost(cost());
    expect(unsettledSentence(withoutFigure, 'run')).not.toContain('SO FAR');
    expect(unsettledSentence(withoutFigure, 'run')).toContain('may still be billed');
  });

  it('names its subject', () => {
    const r = readCost(cost());
    expect(unsettledSentence(r, 'node')).toContain('This node');
    expect(unsettledSentence(r, 'run')).toContain('This run');
  });
});

/**
 * #930 — what a rerun COPIED, which is exactly what its money figure excludes.
 */
describe('reusedSpend (#930 — a rerun total is incremental)', () => {
  it('is null when nothing was copied, so an ordinary run says nothing', () => {
    expect(reusedSpend([{}, { copiedFromRunId: undefined }])).toBeNull();
  });

  it('counts the copied nodes and names the run they came from', () => {
    expect(
      reusedSpend([
        { copiedFromRunId: 'run_a' },
        {},
        { copiedFromRunId: 'run_a' },
        { copiedFromRunId: undefined },
      ]),
    ).toEqual({ reusedNodeCount: 2, sourceRunId: 'run_a' });
  });

  it('answers for an ALL-copied rerun, the case a "did it spend anything" gate would hide', () => {
    expect(reusedSpend([{ copiedFromRunId: 'run_a' }, { copiedFromRunId: 'run_a' }])).toEqual({
      reusedNodeCount: 2,
      sourceRunId: 'run_a',
    });
  });
});

describe('childSpend (#932 — a total excludes its child runs)', () => {
  it('is null when the run spawned nothing, so an ordinary run says nothing', () => {
    expect(childSpend([{}, { childRunIds: undefined }, { childRunIds: [] }])).toBeNull();
  });

  it('collects every announced child, in log order', () => {
    expect(
      childSpend([{ childRunIds: ['run_c1'] }, {}, { childRunIds: ['run_c2', 'run_c3'] }]),
    ).toEqual({ childRunIds: ['run_c1', 'run_c2', 'run_c3'] });
  });

  it('names a run ONCE even if two rows claim it', () => {
    /* No producer emits this — a child belongs to exactly one call node, and the
       fold already dedupes per row. It is guarded because the alternative is a
       money caveat that counts one run twice in one sentence. */
    expect(childSpend([{ childRunIds: ['run_c1'] }, { childRunIds: ['run_c1'] }])).toEqual({
      childRunIds: ['run_c1'],
    });
  });
});
