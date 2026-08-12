import type {
  AccountQuotaDisplayState,
  AccountQuotaProvider,
  AccountQuotaUnavailableReason,
  AccountQuotaWindow,
  ClaudeAccountQuota,
  CodexAccountQuota,
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
 * a CURRENT number. "0%" is the single most dangerous thing this surface could
 * say — it means "wide open, spend freely", which is the exact opposite of "I do
 * not know". So the unreadable case is a distinct variant of the union below
 * rather than a zeroed reading, and no absent reading is ever substituted for.
 *
 * #987 SPLIT THAT RULE PRECISELY, and this paragraph is the record of where the
 * line now is. An `unreadable` reading MAY carry `lastKnown` — a number that was
 * really obtained, with the age it was obtained at. It is not a fallback and not
 * a default: it never replaces the UNREADABLE statement (which stays, with its
 * reason), it renders only inside an explicitly-labelled stale block, and it
 * always states its own age. What remains forbidden is exactly what was
 * forbidden before — presenting an absent reading AS the current one, or
 * manufacturing a percentage from nothing. A twelve-minute-old number an
 * operator can see is old is useful; the same number presented as live is the
 * fail-open failure.
 *
 * The GUARD's contract is untouched by any of this: `loop/drive.sh` reads
 * `/api/quota`, which never carries a last-known value at all.
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
  /**
   * When this window resets, epoch MILLISECONDS (converted from the wire's
   * seconds) — or `null` when the provider did not report an instant (#1023).
   *
   * Nullable rather than coalesced, and that is the whole point of the type. A
   * `?? 0` here typechecks and renders as `1/1/1970`: a plausible date, with no
   * relative suffix to mark it odd, for a fact nobody reported. The renderer
   * already speaks this language — `formatWhen` takes `number | null` and gives
   * an em-dash — so the honest value survives to the cell unaided.
   */
  resetsAtMs: number | null;
}

/**
 * A reading that was really obtained, and how old it was when the server
 * answered (#987).
 *
 * `ageMs` is computed SERVER-side in effect — from `generated_at - read_at`, two
 * stamps from the same clock in the same response — so no browser clock skew
 * enters it. It is fixed at response time rather than ticking, matching the rest
 * of this panel, which is a point-in-time snapshot refreshed on demand.
 */
export interface LastKnownQuotaReading {
  windows: QuotaWindowReading[];
  ageMs: number;
}

export type QuotaReading =
  | {
      kind: 'reading';
      windows: QuotaWindowReading[];
      generatedAtMs: number;
      /**
       * How old the reading was when the server answered, when the provider's
       * reading is a SCRAPE rather than a live poll (#990).
       *
       * Absent for a polled provider, whose reading is at most one TTL old and
       * has no age worth stating. Present for codex, whose figure is whatever
       * its CLI last wrote — possibly days ago. Rendering that beside a live
       * one with no age is the fail-open presentation this module's docblock
       * forbids, so the age travels WITH the reading rather than being an
       * optional decoration the renderer may forget.
       */
      ageMs?: number;
    }
  | {
      kind: 'unreadable';
      reason: AccountQuotaUnavailableReason;
      generatedAtMs: number;
      /** The last reading obtained this server session, if there was one. */
      lastKnown?: LastKnownQuotaReading;
    };

/**
 * When a last-known reading stops being merely old and starts being EVIDENCE
 * that the provider is refusing.
 *
 * Derived from the reader, not chosen: the server's TTL is 60s and the
 * background sampler ticks at half of that, so anything past ~2 TTLs means
 * several sample attempts in a row have failed. A threshold picked for how old
 * a number "feels" (15 minutes, say) would show a quarter of an hour of stale
 * data unmarked — and 900s is also, exactly, the prototype grace window this
 * whole surface exists to have rejected, so it is the one number not to reuse.
 */
export const QUOTA_STALE_AFTER_MS = 2 * 60_000;

/** The wire's per-window seconds/fraction shape → the rendered percent/ms shape. */
function readWindow(label: string, window: AccountQuotaWindow): QuotaWindowReading {
  const usedPct = window.utilization * 100;
  return {
    label,
    usedPct,
    headroomPct: Math.max(0, 100 - usedPct),
    overage: window.overage === true,
    resetsAtMs: window.resets_at === null ? null : window.resets_at * 1000,
  };
}

/**
 * The whole reading.
 *
 * The wire contract used to be all-or-nothing — both windows present or the
 * reading `null` — and this said so. #1023 removed that: `five_hour` is now
 * absent whenever the provider did not report one, so a reading may carry one
 * window or two. What did NOT change is the part that matters here: a reading
 * is still either obtained or `null`, so there is still no half-reading to
 * mistake for evidence. The partial-ness is in WHICH WINDOWS were reported, not
 * in how sure we are of them.
 */
export function readAccountQuota(state: AccountQuotaDisplayState): QuotaReading {
  const generatedAtMs = state.generated_at * 1000;
  const claude = state.account.claude;
  if (claude === null) {
    const retained = state.last_known;
    /*
     * `unavailable` is guaranteed present alongside a null reading by the wire
     * schema's own refinement, so this fallback is unreachable from the shipped
     * server. It is a REASON rather than a thrown error because this surface's
     * job is to say what it does not know: an exception here would blank the
     * panel, which reads as "nothing to report" — the fail-open shape again.
     */
    return {
      kind: 'unreadable',
      reason: state.unavailable?.claude ?? 'reader_error',
      generatedAtMs,
      ...(retained === undefined
        ? {}
        : {
            lastKnown: {
              windows: readWindows(retained.claude),
              // Floored, because both stamps come from a WALL clock: a
              // backwards step between the reading and the response would
              // otherwise produce a negative age, which no wording can state
              // honestly. The server floors it too; this is the second half of
              // the same guard, on the side that does the rendering.
              ageMs: Math.max(0, generatedAtMs - retained.read_at * 1000),
            },
          }),
    };
  }
  return { kind: 'reading', generatedAtMs, windows: readWindows(claude) };
}

/**
 * The windows a reading actually carries, in the order they read.
 *
 * ONE definition for both providers (#1023). It used to be two: claude's pair
 * was mandatory and codex's windows were individually optional, because a
 * `plus` plan reports only the 7-day one (#990) and emitting a placeholder row
 * for the other would state a figure nobody reported. #1023 measured the
 * provider doing the same thing on claude's side — no `five_hour` while there
 * is no active session — so the two shapes converged, and the reason codex's
 * version was written is now the reason for both.
 *
 * A window that is absent produces NO ROW. That is the whole contract: a row
 * with a blank or zeroed figure would be a claim, and there is nothing to claim.
 */
function readWindows(quota: {
  five_hour?: AccountQuotaWindow;
  seven_day?: AccountQuotaWindow;
}): QuotaWindowReading[] {
  const windows: QuotaWindowReading[] = [];
  if (quota.five_hour !== undefined) windows.push(readWindow('5-hour', quota.five_hour));
  if (quota.seven_day !== undefined) windows.push(readWindow('7-day', quota.seven_day));
  return windows;
}

/** One provider's row in the panel: who it is, and what is known about them. */
export interface ProviderQuotaReading {
  provider: AccountQuotaProvider;
  /** The provider's name as the operator reads it. */
  label: string;
  reading: QuotaReading;
}

const PROVIDER_LABELS: Record<AccountQuotaProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Every provider the body actually carries, in a fixed order (#990).
 *
 * Driven by the KEYS PRESENT, not by a hardcoded pair: a provider absent from
 * the body is absent from the panel, and a provider added to the body later
 * renders with no change here beyond a label. ABSENT is therefore expressed by
 * omission — which is what keeps it distinct from UNREADABLE, the failure this
 * ticket exists to stop conflating.
 */
export function readAccountQuotas(state: AccountQuotaDisplayState): ProviderQuotaReading[] {
  const generatedAtMs = state.generated_at * 1000;
  const providers: ProviderQuotaReading[] = [
    { provider: 'claude', label: PROVIDER_LABELS.claude, reading: readAccountQuota(state) },
  ];
  const codex = state.account.codex;
  if (codex !== undefined) {
    providers.push({
      provider: 'codex',
      label: PROVIDER_LABELS.codex,
      reading: readCodexQuota(codex, state.unavailable?.codex, generatedAtMs),
    });
  }
  return providers;
}

function readCodexQuota(
  codex: CodexAccountQuota | null,
  reason: AccountQuotaUnavailableReason | undefined,
  generatedAtMs: number,
): QuotaReading {
  if (codex === null) {
    return { kind: 'unreadable', reason: reason ?? 'reader_error', generatedAtMs };
  }
  const windows = readWindows(codex);
  /*
   * A reading whose windows all fell away is UNREADABLE, never an empty table.
   * The wire schema already refuses this shape, so it is unreachable from the
   * shipped server — but an empty `QuotaWindowTable` renders as a header with
   * nothing under it, which reads as "nothing to report" rather than "not
   * known", and that is the fail-open presentation on the one side of the
   * contract the schema cannot reach.
   */
  if (windows.length === 0) {
    return { kind: 'unreadable', reason: 'unrecognized_payload', generatedAtMs };
  }
  return {
    kind: 'reading',
    generatedAtMs,
    windows,
    // Floored for the same wall-clock reason the last-known age is.
    ageMs: Math.max(0, generatedAtMs - codex.read_at * 1000),
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
const QUOTA_UNAVAILABLE_TEXT: Record<AccountQuotaUnavailableReason, string> = {
  disabled: 'Quota reading is switched off on this server.',
  no_credential: 'No credential to read with on this host.',
  rate_limited:
    'The provider is rate-limiting the reading. The account is busy; the reader is backing off rather than making it worse.',
  provider_error: 'The provider call failed, so no reading could be taken.',
  unrecognized_payload: 'The provider answered in a shape this reader does not recognise.',
  no_reading: 'The source is there, but holds no usable reading yet.',
  reader_error:
    'The quota reader itself failed. This should not happen; it is reported rather than hidden.',
};

/**
 * Where a provider's cause differs from the generic one above (#990).
 *
 * Overrides rather than a second full table: the generic wording stays correct
 * for every reason neither provider needs to specialise, and only the ones that
 * would send an operator to fix the wrong thing are restated. The two readers
 * fail in genuinely different places — claude has an OAuth token in a macOS
 * Keychain, codex has a directory of session files — so "no credential" means
 * two different repairs.
 */
const PROVIDER_UNAVAILABLE_TEXT: Record<
  AccountQuotaProvider,
  Partial<Record<AccountQuotaUnavailableReason, string>>
> = {
  claude: {
    no_credential:
      'No credential to read with — there is no subscription token on this host (quota readings are macOS-only).',
  },
  codex: {
    no_credential: 'No codex session data on this host — is the codex CLI installed?',
    no_reading:
      'Codex is installed but has not run recently enough to have reported a quota. Its figure comes from its own session records, so running it once will produce one.',
    unrecognized_payload: 'Codex wrote a usage record this reader could not read a window out of.',
  },
};

export function quotaUnavailableText(
  provider: AccountQuotaProvider,
  reason: AccountQuotaUnavailableReason,
): string {
  return PROVIDER_UNAVAILABLE_TEXT[provider][reason] ?? QUOTA_UNAVAILABLE_TEXT[reason];
}

/** A percentage → at most one decimal place, without a trailing `.0`. */
export function formatPct(pct: number): string {
  return `${Math.round(pct * 10) / 10}%`;
}
