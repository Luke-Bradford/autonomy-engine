import { describe, expect, it } from 'vitest';
import {
  RunLifecycleStatusSchema,
  RunStatusSchema,
  WaitingReasonSchema,
} from '@autonomy-studio/shared';
import { runStatusLabel } from './runStatus';

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
      const label = runStatusLabel(status);
      expect(label, `no label for ${status}`).toBeTruthy();
      expect(label).not.toBe('undefined');
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
      expect(runStatusLabel('waiting', reason), `no label for ${reason}`).not.toBe('waiting ()');
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
