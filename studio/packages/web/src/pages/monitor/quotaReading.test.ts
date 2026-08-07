import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_QUOTA_UNAVAILABLE_REASONS,
  type AccountQuotaState,
} from '@autonomy-studio/shared';
import { QUOTA_UNAVAILABLE_TEXT, formatPct, readAccountQuota } from './quotaReading';

function stateWith(claude: AccountQuotaState['account']['claude']): AccountQuotaState {
  return { generated_at: 1_785_100_000, account: { claude } };
}

describe('readAccountQuota', () => {
  /**
   * The fraction/percent trap. `0.07` is SEVEN PERCENT; rendering it raw would
   * say "0.07%", which reads as reassuringly empty when the window is 7% gone.
   */
  it('scales the wire fraction to a percentage', () => {
    const reading = readAccountQuota(
      stateWith({
        five_hour: { utilization: 0.08, resets_at: 1_785_100_200 },
        seven_day: { utilization: 0.07, resets_at: 1_785_636_000 },
      }),
    );

    expect(reading.kind).toBe('reading');
    if (reading.kind !== 'reading') return;
    expect(reading.windows[0]?.usedPct).toBeCloseTo(8);
    expect(reading.windows[1]?.usedPct).toBeCloseTo(7);
  });

  /**
   * The seconds/ms trap. Missing the ×1000 dates the reset to January 1970 —
   * a plausible-looking date rather than a visible error.
   */
  it('converts the reset instant from epoch seconds to milliseconds', () => {
    const reading = readAccountQuota(
      stateWith({
        five_hour: { utilization: 0.5, resets_at: 1_785_100_200 },
        seven_day: { utilization: 0.5, resets_at: 1_785_636_000 },
      }),
    );

    if (reading.kind !== 'reading') throw new Error('expected a reading');
    expect(reading.windows[0]?.resetsAtMs).toBe(1_785_100_200_000);
    expect(reading.windows[1]?.resetsAtMs).toBe(1_785_636_000_000);
    expect(new Date(reading.windows[0]!.resetsAtMs).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('stamps the response instant in milliseconds too', () => {
    const reading = readAccountQuota(
      stateWith({
        five_hour: { utilization: 0.1, resets_at: 1 },
        seven_day: { utilization: 0.1, resets_at: 2 },
      }),
    );
    expect(reading.generatedAtMs).toBe(1_785_100_000_000);
  });

  it('reports headroom as the remainder of the window', () => {
    const reading = readAccountQuota(
      stateWith({
        five_hour: { utilization: 0.25, resets_at: 1 },
        seven_day: { utilization: 0.96, resets_at: 2 },
      }),
    );

    if (reading.kind !== 'reading') throw new Error('expected a reading');
    expect(reading.windows[0]?.headroomPct).toBeCloseTo(75);
    expect(reading.windows[1]?.headroomPct).toBeCloseTo(4);
  });

  /**
   * Utilization above 1 is legitimate (overage credit). Headroom floors at zero
   * rather than going negative — "none left" is actionable, "-14% left" is not.
   */
  it('floors headroom at zero on overage and flags it', () => {
    const reading = readAccountQuota(
      stateWith({
        five_hour: { utilization: 1.14, resets_at: 1, overage: true },
        seven_day: { utilization: 0.2, resets_at: 2 },
      }),
    );

    if (reading.kind !== 'reading') throw new Error('expected a reading');
    expect(reading.windows[0]?.usedPct).toBeCloseTo(114);
    expect(reading.windows[0]?.headroomPct).toBe(0);
    expect(reading.windows[0]?.overage).toBe(true);
    expect(reading.windows[1]?.overage).toBe(false);
  });

  /**
   * THE fail-open guard. An unreadable quota must never reach a percentage —
   * "0%" means "wide open, spend freely", the exact opposite of "I don't know".
   */
  it.each(ACCOUNT_QUOTA_UNAVAILABLE_REASONS)(
    'renders an unreadable quota (%s) as a named reason, never as a number',
    (reason) => {
      const reading = readAccountQuota({
        generated_at: 1_785_100_000,
        account: { claude: null },
        unavailable: { claude: reason },
      });

      expect(reading.kind).toBe('unreadable');
      if (reading.kind !== 'unreadable') return;
      expect(reading.reason).toBe(reason);
      // No path from an absent reading to a window figure.
      expect(reading).not.toHaveProperty('windows');
      // Every reason has operator-facing prose, and none of it is a bare token.
      expect(QUOTA_UNAVAILABLE_TEXT[reason]).toBeTruthy();
      expect(QUOTA_UNAVAILABLE_TEXT[reason]).not.toBe(reason);
    },
  );

  it('still says why when a null reading arrives with no stated reason', () => {
    const reading = readAccountQuota(stateWith(null));
    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.reason).toBe('reader_error');
  });
});

describe('formatPct', () => {
  it('keeps at most one decimal and drops a trailing zero', () => {
    expect(formatPct(7)).toBe('7%');
    expect(formatPct(96.25)).toBe('96.3%');
    expect(formatPct(0.04)).toBe('0%');
  });

  /** A tiny non-zero utilization must not be rounded into the fail-open "0%"
   * claim without qualification — it renders as 0% only because it IS ~0, and
   * the panel shows the raw window alongside. Pinned so the rounding cannot
   * later be widened to swallow, say, 0.4%. */
  it('does not round a meaningful percentage down to zero', () => {
    expect(formatPct(0.5)).toBe('0.5%');
  });
});
