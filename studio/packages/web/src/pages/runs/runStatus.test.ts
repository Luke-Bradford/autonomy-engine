import { describe, expect, it } from 'vitest';
import {
  RunLifecycleStatusSchema,
  RunStatusSchema,
  WaitingReasonSchema,
} from '@autonomy-studio/shared';
import { ALL_TONES } from './nodeStatus';
import { runStatusLabel, runStatusTone } from './runStatus';

describe('#870 runStatusLabel', () => {
  /**
   * The exhaustiveness the `Record<RunStatus, string>` already enforces at
   * compile time, asserted once at runtime as well — because the compile-time
   * half only fires for someone editing THIS file, and the failure mode being
   * guarded is a ninth status added to `RunStatusSchema` in `shared` reaching
   * the screen as a bare identifier.
   */
  it('words every status the DB enum can hold', () => {
    for (const status of RunStatusSchema.options) {
      // A missing key yields `undefined`, which `toBeTruthy` catches.
      expect(runStatusLabel(status), `no label for ${status}`).toBeTruthy();
    }
  });

  /**
   * The SUBSET relationship the whole one-map design rests on: the engine's
   * lifecycle enum must stay inside the DB's. `RunDetailPage` passes a
   * `RunLifecycleStatus` straight into `runStatusLabel(status: RunStatus)`, so
   * TypeScript already refuses a widening — this pins the same fact where a
   * reader of the vocabulary can see it, and covers a `z.enum` widened by
   * something the compiler cannot follow.
   */
  it('keeps the engine lifecycle enum a subset of the DB run enum', () => {
    for (const lifecycle of RunLifecycleStatusSchema.options) {
      expect(RunStatusSchema.options, `${lifecycle} is not a RunStatus`).toContain(lifecycle);
    }
  });

  it('re-words `queued` to say what the RUN is doing, not what admission did', () => {
    expect(runStatusLabel('queued')).toBe('queued (slot)');
  });

  it.each([
    ['waiting_timer', 'waiting (timer)'],
    ['waiting_external', 'waiting (callback)'],
    ['waiting_concurrency', 'waiting (slot)'],
    ['waiting_dependency', 'waiting (dependency)'],
  ] as const)('says WHAT a parked run is waiting on — %s', (reason, expected) => {
    expect(runStatusLabel('waiting', reason)).toBe(expected);
  });

  it('words every reason the engine can park on', () => {
    for (const reason of WaitingReasonSchema.options) {
      /* Matched as a SHAPE, not against a single wrong string. A missing key in
         `WAITING_REASON_LABELS` renders `waiting (undefined)` — which an
         `!== 'waiting ()'` assertion would happily pass, leaving the one
         backstop against a fifth `WaitingReason` unable to fail. */
      expect(runStatusLabel('waiting', reason), `no label for ${reason}`).toMatch(
        /^waiting \([a-z][a-z ]*\)$/,
      );
    }
  });

  it('falls back to a bare `waiting` where no reason is available (the runs LIST)', () => {
    expect(runStatusLabel('waiting')).toBe('waiting');
    expect(runStatusLabel('waiting', null)).toBe('waiting');
  });

  it('ignores a reason on a status that is not `waiting` — the reducer nulls it on unpark', () => {
    expect(runStatusLabel('running', 'waiting_timer')).toBe('running');
    expect(runStatusLabel('success', 'waiting_external')).toBe('success');
  });

  it('leaves an identifier that already reads as English alone', () => {
    expect(runStatusLabel('pending')).toBe('pending');
    expect(runStatusLabel('running')).toBe('running');
    expect(runStatusLabel('success')).toBe('success');
    expect(runStatusLabel('failure')).toBe('failure');
    expect(runStatusLabel('skipped')).toBe('skipped');
    expect(runStatusLabel('interrupted')).toBe('interrupted');
  });
});

/**
 * U29 (#1015) — the cross-run timeline paints a BAR per run, and a bar needs a
 * hue. Kept here beside the words rather than in the chart, for the reason the
 * file's header gives: the run vocabulary lives in one place and no surface owns
 * its own copy.
 */
describe('runStatusTone', () => {
  it('gives every DB run status a tone, exhaustively', () => {
    for (const status of RunStatusSchema.options) {
      expect(ALL_TONES, `no tone for ${status}`).toContain(runStatusTone(status));
    }
  });

  it('separates the terminal outcomes an operator scans for', () => {
    expect(runStatusTone('success')).toBe('success');
    expect(runStatusTone('failure')).toBe('failure');
    // `interrupted` is a FAILED outcome, not a neutral one: the run did not
    // finish what it was asked to do, and a chart that greys it out hides the
    // one row the operator is looking for.
    expect(runStatusTone('interrupted')).toBe('failure');
    expect(runStatusTone('skipped')).toBe('skipped');
  });

  it('calls a pre-admission run HOLDING, not running', () => {
    // No surface reads these two yet — `unplottableReason` keeps a `queued` run
    // off the axis and the named list beneath renders no swatch — but the map is
    // exhaustive by construction, and a pre-admission fire must never be worded
    // as executing on the day something does read them.
    expect(runStatusTone('queued')).toBe('holding');
    expect(runStatusTone('pending')).toBe('holding');
    expect(runStatusTone('waiting')).toBe('holding');
    expect(runStatusTone('running')).toBe('running');
  });
});
