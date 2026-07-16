import { buildDedupeKey, type ArmWakeupInput, type ScheduledWakeup } from '@autonomy-studio/shared';
import type { RetryAlarms } from '../driver.js';

/**
 * An in-memory `RetryAlarms` for driver tests — the sibling of `stub-executor`.
 *
 * It is NOT a mock that records calls and returns a fixture: it reproduces the
 * one behaviour the driver actually depends on, which is `armWakeup`'s
 * IDEMPOTENCE by `(kind, dedupeKey)`. A replayed `scheduleRetry` must return the
 * EXISTING row, because `driver.ts` stamps `node.retryScheduled.nextAttemptAt`
 * from the returned row's `dueAt` — a stub that always returned a fresh row
 * would make a replay look correct here while the real repo diverged.
 * `buildDedupeKey` is the real one, so the key rule cannot drift either.
 *
 * Tests wanting the REAL arming path use `armWakeup` against a real db instead;
 * this exists so the ~20 driver/executor/launcher tests that never retry can
 * satisfy the required seam in one line.
 */
export interface StubAlarms extends RetryAlarms {
  /** Every row armed, in arm order (deduped — a re-arm adds nothing). */
  readonly armed: ScheduledWakeup[];
  /** Arm calls made, INCLUDING ones deduped to an existing row. */
  readonly armCalls: ArmWakeupInput[];
}

export function stubAlarms(): StubAlarms {
  const armed: ScheduledWakeup[] = [];
  const armCalls: ArmWakeupInput[] = [];
  const byKey = new Map<string, ScheduledWakeup>();
  let n = 0;

  return {
    armed,
    armCalls,
    arm(input: ArmWakeupInput): ScheduledWakeup {
      armCalls.push(input);
      const dedupeKey = buildDedupeKey(input);
      const existing = byKey.get(`${input.kind}:${dedupeKey}`);
      // Idempotent by (kind, dedupeKey) — the real repo's rule.
      if (existing !== undefined) return existing;
      n += 1;
      const row: ScheduledWakeup = {
        id: `wk-${n}`,
        kind: input.kind,
        ref: input.ref,
        dueAt: input.dueAt,
        dedupeKey,
        status: 'pending',
        firedAt: null,
      };
      byKey.set(`${input.kind}:${dedupeKey}`, row);
      armed.push(row);
      return row;
    },
  };
}

/**
 * A `RetryAlarms` that FAILS if anything tries to arm — for a path that provably
 * never retries, mirroring `reconcile.ts`'s `refuseToExecute`. Fail loud rather
 * than silently accept an alarm nothing will deliver.
 */
export const refuseToArm: RetryAlarms = {
  arm() {
    throw new Error('this path must not arm a retry alarm');
  },
};
