import { describe, expect, it } from 'vitest';
import { WindowEventSchema, WindowStatusSchema, foldWindowStatus } from './window-event.js';

const created = {
  type: 'window.created',
  payload: {
    windowEnd: '2026-07-01T01:00:00.000Z',
    frequency: 'hour',
    interval: 1,
    startTime: '2026-07-01T00:00:00.000Z',
  },
} as const;
const runCreated = {
  type: 'window.runCreated',
  payload: { runId: 'run_1', via: 'fire' },
} as const;
const succeeded = { type: 'window.succeeded', payload: { runId: 'run_1' } } as const;
const failed = {
  type: 'window.failed',
  payload: { runId: 'run_1', runStatus: 'failure' },
} as const;
const retryScheduled = {
  type: 'window.retryScheduled',
  payload: {
    runId: 'run_1',
    runStatus: 'failure',
    attempt: 1,
    nextAttemptAt: '2026-07-01T01:05:00.000Z',
  },
} as const;
const retryDue = { type: 'window.retryDue', payload: { attempt: 1 } } as const;

describe('WindowEventSchema', () => {
  it.each([created, runCreated, succeeded, failed, retryScheduled, retryDue])(
    'round-trips $type',
    (event) => {
      expect(WindowEventSchema.parse(event)).toEqual(event);
    },
  );

  it('rejects an unknown type', () => {
    expect(() => WindowEventSchema.parse({ type: 'window.exploded', payload: {} })).toThrow();
  });

  it('window.created payload is SELF-SUFFICIENT (geometry snapshot required)', () => {
    // After a config edit the old epoch's window size is no longer derivable
    // from the live trigger config — the event must carry the full geometry.
    const { frequency, ...noFrequency } = created.payload;
    void frequency;
    expect(() =>
      WindowEventSchema.parse({ type: 'window.created', payload: noFrequency }),
    ).toThrow();
  });

  it('window.failed accepts a null runId (a never-materialized window folded closed)', () => {
    const e = { type: 'window.failed', payload: { runId: null, runStatus: 'missing' } };
    expect(WindowEventSchema.parse(e)).toEqual(e);
  });

  it('window.retryScheduled refuses runStatus `missing` (#5 S11c — an unknown outcome never retries)', () => {
    // A vanished run row means the outcome is UNKNOWN — the run may have
    // SUCCEEDED, so a retry would duplicate side effects. `missing` stays a
    // terminal `window.failed` fact; the union refuses it at the boundary.
    expect(() =>
      WindowEventSchema.parse({
        type: 'window.retryScheduled',
        payload: { ...retryScheduled.payload, runStatus: 'missing' },
      }),
    ).toThrow();
  });

  it('window.created carries an optional origin (#5 S10) — a pre-S10 payload still parses', () => {
    // Absent origin = 'live' semantically (every pre-S10 log row); the schema
    // stays read-compatible with S9 events rather than manufacturing a value.
    expect(WindowEventSchema.parse(created)).toEqual(created);
    const backfill = {
      ...created,
      payload: { ...created.payload, origin: 'backfill' },
    };
    expect(WindowEventSchema.parse(backfill)).toEqual(backfill);
    expect(() =>
      WindowEventSchema.parse({
        ...created,
        payload: { ...created.payload, origin: 'timetravel' },
      }),
    ).toThrow();
  });
});

describe('WindowStatusSchema', () => {
  it.each(['waiting', 'running', 'succeeded', 'failed', 'retry_pending'])('accepts %s', (s) => {
    expect(WindowStatusSchema.parse(s)).toBe(s);
  });
});

describe('foldWindowStatus (the pure rebuild fold)', () => {
  it('folds the happy path created → runCreated → succeeded', () => {
    expect(foldWindowStatus([created])).toBe('waiting');
    expect(foldWindowStatus([created, runCreated])).toBe('running');
    expect(foldWindowStatus([created, runCreated, succeeded])).toBe('succeeded');
  });

  it('folds a failure terminal', () => {
    expect(foldWindowStatus([created, runCreated, failed])).toBe('failed');
  });

  it('returns null for an empty sequence (window unknown)', () => {
    expect(foldWindowStatus([])).toBeNull();
  });

  it('is stable against out-of-order/duplicate transitions (guarded, total)', () => {
    // A duplicate runCreated or a succeeded-before-running never regresses the
    // status — mirrors the projection's guarded writes.
    expect(foldWindowStatus([created, runCreated, runCreated, succeeded, succeeded])).toBe(
      'succeeded',
    );
    expect(foldWindowStatus([created, succeeded])).toBe('waiting');
    // Symmetric with succeeded: BOTH terminals transition only from `running`,
    // mirroring `completeWindow`'s guard exactly (no fold/projection skew).
    expect(foldWindowStatus([created, failed])).toBe('waiting');
  });

  // #5 S11c — the retry loop through the fold.
  it('folds the retry loop created → runCreated → retryScheduled → retryDue → runCreated → succeeded', () => {
    expect(foldWindowStatus([created, runCreated, retryScheduled])).toBe('retry_pending');
    expect(foldWindowStatus([created, runCreated, retryScheduled, retryDue])).toBe('waiting');
    expect(foldWindowStatus([created, runCreated, retryScheduled, retryDue, runCreated])).toBe(
      'running',
    );
    expect(
      foldWindowStatus([created, runCreated, retryScheduled, retryDue, runCreated, succeeded]),
    ).toBe('succeeded');
    expect(
      foldWindowStatus([created, runCreated, retryScheduled, retryDue, runCreated, failed]),
    ).toBe('failed');
  });

  it('guards the retry transitions like every other (retryScheduled from running only, retryDue from retry_pending only)', () => {
    // Mirrors the projection's guarded writes (`retryWindow`/`retryDueWindow`)
    // exactly — no fold/projection skew on out-of-order sequences.
    expect(foldWindowStatus([created, retryScheduled])).toBe('waiting');
    expect(foldWindowStatus([created, runCreated, retryDue])).toBe('running');
    expect(foldWindowStatus([created, runCreated, retryScheduled, retryScheduled])).toBe(
      'retry_pending',
    );
    expect(foldWindowStatus([created, runCreated, retryScheduled, retryDue, retryDue])).toBe(
      'waiting',
    );
    // A terminal never regresses into the retry loop.
    expect(foldWindowStatus([created, runCreated, failed, retryScheduled])).toBe('failed');
  });
});

// #5 S11d — the stale-epoch disposition through the fold.
describe('foldWindowStatus (window.superseded)', () => {
  const superseded = {
    type: 'window.superseded',
    payload: { currentEpoch: 'epoch-b' },
  } as const;

  it('folds waiting → superseded and retry_pending → superseded', () => {
    expect(foldWindowStatus([created, superseded])).toBe('superseded');
    expect(foldWindowStatus([created, runCreated, retryScheduled, superseded])).toBe('superseded');
  });

  it('never supersedes a running or terminal window (mirrors supersedeWindow guard)', () => {
    expect(foldWindowStatus([created, runCreated, superseded])).toBe('running');
    expect(foldWindowStatus([created, runCreated, succeeded, superseded])).toBe('succeeded');
    expect(foldWindowStatus([created, runCreated, failed, superseded])).toBe('failed');
  });

  it('superseded is terminal — no further transitions apply', () => {
    expect(foldWindowStatus([created, superseded, runCreated])).toBe('superseded');
    expect(foldWindowStatus([created, superseded, superseded])).toBe('superseded');
  });
});
