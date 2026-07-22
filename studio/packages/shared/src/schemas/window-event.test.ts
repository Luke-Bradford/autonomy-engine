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

describe('WindowEventSchema', () => {
  it.each([created, runCreated, succeeded, failed])('round-trips $type', (event) => {
    expect(WindowEventSchema.parse(event)).toEqual(event);
  });

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
});

describe('WindowStatusSchema', () => {
  it.each(['waiting', 'running', 'succeeded', 'failed'])('accepts %s', (s) => {
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
});
