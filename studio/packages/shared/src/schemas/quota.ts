import { z } from 'zod';

/**
 * #440 (C1) — the machine-readable ACCOUNT QUOTA surface.
 *
 * This is the studio-native replacement for the prototype engine dashboard's
 * `GET /api/state`, built for ONE specific consumer: the build loop's own spend
 * guard (`loop/drive.sh`'s `quota_pct()`), which refuses to fire when the
 * account's 7-day utilization is at or above `QUOTA_STOP_PCT`. When the old
 * bash/python engine is parked (#410) that endpoint disappears, and with it the
 * only thing stopping an unattended loop from spending the operator out of
 * their own weekly window. So this surface is not a nicety — it is the guard.
 *
 * ## Why snake_case in a camelCase codebase
 *
 * `loop/drive.sh` parses a HARD-CODED path out of the response:
 *
 * ```python
 * d['account']['claude']['seven_day']['utilization']
 * ```
 *
 * Keeping that exact shape makes the cutover a `DASH_URL` change rather than a
 * rewrite of a guard whose failure mode is "spend the operator's quota". This
 * file is therefore a deliberate, documented COMPAT CONTRACT and the one
 * snake_case surface in the API — not a style lapse, and not a precedent for
 * anything else. Changing a key here is a BREAKING change to the spend guard;
 * `loop/test_quota_guard.sh` is what pins the consumer side.
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
export const QuotaWindowSchema = z
  .object({
    /** Fraction of the window consumed, 0-1. NEVER a percent. */
    utilization: z.number().min(0),
    /** When this window resets, epoch SECONDS. */
    resets_at: z.number().int(),
    /** Present only when the account is drawing on overage credit. */
    overage: z.literal(true).optional(),
  })
  .strict();

export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/**
 * A complete account-quota reading. ALL-OR-NOTHING: both windows must be
 * present and valid or the whole reading degrades to `null` (UNREADABLE),
 * inherited from the prototype's `_build` — a partial payload is a confusing
 * live/stale mix, and half a reading is not evidence.
 *
 * `source` is `'live'` for a fresh sample from the provider. There is
 * deliberately no `'stale'`/aged variant: see `claude-quota.ts` for why a
 * grace window is fail-open for a machine guard.
 */
export const ClaudeQuotaSchema = z
  .object({
    five_hour: QuotaWindowSchema,
    seven_day: QuotaWindowSchema,
    source: z.literal('live'),
  })
  .strict();

export type ClaudeQuota = z.infer<typeof ClaudeQuotaSchema>;

/**
 * The `GET /api/quota` response body.
 *
 * `account.claude` is `null` whenever the reading is UNREADABLE — no token, a
 * non-darwin host, a provider error, a malformed payload, or the surface
 * switched off. `generated_at` is epoch SECONDS and always present: it stamps
 * the RESPONSE, not the reading, so it can never be mistaken for freshness
 * evidence about a `null`.
 */
export const QuotaStateSchema = z
  .object({
    generated_at: z.number().int(),
    account: z
      .object({
        claude: ClaudeQuotaSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type QuotaState = z.infer<typeof QuotaStateSchema>;
