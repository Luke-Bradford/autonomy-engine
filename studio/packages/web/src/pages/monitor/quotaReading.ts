import type {
  AccountQuotaState,
  AccountQuotaUnavailableReason,
  AccountQuotaWindow,
} from '@autonomy-studio/shared';

/**
 * #917 — how an account-quota reading is WRITTEN DOWN.
 *
 * A pure derivation, separated from the component for the same reason
 * `costReading.ts` is: the two unit conversions here are silent-failure shaped,
 * so they belong somewhere a test can hold them still.
 *
 *  - `utilization` is a FRACTION (`0.07`), never a percent. Rendering it raw
 *    reads as "7% used" when it is 7%, and as "0.07% used" — reassuringly tiny —
 *    when it is 7%. Nothing about the number's TYPE catches that.
 *  - `resets_at` is epoch SECONDS, and every JS date API takes milliseconds.
 *    Forgetting the ×1000 puts the reset instant in January 1970, which renders
 *    as a plausible-looking date rather than as an error.
 *
 * THE FAIL-OPEN RULE: an unreadable quota must render as UNREADABLE and never as
 * a number. "0%" is the single most dangerous thing this surface could say —
 * it means "wide open, spend freely", which is the exact opposite of "I do not
 * know". So the unreadable case is a distinct variant of the union below rather
 * than a zeroed reading, and there is deliberately no code path from an absent
 * reading to a percentage.
 */

export interface QuotaWindowReading {
  /** Which window, as the operator reads it. */
  label: string;
  /** `utilization` scaled to a percentage — MAY exceed 100 when on overage. */
  usedPct: number;
  /**
   * How much of the window is left, as a percentage, floored at 0.
   *
   * Floored rather than allowed negative because "-14% remaining" is not a
   * quantity anyone can act on; on overage the honest statement is "none left,
   * and drawing on overage credit", which `overage` carries separately.
   */
  headroomPct: number;
  /** True when the account is drawing on overage credit. */
  overage: boolean;
  /** When this window resets, epoch MILLISECONDS (converted from the wire's seconds). */
  resetsAtMs: number;
}

export type QuotaReading =
  | { kind: 'reading'; windows: QuotaWindowReading[]; generatedAtMs: number }
  | { kind: 'unreadable'; reason: AccountQuotaUnavailableReason; generatedAtMs: number };

/** The wire's per-window seconds/fraction shape → the rendered percent/ms shape. */
function readWindow(label: string, window: AccountQuotaWindow): QuotaWindowReading {
  const usedPct = window.utilization * 100;
  return {
    label,
    usedPct,
    headroomPct: Math.max(0, 100 - usedPct),
    overage: window.overage === true,
    resetsAtMs: window.resets_at * 1000,
  };
}

/**
 * The whole reading. ALL-OR-NOTHING, inherited from the wire contract: both
 * windows are present or the reading is `null`, so there is no partial state to
 * represent and no half-reading to mistake for evidence.
 */
export function readAccountQuota(state: AccountQuotaState): QuotaReading {
  const generatedAtMs = state.generated_at * 1000;
  const claude = state.account.claude;
  if (claude === null) {
    /*
     * `unavailable` is guaranteed present alongside a null reading by the wire
     * schema's own refinement, so this fallback is unreachable from the shipped
     * server. It is a REASON rather than a thrown error because this surface's
     * job is to say what it does not know: an exception here would blank the
     * panel, which reads as "nothing to report" — the fail-open shape again.
     */
    return { kind: 'unreadable', reason: state.unavailable?.claude ?? 'reader_error', generatedAtMs };
  }
  return {
    kind: 'reading',
    generatedAtMs,
    windows: [readWindow('5-hour', claude.five_hour), readWindow('7-day', claude.seven_day)],
  };
}

/**
 * Why there is no reading, in the operator's terms.
 *
 * Every reason is spelled out rather than defaulted, so a newly-added member of
 * `ACCOUNT_QUOTA_UNAVAILABLE_REASONS` is a typecheck failure here rather than a
 * raw enum token leaking into the UI. Each says what it means for the READER,
 * because the distinction that matters to an operator is "my setup is wrong"
 * versus "the account is busy and the reader is correctly backing off".
 */
export const QUOTA_UNAVAILABLE_TEXT: Record<AccountQuotaUnavailableReason, string> = {
  disabled: 'Quota reading is switched off on this server.',
  no_credential:
    'No credential to read with — there is no subscription token on this host (quota readings are macOS-only).',
  rate_limited:
    'The provider is rate-limiting the reading. The account is busy; the reader is backing off rather than making it worse.',
  provider_error: 'The provider call failed, so no reading could be taken.',
  unrecognized_payload: 'The provider answered in a shape this reader does not recognise.',
  reader_error: 'The quota reader itself failed. This should not happen; it is reported rather than hidden.',
};

/** A percentage → at most one decimal place, without a trailing `.0`. */
export function formatPct(pct: number): string {
  return `${Math.round(pct * 10) / 10}%`;
}
