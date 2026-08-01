import { describe, expect, it } from 'vitest';
import { RunStatusSchema, type RunStatus } from '@autonomy-studio/shared';
import { RERUNNABLE_RUN_STATUS, RERUN_COST_WARNING, canRerunFromFailed } from './rerunAction';

/**
 * The offer predicate for the rerun-from-failed action. Its whole job is to
 * avoid putting a control in front of an operator that CANNOT work — the
 * server remains the authority on eligibility (it answers `409` with a reason),
 * so this is deliberately the weaker, row-shaped test.
 */
describe('canRerunFromFailed', () => {
  /* EXHAUSTIVE over the real vocabulary, read from the schema rather than a
     hand-copied list: a new run status added to `RunStatusSchema` lands here as
     a failure of THIS test, not as a silently unclassified value. */
  const ALL: readonly RunStatus[] = RunStatusSchema.options;

  it('covers every status the schema declares', () => {
    expect(ALL.length).toBe(8);
  });

  it.each(['failure', 'interrupted'] as const)('offers the action for %s', (status) => {
    expect(canRerunFromFailed(status)).toBe(true);
  });

  it.each(['pending', 'queued', 'running', 'success', 'skipped', 'waiting'] as const)(
    'withholds the action for %s',
    (status) => {
      expect(canRerunFromFailed(status)).toBe(false);
    },
  );

  it('offers the action for exactly the two terminal FAILURE statuses', () => {
    // The server's rule (`run/reseed.ts`): a source run is eligible when its log
    // has TERMINATED and did not terminate in `success`. `failure` and
    // `interrupted` are the only two statuses that can mean that, so those are
    // the two the UI offers on. `success`/`skipped` are terminal but not
    // failures; the rest have not terminated at all.
    expect(ALL.filter(canRerunFromFailed)).toEqual(['failure', 'interrupted']);
  });

  it('exposes the same set it decides with', () => {
    expect([...RERUNNABLE_RUN_STATUS].sort()).toEqual(['failure', 'interrupted']);
  });
});

describe('RERUN_COST_WARNING', () => {
  /* The rerun spec (`docs/2026-07-14-foundation-rerun-from-failed.md`, "Cost,
     audit, monitor") states the obligation directly: "The rerun UI warns 'may
     incur additional cost.'" Copied nodes are free, but every RE-EXECUTED node
     meters normally, so a rerun can spend real money. Pinned here so the
     warning cannot be quietly dropped from the page. */
  it('says that a rerun may incur additional cost', () => {
    expect(RERUN_COST_WARNING).toContain('may incur additional cost');
  });
});
