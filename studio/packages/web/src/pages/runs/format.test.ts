import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@autonomy-studio/shared';
import { eventGloss, failureClass, formatRunDuration } from './format';

function evt(payload: unknown): RunEvent {
  return { id: 'e', runId: 'r', seq: 1, type: 'x', payload, ts: 0 } as RunEvent;
}

describe('eventGloss', () => {
  it('glosses the well-known display fields', () => {
    expect(eventGloss(evt({ type: 'node.output', nodeId: 'a', name: 'text', value: 'hi' }))).toBe(
      'node=a name=text',
    );
  });

  it('names the failure CLASS, not just the message (#1 F0 / U24)', () => {
    // The regression: F0 moved the class out of the message and into fields, so
    // the feed showed `error=boom` for a throttle and for a bad credential
    // alike. The kind is the whole difference between "retry will fix it" and
    // "go and fix the connection".
    expect(
      eventGloss(
        evt({
          type: 'node.failed',
          nodeId: 'a',
          error: 'boom',
          kind: 'transient',
          code: 'rate_limit',
        }),
      ),
    ).toBe('node=a error=boom kind=transient code=rate_limit');
  });

  it('omits a class the event does not carry', () => {
    expect(eventGloss(evt({ type: 'node.failed', nodeId: 'a', error: 'boom' }))).toBe(
      'node=a error=boom',
    );
  });

  it('also glosses an activity.warned `code` — the other variant carrying one', () => {
    // Not collateral: `code` is declared on `activity.warned` as well as
    // `node.failed`, so the push above reaches it. Pinned so the widening is a
    // decision rather than a surprise.
    expect(
      eventGloss(
        evt({
          type: 'activity.warned',
          nodeId: 'a',
          code: 'empty_truncated_completion',
          reason: 'the model returned nothing',
        }),
      ),
    ).toBe('node=a reason=the model returned nothing code=empty_truncated_completion');
  });

  it('degrades to an empty gloss on an odd payload rather than throwing', () => {
    expect(eventGloss(evt(null))).toBe('');
    expect(eventGloss(evt({ nodeId: 42, kind: 7 }))).toBe('');
  });
});

describe('failureClass', () => {
  it('joins the kind and the code, and drops whichever is absent', () => {
    expect(failureClass('transient', 'rate_limit')).toBe('transient · rate_limit');
    expect(failureClass('permanent', undefined)).toBe('permanent');
    expect(failureClass(undefined, 'rate_limit')).toBe('rate_limit');
  });

  it('is empty when the failure carries NO class at all', () => {
    // A real state, not a gap: `externalWait.expired` fails a node with no
    // `node.failed` behind it. Callers render nothing rather than a default.
    expect(failureClass(undefined, undefined)).toBe('');
  });
});

describe('formatRunDuration', () => {
  const run = (o: Partial<Parameters<typeof formatRunDuration>[0]> = {}) => ({
    status: 'success' as const,
    startedAt: 1_000,
    finishedAt: 8_000,
    ...o,
  });

  it('measures a finished run between its own stamps', () => {
    expect(formatRunDuration(run(), 999_999)).toBe('7s');
  });

  it('measures an unfinished run against the caller’s clock, marked "so far"', () => {
    expect(formatRunDuration(run({ status: 'running', finishedAt: null }), 4_000)).toBe(
      '3s so far',
    );
  });

  /**
   * A `queued` run's `started_at` is an ENQUEUE-time placeholder that admission
   * later re-stamps (`repo/runs.ts::admitQueuedRun`), so subtracting it would
   * print queue age in a column labelled Duration — a WRONG number, not a
   * missing one. An em-dash is the honest answer.
   */
  it('refuses to time a queued run — its startedAt is an enqueue placeholder', () => {
    expect(formatRunDuration(run({ status: 'queued', finishedAt: null }), 9_999_999)).toBe('—');
    // Even with a finishedAt somehow present, queued still declines to guess.
    expect(formatRunDuration(run({ status: 'queued' }), 999_999)).toBe('—');
  });

  it('scales the units from milliseconds to hours', () => {
    const span = (ms: number) => formatRunDuration(run({ startedAt: 0, finishedAt: ms }), 0);
    expect(span(820)).toBe('820ms');
    expect(span(7_000)).toBe('7s');
    expect(span(3 * 60_000 + 7_000)).toBe('3m 07s');
    expect(span(60 * 60_000 + 4 * 60_000)).toBe('1h 04m');
  });

  it('never renders a negative duration from a clock that ran backwards', () => {
    expect(formatRunDuration(run({ status: 'running', finishedAt: null }), 0)).toBe('0ms so far');
    expect(formatRunDuration(run({ startedAt: 8_000, finishedAt: 1_000 }), 0)).toBe('0ms');
  });
});
