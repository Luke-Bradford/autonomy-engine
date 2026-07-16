import { vi, type Mock } from 'vitest';

import type { SchedulerLog } from '../scheduler.js';

/** A spy typed to a `SchedulerLog` channel's exact signature (not a bare `Mock`,
 * whose args/return would collapse to `any` and weaken the structural check that
 * `silentLog()` really matches `SchedulerLog`). */
type LogSpy = Mock<(obj: unknown, msg?: string) => void>;

/**
 * A no-op logger whose methods are spies — for tests that must supply the
 * now-REQUIRED `log` dependency (#470) but do not assert on it. Shared so the
 * three scheduler test files agree on one shape instead of each redefining it.
 *
 * The explicit return type is required (not just tidy): an EXPORTED function's
 * inferred type must be nameable across the package boundary, and the bare
 * `vi.fn()` inference references a non-portable internal (`Procedure`), so tsc
 * (TS2883) refuses it. Keyed off `SchedulerLog` so the shape stays coupled to
 * the seam it stands in for; the `Mock` surface lets a caller still assert on it
 * (`expect(log.error).toHaveBeenCalled()`). A test that must assert on ONE named
 * channel's exact call count builds that spy inline instead.
 */
export function silentLog(): Record<keyof SchedulerLog, LogSpy> {
  return { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}
