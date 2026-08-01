import { describe, expect, it } from 'vitest';
import type { NodeCost } from '@autonomy-studio/shared';
import { readNodeCost } from './nodeCost';

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
    tokenReportedResponseCount: 0,
    providers: [],
    models: [],
    ...fields,
  };
}

describe('readNodeCost (#866)', () => {
  it('reads NO billed exchange as an absence, not as a cost of zero', () => {
    expect(readNodeCost(cost()).kind).toBe('none');
  });

  it('reads a fully-priced node as exact', () => {
    const r = readNodeCost(
      cost({ responseCount: 2, pricedResponseCount: 2, totalCostEstimate: 0.031 }),
    );
    expect(r.kind).toBe('exact');
    expect(r.amount).toBeCloseTo(0.031, 10);
  });

  it('reads a partly-priced node as a LOWER BOUND, never as the total', () => {
    const r = readNodeCost(
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
    const r = readNodeCost(
      cost({ responseCount: 2, costUnknownResponseCount: 2, complete: false }),
    );
    expect(r.kind).toBe('unknown');
    expect(r.amount).toBe(0);
  });

  it('reads an all-subscription node as COVERED — a known zero, not a gap', () => {
    const r = readNodeCost(
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
      readNodeCost(cost({ responseCount: 1, unpricedResponseCount: 1, providers: ['agent_cli'] }))
        .exchangesAreFloor,
    ).toBe(true);
    expect(
      readNodeCost(
        cost({ responseCount: 1, pricedResponseCount: 1, providers: ['anthropic_api'] }),
      ).exchangesAreFloor,
    ).toBe(false);
  });

  it('says tokens were NOT reported, so a zero sum is never read as a measurement', () => {
    const r = readNodeCost(
      cost({ responseCount: 1, unpricedResponseCount: 1, tokenReportedResponseCount: 0 }),
    );
    expect(r.tokensReported).toBe(false);
    expect(r.tokensPartial).toBe(false);
  });

  it('says the token sums are PARTIAL when only some exchanges reported', () => {
    const r = readNodeCost(
      cost({
        responseCount: 3,
        pricedResponseCount: 3,
        tokenReportedResponseCount: 2,
        inputTokens: 40,
      }),
    );
    expect(r.tokensReported).toBe(true);
    expect(r.tokensPartial).toBe(true);
  });

  it('does not call a fully-reporting node partial', () => {
    const r = readNodeCost(
      cost({ responseCount: 2, pricedResponseCount: 2, tokenReportedResponseCount: 2 }),
    );
    expect(r.tokensPartial).toBe(false);
  });
});
