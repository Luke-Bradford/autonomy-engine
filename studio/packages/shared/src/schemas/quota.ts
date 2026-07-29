import { z } from 'zod';

/**
 * #440 (C1) — the machine-readable ACCOUNT QUOTA surface.
 *
 * This is the studio-native replacement for the prototype engine dashboard's
 * `GET /api/state`, built for ONE specific consumer: the build loop's own spend
 * guard (`loop/drive.sh`'s `quota_pct()`), which refuses to fire when the
 * account's 7-day utilization is at or above `QUOTA_STOP_PCT`. When the old
 * bash/python engine is parked (#410) that endpoint disappears, and this takes
 * its place. NOTE, as of C2 (2026-07-29), it is the guard's SECOND source, not
 * its primary: this reader is lazy, so every read is a direct upstream poll, and
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
 * this URL as a second source read through the SAME parser, and the tests that
 * pin it were untouched. (`DASH_URL` itself was deliberately not repointed —
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
 */
export const ClaudeAccountQuotaSchema = z
  .object({
    five_hour: AccountQuotaWindowSchema,
    seven_day: AccountQuotaWindowSchema,
  })
  .strict();

export type ClaudeAccountQuota = z.infer<typeof ClaudeAccountQuotaSchema>;

/**
 * The `GET /api/quota` response body.
 *
 * `account.claude` is `null` whenever the reading is UNREADABLE — no token, a
 * non-darwin host, a provider error, a malformed payload, or the surface
 * switched off. `generated_at` is epoch SECONDS and always present: it stamps
 * the RESPONSE, not the reading, so it can never be mistaken for freshness
 * evidence about a `null`.
 */
export const AccountQuotaStateSchema = z
  .object({
    generated_at: z.number().int(),
    account: z
      .object({
        claude: ClaudeAccountQuotaSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type AccountQuotaState = z.infer<typeof AccountQuotaStateSchema>;
