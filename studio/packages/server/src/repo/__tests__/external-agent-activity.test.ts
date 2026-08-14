import { describe, expect, it } from 'vitest';
import type { ExternalAgentReport } from '@autonomy-studio/shared';
import {
  MAX_REPORTER_GROUPS,
  aggregateExternalAgentActivity,
  drainExternalAgentActivity,
  recordExternalAgentActivity,
} from '../external-agent-activity.js';
import { freshDb } from './helpers.js';

type Db = ReturnType<typeof freshDb>['db'];

const T = 1_786_000_000_000;

/** A minimal, still-running report — the shape a reporter sends at start. */
function report(over: Partial<ExternalAgentReport> = {}): ExternalAgentReport {
  return {
    source: 'studio-build-loop',
    externalId: 'fire-1',
    agent: 'claude',
    model: 'claude-opus-5',
    startedAt: T,
    endedAt: null,
    outcome: 'unknown',
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    ...over,
  };
}

function record(db: Db, over: Partial<ExternalAgentReport> = {}, nowMs = T) {
  return recordExternalAgentActivity(db, { ownerId: 'local', report: report(over), nowMs });
}

function windowOf(db: Db, sinceMs: number, nowMs: number, ownerId = 'local') {
  return aggregateExternalAgentActivity(db, { sinceMs, nowMs, ownerId });
}

describe('recordExternalAgentActivity', () => {
  it('records a first sighting as created, and a re-report of the same invocation as an update', () => {
    const { db } = freshDb();

    const first = record(db);
    const second = record(db, { endedAt: T + 60_000, outcome: 'completed' }, T + 60_000);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // The SAME row, so one fire is one invocation however often it is reported.
    expect(second.id).toBe(first.id);
    expect(windowOf(db, T - 1000, T + 120_000).invocations).toBe(1);
  });

  it('counts a different externalId from the same source as a separate invocation', () => {
    const { db } = freshDb();
    record(db, { externalId: 'fire-1' });
    record(db, { externalId: 'fire-2' });

    expect(windowOf(db, T - 1000, T + 1000).invocations).toBe(2);
  });

  /**
   * THE at-least-once hazard. A reporter that retries its START body after the
   * END body has landed must not resurrect a finished invocation — it would sit
   * on the panel as "running now" forever, which is the one reading this surface
   * exists to give truthfully.
   */
  it('never returns a settled invocation to unsettled when an interim report is replayed', () => {
    const { db } = freshDb();
    record(db);
    record(db, { endedAt: T + 60_000, outcome: 'completed', outputTokens: 500 }, T + 60_000);

    // The interim body arrives late: no end stamp, no verdict, no tokens.
    record(db, {}, T + 90_000);

    const after = windowOf(db, T - 1000, T + 120_000);
    expect(after.inFlight).toBe(0);
    expect(after.completed).toBe(1);
    expect(after.tokens.outputTokens).toBe(500);
  });

  it('never overwrites a measured token figure with an unmeasured one', () => {
    const { db } = freshDb();
    record(db, { inputTokens: 10, outputTokens: 20 });
    record(db, { inputTokens: null, outputTokens: 99 });

    const tokens = windowOf(db, T - 1000, T + 1000).tokens;
    expect(tokens.inputTokens).toBe(10);
    expect(tokens.outputTokens).toBe(99);
  });
});

describe('aggregateExternalAgentActivity', () => {
  it('scopes to the owner in SQL — a second owner is never summed in', () => {
    const { db } = freshDb();
    record(db);
    recordExternalAgentActivity(db, {
      ownerId: 'someone-else',
      report: report({ externalId: 'their-fire' }),
      nowMs: T,
    });

    expect(windowOf(db, T - 1000, T + 1000).invocations).toBe(1);
    expect(windowOf(db, T - 1000, T + 1000, 'someone-else').invocations).toBe(1);
  });

  /**
   * THE ticket's own case. An autonomy-loop fire runs up to ~90 minutes, so
   * filtering intervals by their START would hide a fire that began before the
   * default 1h window and is STILL RUNNING — the panel would again report
   * nothing while the agent is visibly working.
   */
  it('includes a still-running invocation that started before the window', () => {
    const { db } = freshDb();
    record(db, { startedAt: T - 70 * 60_000 });

    const window = windowOf(db, T - 60 * 60_000, T);
    expect(window.invocations).toBe(1);
    expect(window.inFlight).toBe(1);
  });

  it('includes an invocation that started before the window but ended inside it', () => {
    const { db } = freshDb();
    record(db, { startedAt: T - 70 * 60_000, endedAt: T - 30 * 60_000, outcome: 'completed' });

    expect(windowOf(db, T - 60 * 60_000, T).invocations).toBe(1);
  });

  it('excludes an invocation that ended before the window opened', () => {
    const { db } = freshDb();
    record(db, { startedAt: T - 200 * 60_000, endedAt: T - 190 * 60_000, outcome: 'completed' });

    expect(windowOf(db, T - 60 * 60_000, T).invocations).toBe(0);
  });

  /**
   * A reporter clock running fast must not put an invocation on the panel before
   * it has happened — which is also what keeps `lastAt` from ever rendering as a
   * "last started" in the future.
   */
  it('excludes a future-stamped invocation', () => {
    const { db } = freshDb();
    record(db, { startedAt: T + 60 * 60_000 });

    const window = windowOf(db, T - 60_000, T);
    expect(window.invocations).toBe(0);
    expect(window.lastAt).toBeNull();
  });

  it('keeps completed, notCompleted and unknown a total partition of invocations', () => {
    const { db } = freshDb();
    record(db, { externalId: 'a', endedAt: T + 1, outcome: 'completed' });
    record(db, { externalId: 'b', endedAt: T + 1, outcome: 'notCompleted' });
    record(db, { externalId: 'c' });

    const w = windowOf(db, T - 1000, T + 1000);
    expect(w.completed + w.notCompleted + w.unknown).toBe(w.invocations);
    expect(w.unknown).toBe(1);
    expect(w.inFlight).toBe(1);
  });

  it('reports unmeasured tokens as null, and a measured zero as zero', () => {
    const { db } = freshDb();
    record(db, { externalId: 'unmeasured' });

    const unmeasured = windowOf(db, T - 1000, T + 1000);
    expect(unmeasured.tokens.inputTokens).toBeNull();
    expect(unmeasured.tokens.measuredInvocations).toBe(0);

    record(db, { externalId: 'measured-zero', inputTokens: 0 });
    const measured = windowOf(db, T - 1000, T + 1000);
    expect(measured.tokens.inputTokens).toBe(0);
    expect(measured.tokens.measuredInvocations).toBe(1);
  });

  it('groups by source, agent and model', () => {
    const { db } = freshDb();
    record(db, { externalId: '1', model: 'opus' });
    record(db, { externalId: '2', model: 'opus' });
    record(db, { externalId: '3', model: 'sonnet' });

    const w = windowOf(db, T - 1000, T + 1000);
    expect(w.reporters).toHaveLength(2);
    expect(w.reporters[0]).toMatchObject({ model: 'opus', invocations: 2 });
    expect(w.reporters[1]).toMatchObject({ model: 'sonnet', invocations: 1 });
  });

  it('reports a null model as null rather than dropping the group', () => {
    const { db } = freshDb();
    record(db, { model: null });

    expect(windowOf(db, T - 1000, T + 1000).reporters[0]?.model).toBeNull();
  });

  /**
   * `source`/`agent`/`model` are free text from a caller studio does not
   * control, and this body is polled every few seconds — so the BREAKDOWN is
   * capped. The counts above it are computed ungrouped precisely so truncating
   * the table never makes the headline under-report.
   */
  it('caps the breakdown but still counts every invocation in the totals', () => {
    const { db } = freshDb();
    const groups = MAX_REPORTER_GROUPS + 5;
    for (let i = 0; i < groups; i++) {
      record(db, { externalId: `fire-${i}`, model: `model-${i}` });
    }

    const w = windowOf(db, T - 1000, T + 1000);
    expect(w.reporters).toHaveLength(MAX_REPORTER_GROUPS);
    expect(w.truncated).toBe(true);
    expect(w.invocations).toBe(groups);
  });

  it('does not claim truncation when every group fits', () => {
    const { db } = freshDb();
    record(db);

    expect(windowOf(db, T - 1000, T + 1000).truncated).toBe(false);
  });
});

describe('retention', () => {
  /**
   * Pruned on `reported_at_ms` — STUDIO's clock — not on the reporter-supplied
   * start stamp. A reporter with a wrong or hostile clock could otherwise stamp
   * an invocation far in the future and keep the row alive indefinitely.
   */
  it('prunes by when studio was told, not by the reporter-supplied start stamp', () => {
    const { db } = freshDb();
    // Reported LONG ago, but claiming to have started far in the future.
    record(db, { externalId: 'liar', startedAt: T + 10_000 * 60_000 }, T - 40 * 24 * 3600_000);
    record(db, { externalId: 'recent' }, T);

    const pruned = drainExternalAgentActivity(db, { before: T - 30 * 24 * 3600_000 });

    expect(pruned).toBe(1);
    // The recent row survives; the stale one is gone despite its future start.
    expect(windowOf(db, T - 60_000, T + 1000).invocations).toBe(1);
  });

  it('prunes nothing when every row is inside the retention window', () => {
    const { db } = freshDb();
    record(db);

    expect(drainExternalAgentActivity(db, { before: T - 30 * 24 * 3600_000 })).toBe(0);
  });

  it('drains a backlog larger than one batch to a fixpoint', () => {
    const { db } = freshDb();
    const old = T - 40 * 24 * 3600_000;
    for (let i = 0; i < 5; i++) record(db, { externalId: `old-${i}` }, old);

    expect(drainExternalAgentActivity(db, { before: T, batch: 2 })).toBe(5);
    expect(windowOf(db, 0, T + 1000).invocations).toBe(0);
  });
});

/**
 * The merge's two ORDERING guarantees, which only a late-arriving report can
 * violate. Both were found by review: `report.endedAt ?? existing` and an
 * unconditional `startedAt` each let a duplicate rewrite a settled fact.
 */
describe('merge is stable under out-of-order delivery', () => {
  it('keeps the FIRST end stamp when a later report carries an earlier one', () => {
    const { db } = freshDb();
    record(db, { endedAt: T + 60_000, outcome: 'completed' }, T + 60_000);

    // Legal per the schema: an end stamp with no verdict ("it stopped; I do not
    // know how"). It must not move the settled end backwards.
    record(db, { endedAt: T + 55_000, outcome: 'unknown' }, T + 70_000);

    // A window opening between the two stamps still contains the invocation.
    const w = windowOf(db, T + 57_000, T + 80_000);
    expect(w.invocations).toBe(1);
    expect(w.completed).toBe(1);
  });

  it('keeps the EARLIEST start when a later report claims a later one', () => {
    const { db } = freshDb();
    record(db, { startedAt: T });
    record(db, { startedAt: T + 30 * 60_000 }, T + 30 * 60_000);

    expect(windowOf(db, T - 1000, T + 60 * 60_000).lastAt).toBe(T);
  });
});
