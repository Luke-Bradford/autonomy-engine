import { describe, expect, it } from 'vitest';
import type { ClaudeAccountQuota } from '@autonomy-studio/shared';
import type { AccountQuotaReading, ClaudeAccountQuotaReader } from '../claude-quota.js';
import { createLastKnownQuotaRecorder } from '../last-known.js';

/**
 * #987 — the recorder holds the last OBTAINED reading for the display surface,
 * without altering a single thing its inner reader says.
 */

function quota(utilization: number): ClaudeAccountQuota {
  return {
    five_hour: { utilization, resets_at: 1_800_000_000 },
    seven_day: { utilization, resets_at: 1_800_600_000 },
  };
}

/** A reader that hands out a scripted sequence of outcomes, one per read. */
function scriptedReader(outcomes: AccountQuotaReading[]): ClaudeAccountQuotaReader & {
  reads: () => number;
} {
  let i = 0;
  return {
    read: async () => {
      // `.at` + an explicit throw rather than an index assertion: an empty
      // script is a broken test, and it should say so rather than resolve
      // `undefined` into a reading.
      const outcome = outcomes.at(Math.min(i, outcomes.length - 1));
      if (outcome === undefined) throw new Error('scriptedReader: empty script');
      i += 1;
      return outcome;
    },
    reads: () => i,
  };
}

describe('createLastKnownQuotaRecorder', () => {
  it('retains nothing until a reading has actually been obtained', async () => {
    const recorder = createLastKnownQuotaRecorder(
      scriptedReader([{ value: null, unavailable: 'rate_limited' }]),
    );
    expect(recorder.lastKnown()).toBeNull();
    await recorder.reader.read();
    expect(recorder.lastKnown()).toBeNull();
  });

  it('retains a reading with the instant it was taken', async () => {
    const recorder = createLastKnownQuotaRecorder(
      scriptedReader([{ value: quota(0.58), unavailable: null }]),
      () => 5_000,
    );
    await recorder.reader.read();
    expect(recorder.lastKnown()).toEqual({ value: quota(0.58), readAtMs: 5_000 });
  });

  /**
   * #1023 — a reading with only the 7-day window is a reading, so it is
   * retainable like any other.
   *
   * Worth pinning rather than assuming: the recorder keys on `value !== null`,
   * and a partial reading is not null. If it were ever narrowed to "a complete
   * reading", the operator's panel would lose its stale fallback exactly on the
   * shape the provider sends most of the day — the failure this ticket removed,
   * reappearing one module over.
   */
  it('retains a reading that carries only the 7-day window', async () => {
    const partial = { seven_day: { utilization: 0.41, resets_at: null } };
    const recorder = createLastKnownQuotaRecorder(
      scriptedReader([
        { value: partial, unavailable: null },
        { value: null, unavailable: 'rate_limited' },
      ]),
      () => 9_000,
    );
    await recorder.reader.read();
    await recorder.reader.read();
    expect(recorder.lastKnown()).toEqual({ value: partial, readAtMs: 9_000 });
  });

  /**
   * THE POINT OF THE MODULE. This is the state the operator was in: a good
   * reading minutes ago, the provider 429ing now.
   */
  it('keeps the last obtained reading across a subsequent failure', async () => {
    const recorder = createLastKnownQuotaRecorder(
      scriptedReader([
        { value: quota(0.58), unavailable: null },
        { value: null, unavailable: 'rate_limited' },
      ]),
      () => 5_000,
    );
    await recorder.reader.read();
    const failed = await recorder.reader.read();

    expect(failed).toEqual({ value: null, unavailable: 'rate_limited' });
    expect(recorder.lastKnown()).toEqual({ value: quota(0.58), readAtMs: 5_000 });
  });

  it('returns its inner reader outcomes unchanged, success and failure alike', async () => {
    const success: AccountQuotaReading = { value: quota(0.1), unavailable: null };
    const failure: AccountQuotaReading = { value: null, unavailable: 'no_credential' };
    const recorder = createLastKnownQuotaRecorder(scriptedReader([success, failure]));

    // Identity, not equality: the wrapper must not even re-wrap the object, or
    // the reader's own TTL-cache-hit identity (which the age dedupe below leans
    // on) would stop being observable through it.
    expect(await recorder.reader.read()).toBe(success);
    expect(await recorder.reader.read()).toBe(failure);
  });

  it('does not re-stamp the age when the reader serves the same cached outcome', async () => {
    // The real reader returns the SAME object for every read inside its 60s
    // TTL. Re-stamping on a cache hit would report a minute-old reading as
    // brand new — an age wrong in the looks-fresher direction.
    const cached: AccountQuotaReading = { value: quota(0.42), unavailable: null };
    let clock = 1_000;
    const recorder = createLastKnownQuotaRecorder({ read: async () => cached }, () => clock);

    await recorder.reader.read();
    clock = 61_000;
    await recorder.reader.read();

    expect(recorder.lastKnown()).toEqual({ value: quota(0.42), readAtMs: 1_000 });
  });

  it('re-stamps when a genuinely new reading arrives', async () => {
    let clock = 1_000;
    const recorder = createLastKnownQuotaRecorder(
      scriptedReader([
        { value: quota(0.42), unavailable: null },
        { value: quota(0.61), unavailable: null },
      ]),
      () => clock,
    );

    await recorder.reader.read();
    clock = 61_000;
    await recorder.reader.read();

    expect(recorder.lastKnown()).toEqual({ value: quota(0.61), readAtMs: 61_000 });
  });

  it('records before resolving, so a caller can read it in the same turn', async () => {
    const recorder = createLastKnownQuotaRecorder(
      scriptedReader([{ value: quota(0.3), unavailable: null }]),
    );
    await recorder.reader.read();
    // No `await` gap, no microtask flush: the record must have landed by the
    // time `read()` resolves, or a route can build its body without it.
    expect(recorder.lastKnown()).not.toBeNull();
  });
});
