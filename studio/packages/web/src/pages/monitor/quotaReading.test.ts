import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_QUOTA_UNAVAILABLE_REASONS,
  type AccountQuotaDisplayState,
} from '@autonomy-studio/shared';
import {
  formatPct,
  quotaUnavailableText,
  readAccountQuota,
  readAccountQuotas,
  type ProviderQuotaReading,
} from './quotaReading';

function stateWith(
  claude: AccountQuotaDisplayState['account']['claude'],
): AccountQuotaDisplayState {
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
      expect(quotaUnavailableText('claude', reason)).toBeTruthy();
      expect(quotaUnavailableText('claude', reason)).not.toBe(reason);
      // #990 — and every reason is sayable for EVERY provider, not just the
      // one that happened to be built first.
      expect(quotaUnavailableText('codex', reason)).toBeTruthy();
      expect(quotaUnavailableText('codex', reason)).not.toBe(reason);
    },
  );

  it('still says why when a null reading arrives with no stated reason', () => {
    const reading = readAccountQuota(stateWith(null));
    expect(reading.kind).toBe('unreadable');
    if (reading.kind !== 'unreadable') return;
    expect(reading.reason).toBe('reader_error');
  });

  /**
   * #987 — an unreadable quota MAY carry the last reading that was really
   * obtained. It never replaces the UNREADABLE statement; it is a second,
   * explicitly-aged fact beside it.
   */
  describe('last-known reading (#987)', () => {
    const LAST_KNOWN = {
      five_hour: { utilization: 0.31, resets_at: 1_785_100_200 },
      seven_day: { utilization: 0.58, resets_at: 1_785_636_000 },
    };

    it('carries the last-known windows and its age', () => {
      const reading = readAccountQuota({
        generated_at: 1_785_100_000,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: LAST_KNOWN, read_at: 1_785_099_250 },
      });

      expect(reading.kind).toBe('unreadable');
      if (reading.kind !== 'unreadable') return;
      // Still UNREADABLE, and still says why. The number does not displace it.
      expect(reading.reason).toBe('rate_limited');
      expect(reading.lastKnown?.ageMs).toBe(750_000);
      // Scaled exactly as a live reading is — same derivation, one definition.
      expect(reading.lastKnown?.windows[1]?.usedPct).toBeCloseTo(58);
      expect(reading.lastKnown?.windows[1]?.headroomPct).toBeCloseTo(42);
      expect(reading.lastKnown?.windows[0]?.resetsAtMs).toBe(1_785_100_200_000);
    });

    it('has no last-known reading when none was ever obtained', () => {
      const reading = readAccountQuota(stateWith(null));
      expect(reading.kind).toBe('unreadable');
      if (reading.kind !== 'unreadable') return;
      expect(reading.lastKnown).toBeUndefined();
    });

    /**
     * Both stamps come from a WALL clock, so a backwards step (NTP, a VM
     * resume) can put the reading after the response. A negative age is a thing
     * no wording can state honestly, so it floors at "just now".
     */
    it('floors the age at zero when the clock stepped backwards', () => {
      const reading = readAccountQuota({
        generated_at: 1_785_100_000,
        account: { claude: null },
        unavailable: { claude: 'provider_error' },
        last_known: { claude: LAST_KNOWN, read_at: 1_785_100_600 },
      });
      expect(reading.kind).toBe('unreadable');
      if (reading.kind !== 'unreadable') return;
      expect(reading.lastKnown?.ageMs).toBe(0);
    });
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

/**
 * #990 — the panel is driven by the providers the BODY carries.
 *
 * The three states, and the two that are easy to conflate: ABSENT (omitted from
 * the list entirely), UNREADABLE (a named reason, never a number) and a reading
 * (which, for a scraped provider, states its own age).
 */
describe('readAccountQuotas', () => {
  const CLAUDE = {
    five_hour: { utilization: 0.08, resets_at: 1_785_100_200 },
    seven_day: { utilization: 0.07, resets_at: 1_785_636_000 },
  };
  const GENERATED_AT = 1_786_106_974;

  /** The entry for one provider, or a failure — never an `undefined` to chain off. */
  function entry(
    providers: ProviderQuotaReading[],
    provider: 'claude' | 'codex',
  ): ProviderQuotaReading {
    const found = providers.find((p) => p.provider === provider);
    if (found === undefined) throw new Error(`no ${provider} entry in the panel`);
    return found;
  }

  /** A `reading` entry, narrowed — an unreadable one is a test failure here. */
  function windowsOf(providers: ProviderQuotaReading[], provider: 'claude' | 'codex') {
    const { reading } = entry(providers, provider);
    if (reading.kind !== 'reading') throw new Error(`${provider} was ${reading.kind}`);
    return reading;
  }

  it('lists only claude when the body carries no codex key', () => {
    const providers = readAccountQuotas(stateWith(CLAUDE));
    expect(providers.map((p) => p.provider)).toEqual(['claude']);
  });

  it('lists codex when the body carries it, labelled for the operator', () => {
    const providers = readAccountQuotas({
      generated_at: GENERATED_AT,
      account: {
        claude: CLAUDE,
        codex: {
          seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
          read_at: GENERATED_AT - 600,
        },
      },
    });
    expect(providers.map((p) => p.provider)).toEqual(['claude', 'codex']);
    expect(entry(providers, 'codex').label).toBe('Codex');
  });

  it('renders a single-window codex reading without inventing the missing window', () => {
    // The measured plus-plan shape. A placeholder 5-hour row would state a
    // figure codex never reported.
    const providers = readAccountQuotas({
      generated_at: GENERATED_AT,
      account: {
        claude: CLAUDE,
        codex: {
          seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
          read_at: GENERATED_AT,
        },
      },
    });
    const codex = windowsOf(providers, 'codex');
    expect(codex.windows).toHaveLength(1);
    expect(codex.windows.map((w) => w.label)).toEqual(['7-day']);
    const sevenDay = codex.windows.find((w) => w.label === '7-day');
    expect(sevenDay?.usedPct).toBeCloseTo(64);
    expect(sevenDay?.headroomPct).toBeCloseTo(36);
  });

  it('carries the AGE of a scraped reading, and none for a polled one', () => {
    const providers = readAccountQuotas({
      generated_at: GENERATED_AT,
      account: {
        claude: CLAUDE,
        codex: {
          seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
          read_at: GENERATED_AT - 900,
        },
      },
    });
    // Claude is polled and at most one TTL old — it has no age to state.
    expect(windowsOf(providers, 'claude').ageMs).toBeUndefined();
    expect(windowsOf(providers, 'codex').ageMs).toBe(900_000);
  });

  it('floors a negative age — a wall-clock step-back must not read as the future', () => {
    const providers = readAccountQuotas({
      generated_at: GENERATED_AT,
      account: {
        claude: CLAUDE,
        codex: {
          seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
          read_at: GENERATED_AT + 60,
        },
      },
    });
    expect(windowsOf(providers, 'codex').ageMs).toBe(0);
  });

  it('reports an UNREADABLE codex with its reason and NO number', () => {
    const providers = readAccountQuotas({
      generated_at: GENERATED_AT,
      account: { claude: CLAUDE, codex: null },
      unavailable: { codex: 'no_reading' },
    });
    const codex = entry(providers, 'codex').reading;
    expect(codex.kind).toBe('unreadable');
    if (codex.kind !== 'unreadable') throw new Error('unreachable');
    expect(codex.reason).toBe('no_reading');
    // Claude's reading survives its neighbour's failure.
    expect(entry(providers, 'claude').reading.kind).toBe('reading');
  });

  it('treats a codex reading with NO windows as UNREADABLE, not an empty table', () => {
    /*
     * The wire schema already refuses this, so it is unreachable from the
     * shipped server — but an empty table renders as a header with nothing
     * under it, which reads as "nothing to report" rather than "not known".
     * That is the fail-open presentation on the one side of the contract the
     * schema cannot reach, so it is pinned here too.
     */
    const providers = readAccountQuotas({
      generated_at: GENERATED_AT,
      account: {
        claude: CLAUDE,
        // Cast: the schema makes this unrepresentable, which is the point.
        codex: { read_at: GENERATED_AT } as unknown as NonNullable<
          AccountQuotaDisplayState['account']['codex']
        >,
      },
    });
    const codex = entry(providers, 'codex').reading;
    expect(codex.kind).toBe('unreadable');
    if (codex.kind !== 'unreadable') throw new Error('unreachable');
    expect(codex.reason).toBe('unrecognized_payload');
  });

  it('gives claude and codex DIFFERENT copy for the same reason', () => {
    // Both readers fail in different places — a Keychain token versus a session
    // directory — so identical wording would send an operator to fix the wrong
    // thing.
    expect(quotaUnavailableText('codex', 'no_credential')).not.toBe(
      quotaUnavailableText('claude', 'no_credential'),
    );
    expect(quotaUnavailableText('claude', 'no_credential')).toContain('macOS');
    expect(quotaUnavailableText('codex', 'no_credential')).toContain('codex');
  });
});
