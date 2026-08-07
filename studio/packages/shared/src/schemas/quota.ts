import { z } from 'zod';

/**
 * #440 (C1) — the machine-readable ACCOUNT QUOTA surface.
 *
 * This is the studio-native replacement for the prototype engine dashboard's
 * `GET /api/state`, built for ONE specific consumer: the build loop's own spend
 * guard (`loop/drive.sh`'s `quota_pct()`), which refuses to fire when the
 * account's 7-day utilization is at or above `QUOTA_STOP_PCT`. When the old
 * bash/python engine is parked (#410) that endpoint disappears, and this takes
 * its place. NOTE, as of C2 (2026-07-29), it is the guard's LAST source, not its
 * primary: this reader is lazy, so every read is a direct upstream poll, and
 * that upstream 429s under direct polling — making it primary would have
 * disarmed the guard. Promotion is gated on #765 (add a background sampler, and
 * supervise a studio server at all). (It is not the guard's ONLY defence:
 * `drive.sh` also keeps a last-known cache that it trusts in the refuse
 * direction only, and a bounded blind-fire allowance. Those bound the damage;
 * they are not a substitute for knowing the number.)
 *
 * ## Why snake_case in a camelCase codebase
 *
 * `loop/drive.sh` parses a HARD-CODED path out of the response:
 *
 * ```python
 * d['account']['claude']['seven_day']['utilization']
 * ```
 *
 * Keeping that exact shape meant the cutover needed no parser change: C2 added
 * this URL as an additional source read through the SAME parser, and the tests
 * that pin it were untouched. (`DASH_URL` itself was deliberately not repointed —
 * see the note above and #765.) This file is
 * therefore a deliberate, documented COMPAT CONTRACT and the one
 * snake_case surface in the API — not a style lapse, and not a precedent for
 * anything else. Changing a key here is a BREAKING change to the spend guard;
 * `loop/test_quota_guard.sh` is what pins the consumer side.
 *
 * NOT to be confused with the server's `repo/connection-quota.ts` /
 * `connection_quota_state`, which is an entirely unrelated concept: the
 * per-CONNECTION rate-limit reset window used by the executor's admission gate.
 * This file is the ACCOUNT's subscription utilization. Hence the `Account`
 * prefix on every type here.
 *
 * ## The two load-bearing properties (both pinned by tests)
 *
 * 1. **UNREADABLE is distinct from `0`.** When the reading cannot be obtained,
 *    `account.claude` is `null` — the whole subtree, exactly as the prototype
 *    did. It is never `0`, and `utilization` is never a stand-in for "unknown".
 *    A monitoring surface that reports 0% when it means "I don't know" silently
 *    disarms the guard, which is the same fail-open shape as manufacturing an
 *    empty default for absent data (#473) or reading a `gh` API failure as
 *    CI-green. The consumer relies on the distinction: a numeric reading takes
 *    the threshold branch, an absent one takes the bounded blind-fire branch.
 * 2. **`utilization` is a 0-1 FRACTION, not a percent.** The upstream endpoint
 *    reports a percent (`7.0`); the prototype divided by 100 and the consumer
 *    multiplies by 100 again (`int(round(u * 100))`). Emitting a percent here
 *    would read as 700% (fail-safe but permanently refusing); emitting a
 *    fraction where a percent was expected would read as 0% (fail-OPEN). The
 *    round-trip is asserted, not assumed.
 */

/**
 * One rate-limit window of the account's subscription usage.
 *
 * `resets_at` is epoch **SECONDS** (not milliseconds — `Date.parse` returns ms,
 * which is the easy way to get this wrong by a factor of 1000). `overage` is
 * present only when true, mirroring the prototype's conditional key.
 */
export const AccountQuotaWindowSchema = z
  .object({
    /**
     * Fraction of the window consumed. NEVER a percent: the provider's `7.0`
     * arrives here as `0.07`. `1.0` is the full window; values ABOVE 1 are
     * legitimate and expected when the account draws on overage credit, which
     * is why there is a lower bound but no upper one.
     */
    utilization: z.number().min(0),
    /** When this window resets, epoch SECONDS. */
    resets_at: z.number().int(),
    /** Present only when the account is drawing on overage credit. */
    overage: z.literal(true).optional(),
  })
  .strict();

export type AccountQuotaWindow = z.infer<typeof AccountQuotaWindowSchema>;

/**
 * A complete account-quota reading. ALL-OR-NOTHING: both windows must be
 * present and valid or the whole reading degrades to `null` (UNREADABLE),
 * inherited from the prototype's `_build` — a partial payload is a confusing
 * live/stale mix, and half a reading is not evidence.
 *
 * There is deliberately NO `source`/freshness discriminator. The prototype
 * carried one because it had two sources and a 900s grace window to badge; this
 * reader has neither (see `claude-quota.ts`), so every reading here is a fresh
 * live sample by construction. A field with exactly one possible value is an
 * inert wire surface that implies alternatives which do not exist.
 *
 * That still holds, and #987 is the reason to say so precisely rather than
 * loosely: the DISPLAY body (`AccountQuotaDisplayStateSchema`) carries an
 * explicitly-aged last-known reading, and this one still does not. The age lives
 * on the envelope around the reading, never on the reading itself, so a
 * `ClaudeAccountQuota` value remains a thing with no freshness to interpret.
 */
export const ClaudeAccountQuotaSchema = z
  .object({
    five_hour: AccountQuotaWindowSchema,
    seven_day: AccountQuotaWindowSchema,
  })
  .strict();

export type ClaudeAccountQuota = z.infer<typeof ClaudeAccountQuotaSchema>;

/**
 * WHY a reading could not be obtained (#825). Advisory attribution for a
 * `null`, never a substitute for a number.
 *
 * `account.claude: null` is total by design — every failure collapses to it, so
 * the guard's two branches stay simple. The cost is that it conflates causes
 * that mean very different things, which matters because the C3 decision (park
 * the old engine, #410) is made on a RUN of `quota shadow: studio UNREADABLE`
 * lines in `loop/logs/driver.log`. Measured 2026-07-31: studio was rate-limited
 * for ~7.8h straight while the shared account bucket was contended, and the one
 * probe taken in that window logged a bare UNREADABLE — which reads as "studio's
 * reader is broken" when the truth was "the account was busy, and the backoff
 * was correctly declining to make it worse". Opposite errors are available too:
 * most of that contention DISAPPEARS once the old dashboard's sampler is parked,
 * so unattributed evidence gathered now is systematically pessimistic about the
 * world C3 creates. A signal must measure the thing it governs
 * (`docs/review-prevention-log.md` #28).
 *
 * `rate_limited` was already observable, but only as a state TRANSITION
 * (`QuotaReaderLogEvent`, emitted on entering/leaving the backoff). A reader
 * stuck limited for eight hours emits nothing at all, so there is no line
 * co-located with a probe's timestamp to join against. This is the per-read
 * form of the same fact.
 *
 * `no_credential` covers a NON-DARWIN HOST as well as a genuinely absent token:
 * `readKeychainToken` returns `null` for both, deliberately (it never touches a
 * credential store off macOS), so the reader cannot tell them apart and this
 * enum does not pretend to. Distinguishing them would mean threading a platform
 * signal out of the token reader for a case the one consumer — a macOS build
 * loop — cannot hit. A Linux deployment reads `no_credential` forever, which is
 * true as far as it goes: there is no credential to be had there.
 */
export const ACCOUNT_QUOTA_UNAVAILABLE_REASONS = [
  /** The surface is switched off (`CLAUDE_QUOTA_ENABLED=0`); nothing was polled. */
  'disabled',
  /** No OAuth token — an absent credential, or a host with no Keychain at all. */
  'no_credential',
  /** The provider answered 429. Contended account, not a broken reader. */
  'rate_limited',
  /** The provider call failed for any other reason (transport, non-429 status). */
  'provider_error',
  /** The provider answered, but the payload did not satisfy the reading's shape. */
  'unrecognized_payload',
  /** The reader itself threw. Should not happen; reported rather than hidden. */
  'reader_error',
] as const;

export const AccountQuotaUnavailableReasonSchema = z.enum(ACCOUNT_QUOTA_UNAVAILABLE_REASONS);

export type AccountQuotaUnavailableReason = z.infer<typeof AccountQuotaUnavailableReasonSchema>;

/**
 * The `GET /api/quota` response body.
 *
 * `account.claude` is `null` whenever the reading is UNREADABLE. `generated_at`
 * is epoch SECONDS and always present: it stamps the RESPONSE, not the reading,
 * so it can never be mistaken for freshness evidence about a `null`.
 *
 * `unavailable.claude` says which failure it was, to the resolution the reader
 * can actually distinguish (`ACCOUNT_QUOTA_UNAVAILABLE_REASONS` — note it does
 * NOT separate a non-darwin host from a missing token), and is present IF AND
 * ONLY IF `account.claude` is `null` (#825). It is a SIBLING of `account` rather
 * than a union member inside it, so that the consumer's hard-coded parse
 * (`d['account']['claude']['seven_day']['utilization']`) is untouched — an
 * advisory field must not be reachable by the path that yields a number, or a
 * parser bug could promote "why there is no reading" into a reading.
 *
 * The iff is ENFORCED here, not merely asserted in prose. `.optional()` alone
 * admits both incoherent shapes: a reading carrying an explanation for its own
 * absence, and a `null` with the explanation dropped — the latter being a silent
 * reversion to the unattributed UNREADABLE this field exists to remove. Neither
 * is reachable from the shipped reader, but the reader is an injectable seam
 * (`claudeAccountQuotaReader`), and a contract a schema does not check is one a
 * future implementation is free to break.
 */
/**
 * The fields both quota bodies share, factored out so the guard's body and the
 * display body cannot drift.
 *
 * Extraction ONLY: `AccountQuotaStateSchema`'s exported type and runtime
 * behaviour are identical to what they were before #987 — same keys, same
 * `.strict()`, same refinement. That matters because this body is a documented
 * COMPAT CONTRACT with `loop/drive.sh` (see the file header), so the refactor
 * that lets a second body reuse the shape must not be a place the first one
 * quietly acquires a field.
 */
const accountQuotaStateShape = {
  generated_at: z.number().int(),
  account: z
    .object({
      claude: ClaudeAccountQuotaSchema.nullable(),
    })
    .strict(),
  unavailable: z
    .object({
      claude: AccountQuotaUnavailableReasonSchema,
    })
    .strict()
    .optional(),
} as const;

/** The #825 iff, shared by both bodies for the same reason the shape is. */
function refineUnavailableIff(
  state: { account: { claude: unknown }; unavailable?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (state.account.claude === null && state.unavailable === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unavailable'],
      message: 'an UNREADABLE reading must say why (#825)',
    });
  }
  if (state.account.claude !== null && state.unavailable !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unavailable'],
      message: 'a reading cannot also carry a reason for its absence (#825)',
    });
  }
}

export const AccountQuotaStateSchema = z
  .object(accountQuotaStateShape)
  .strict()
  .superRefine(refineUnavailableIff);

export type AccountQuotaState = z.infer<typeof AccountQuotaStateSchema>;

/**
 * The most recent reading that was actually OBTAINED, and when (#987).
 *
 * `read_at` is epoch SECONDS, matching every other timestamp on this surface.
 * The AGE is deliberately NOT carried as a second field: `generated_at` stamps
 * the same response from the same clock, so `generated_at - read_at` is an
 * age computed entirely server-side with no client-clock skew in it — while a
 * transmitted `age_seconds` would be a second encoding of one fact, free to
 * disagree with the pair it was derived from (the reasoning `claude-quota.ts`
 * applies to its own `SampleOutcome`).
 */
export const LastKnownAccountQuotaSchema = z
  .object({
    claude: ClaudeAccountQuotaSchema,
    /** When this reading was taken, epoch SECONDS. */
    read_at: z.number().int(),
  })
  .strict();

export type LastKnownAccountQuota = z.infer<typeof LastKnownAccountQuotaSchema>;

/**
 * The `GET /api/quota/display` response body — the HUMAN surface (#987).
 *
 * A superset of `AccountQuotaState`: the same live reading, plus the last
 * reading that was obtained, when there is no live one. It exists because the
 * two consumers of an account-quota reading need OPPOSITE staleness contracts:
 *
 * | consumer | needs |
 * |---|---|
 * | `loop/drive.sh`'s spend guard | never a stale value — a miss must read UNREADABLE so the guard REFUSES |
 * | the operator's Monitor panel  | "what is my quota?" — a 12-minute-old number is useful; "UNREADABLE" is not |
 *
 * The reader's no-grace / no-last-good rule is RIGHT and is untouched: a
 * stale-but-low reading that PERMITS a fire is the one forbidden polarity, and
 * the last-known value here is held OUTSIDE the reader, by a recorder that only
 * this body can reach (`server/src/quota/last-known.ts`).
 *
 * `last_known` is present ONLY when `account.claude` is `null`, enforced below.
 * Emitting it beside a live reading would put the same number on the wire twice,
 * one copy carrying an age — an incoherent pair of the kind this file makes
 * unrepresentable rather than merely discouraged, and one careless consumer away
 * from preferring the stale copy.
 */
export const AccountQuotaDisplayStateSchema = z
  .object({
    ...accountQuotaStateShape,
    last_known: LastKnownAccountQuotaSchema.optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    refineUnavailableIff(state, ctx);
    if (state.account.claude !== null && state.last_known !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['last_known'],
        message: 'a live reading must not also carry a last-known copy of itself (#987)',
      });
    }
  });

export type AccountQuotaDisplayState = z.infer<typeof AccountQuotaDisplayStateSchema>;
