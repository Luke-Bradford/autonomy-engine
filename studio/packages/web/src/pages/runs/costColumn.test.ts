import { describe, expect, it } from 'vitest';
import {
  computeRunCost,
  RunStatusSchema,
  type RunCost,
  type RunStatus,
} from '@autonomy-studio/shared';
import { costCell, type CostCellRun } from './costColumn';

/**
 * #931 — one CELL of the run list's Cost column. Pure, so every decision it makes
 * is testable without mounting the page: which headline, whether the figure is
 * still moving, and which caveats survive being compressed into one cell.
 */

/** A metered payload in the shape the fold reads, priced or not. */
function metered(fields: { cost?: number; meteringStatus?: 'metered' | 'unpriced' }) {
  return {
    payload: {
      type: 'activity.metered' as const,
      runId: 'run_1',
      nodeId: 'n1',
      attemptId: 'n1#1',
      provider: 'anthropic_api',
      model: 'claude-opus-4-8',
      meteringStatus: fields.meteringStatus ?? 'metered',
      inputTokens: 10,
      outputTokens: 20,
      ...(fields.cost === undefined
        ? {}
        : { inUnitPrice: 5, outUnitPrice: 5, priceTableVersion: 'v1', costEstimate: fields.cost }),
    },
  };
}

function cellFor(
  cost: RunCost,
  overrides: Partial<Omit<CostCellRun, 'cost'>> = {},
): ReturnType<typeof costCell> {
  return costCell({ cost, status: 'success', rerunOf: null, ...overrides });
}

const priced = computeRunCost([metered({ cost: 0.03 })]);
const nothing = computeRunCost([]);

describe('costCell — the headline', () => {
  it('states the money for a settled, fully-priced run', () => {
    const cell = cellFor(priced);
    expect(cell.figure).toBe('$0.03');
    expect(cell.unsettled).toBe(false);
    expect(cell.note).toBeNull();
  });

  it('a run that billed NOTHING reads as an absence, never as $0.00', () => {
    /* The whole reason the column classifies rather than formatting: `$0.00`
       reads as FREE, which is a claim nobody measured. */
    expect(cellFor(nothing).figure).toBe('No billed exchange');
  });

  it('an all-subscription run reads as a KNOWN zero, not as unknown', () => {
    const covered = computeRunCost([metered({ meteringStatus: 'unpriced' })]);
    expect(cellFor(covered).figure).toBe('No marginal cost');
  });

  it('a run nothing could be priced in shows NO figure at all', () => {
    const unknown = computeRunCost([metered({})]);
    expect(cellFor(unknown).figure).toBe('Cost unknown');
  });

  it('a partly-priced run is labelled a FLOOR, not a total', () => {
    const mixed = computeRunCost([metered({ cost: 0.25 }), metered({})]);
    expect(cellFor(mixed).figure).toBe('At least $0.25');
  });
});

describe('costCell — the unsettled qualifier', () => {
  /* The list's own status vocabulary decides this, via `TERMINAL_RUN_ROW_STATUS`.
     Enumerated rather than derived so a new status has to be classified here on
     purpose. */
  const live: RunStatus[] = ['pending', 'queued', 'running', 'waiting'];
  const settled: RunStatus[] = ['success', 'failure', 'skipped', 'interrupted'];

  it('the two lists PARTITION every run status — a new one cannot go unclassified', () => {
    expect([...live, ...settled].sort()).toEqual([...RunStatusSchema.options].sort());
  });

  it.each(live)('%s is NOT settled — the figure is spend so far', (status) => {
    const cell = cellFor(priced, { status });
    expect(cell.unsettled).toBe(true);
    expect(cell.note).toContain('SO FAR');
  });

  it.each(settled)('%s is settled — no qualifier', (status) => {
    const cell = cellFor(priced, { status });
    expect(cell.unsettled).toBe(false);
    expect(cell.note).toBeNull();
  });

  it('words the qualifier differently when the headline is not a number', () => {
    /* `unsettledSentence`'s two arms: "what it has spent SO FAR" would qualify a
       figure that is not on screen. Shared with the detail page, so the two
       surfaces cannot word it two ways. */
    const cell = cellFor(nothing, { status: 'running' });
    expect(cell.figure).toBe('No billed exchange');
    expect(cell.note).toBe(
      'This run has not settled, so more exchanges may still be billed to it.',
    );
  });
});

describe('costCell — a rerun states that its figure is INCREMENTAL', () => {
  it('names the run its reused work was billed to', () => {
    const cell = cellFor(priced, { rerunOf: 'run_source' });
    expect(cell.note).toContain('re-executed only from the failure onward');
    expect(cell.note).toContain('run_source');
  });

  it('HEDGES the claim, so it stays true when the copied frontier was empty', () => {
    /* Deliberately frontier-state-INDEPENDENT: the list holds only `rerunOf`, not
       the fold, so the cell cannot know whether anything was actually copied — a
       rerun whose FIRST node failed reused nothing. The sentence therefore has to
       be hedged ("ANY work it reused") rather than asserting reuse happened, and
       this pins that property against a future rewording that reads better but
       claims more than the row knows. */
    const note = cellFor(priced, { rerunOf: 'run_source' }).note as string;
    expect(note).toContain('any work it reused');
    expect(note).not.toMatch(/\bthe work it reused\b/);
    expect(note).not.toMatch(/excludes|does not include the work/);
  });

  it('says BOTH things when a rerun is still running', () => {
    const cell = cellFor(priced, { status: 'running', rerunOf: 'run_source' });
    expect(cell.note).toContain('has not settled');
    expect(cell.note).toContain('re-executed only from the failure onward');
  });

  it('a non-rerun says nothing about reuse', () => {
    expect(cellFor(priced, { rerunOf: null }).note).toBeNull();
  });
});
