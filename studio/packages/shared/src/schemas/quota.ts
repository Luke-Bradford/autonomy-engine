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
    /**
     * When this window resets, epoch SECONDS — or `null` when the provider did
     * not say (#1023).
     *
     * `.nullable()` rather than `.optional()`, which is a deliberate departure
     * from `overage` directly below and from `five_hour` in the reading. The
     * line between them: a key is OPTIONAL here when the thing it describes may
     * not exist at all (there is no overage; there is no 5-hour window), and
     * NULLABLE when the thing exists and its value is unknown. Every window has
     * a reset; sometimes nobody reported when. That is a known-unknown, and it
     * is the same encoding the renderer already uses for one (`formatWhen(ms:
     * number | null)` → an em-dash).
     *
     * It is also what the provider literally sends: a window with no active
     * period arrives as `{utilization: 0.0, resets_at: null}`, observed on the
     * live endpoint 2026-08-12.
     *
     * `null` is NOT overloaded with the meaning it carries one level up.
     * `account.claude: null` says "a reading was attempted and could not be
     * had"; this says "the reading is here, and it carries no reset instant".
     * The difference is that the utilization beside it is a real measurement
     * either way — which is exactly what #1023 was about.
     */
    resets_at: z.number().int().nullable(),
    /** Present only when the account is drawing on overage credit. */
    overage: z.literal(true).optional(),
  })
  .strict();

export type AccountQuotaWindow = z.infer<typeof AccountQuotaWindowSchema>;

/**
 * A complete account-quota reading: the 7-day window, and the 5-hour one when
 * the provider reported it.
 *
 * ## The all-or-nothing rule this used to have, and why it went (#1023)
 *
 * Both windows were required, inherited from the prototype's `_build` — "a
 * partial payload is a confusing live/stale mix, and half a reading is not
 * evidence". **The inherited rule outlived its reason.** The prototype's reason
 * was the dashboard PANEL, which merged a live sample with a 900s-graced stale
 * one and could therefore render half of each; this reader has neither a grace
 * window nor a last-good value inside it (see `claude-quota.ts`), so a partial
 * reading here is not a mix of anything. It is one sample, of which the provider
 * reported one window.
 *
 * Measured cost of keeping it: over 2026-08-09..12 the spend guard's own log
 * recorded 31 `unrecognized_payload` readings where `loop/claude_usage.py` —
 * same endpoint, same second, same credential — read a real 7-day figure. Every
 * one of those was a good 7-day window discarded over a 5-hour one that nothing
 * consumes. `CodexAccountQuotaSchema` below had already reached this conclusion
 * for the other provider, in as many words.
 *
 * `seven_day` stays REQUIRED, so this is not codex's symmetric "at least one
 * window" rule. It is asymmetric on purpose: `loop/drive.sh` reads
 * `seven_day.utilization` and only that, so a payload without it carries no fact
 * this surface exists to report — and keeping it required is what preserves the
 * #825 iff, since a reading that cannot be built stays `null` and therefore
 * still carries a reason for its absence.
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
    /** Absent when the provider did not report a 5-hour window (#1023). */
    five_hour: AccountQuotaWindowSchema.optional(),
    seven_day: AccountQuotaWindowSchema,
  })
  .strict();

export type ClaudeAccountQuota = z.infer<typeof ClaudeAccountQuotaSchema>;

/**
 * The providers this surface can report an account quota for (#990).
 *
 * A CLOSED set, not an open string: every provider needs a reader that knows
 * where its reading comes from, and the display copy for an unobtainable one is
 * exhaustive per provider on the web side. A new member is therefore a
 * typecheck failure at each place that must say something about it, which is
 * the point — an open string would let a provider reach the wire with no reader
 * and no copy, and render as a blank row rather than as anything honest.
 */
export const ACCOUNT_QUOTA_PROVIDERS = ['claude', 'codex'] as const;

export const AccountQuotaProviderSchema = z.enum(ACCOUNT_QUOTA_PROVIDERS);

export type AccountQuotaProvider = z.infer<typeof AccountQuotaProviderSchema>;

/**
 * A codex account-quota reading (#990).
 *
 * Deliberately NOT `ClaudeAccountQuotaSchema`, for two measured reasons.
 *
 * **Windows are individually optional.** Measured against codex-cli's own
 * session records on the operator's host (2026-08-07): a `plus` plan reports
 * `primary` with `window_minutes: 10080` (the 7-day window) and `secondary:
 * null` — ONE window, not two. Claude's pair was mandatory at the time and
 * could not represent that; forcing it would have turned a perfectly good 7-day
 * reading into UNREADABLE. The `superRefine` below keeps the half that actually
 * matters: ZERO windows is not an empty reading, it is no reading at all. That
 * is the same fail-open shape `ClaudeAccountQuotaSchema` guards — an absent fact
 * must never be manufactured as a benign one — applied at the granularity codex
 * actually reports at.
 *
 * **#1023 proved that argument general.** The claude endpoint turned out to do
 * exactly what codex does — it stops reporting `five_hour` when there is no
 * active session — so `ClaudeAccountQuotaSchema` adopted the optional window
 * too, and the sentence above is now history rather than a contrast. What still
 * separates the two schemas is the RULE about which windows may be missing:
 * codex accepts any one of them, because either may be the only one its plan
 * reports; claude requires `seven_day`, because that is the field its consumer
 * parses. This schema also keeps `read_at`, below, which claude has no use for.
 *
 * **It carries its own `read_at`.** Claude's reading is polled live and is at
 * most one TTL old, so it has no freshness to interpret. Codex's is SCRAPED
 * from the last session the CLI happened to write, so it is as old as the
 * operator's last codex run — minutes or days. Rendering that in the same table
 * as a live figure with no age is exactly the fail-open presentation #987 built
 * the aged-reading machinery to prevent. The age is free (every session line
 * carries its own ISO timestamp), so there is no case for omitting it.
 *
 * `read_at` is epoch SECONDS, matching every other timestamp on this surface.
 */
export const CodexAccountQuotaSchema = z
  .object({
    five_hour: AccountQuotaWindowSchema.optional(),
    seven_day: AccountQuotaWindowSchema.optional(),
    /** When the snapshot this reading came from was written, epoch SECONDS. */
    read_at: z.number().int(),
  })
  .strict()
  .superRefine((quota, ctx) => {
    if (quota.five_hour === undefined && quota.seven_day === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a reading with no windows is not a reading (#990)',
      });
    }
  });

export type CodexAccountQuota = z.infer<typeof CodexAccountQuotaSchema>;

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
  /**
   * The source EXISTS but holds no usable reading yet (#990).
   *
   * Distinct from `no_credential`, which says there is nothing to read FROM,
   * and from `unrecognized_payload`, which says something was read and did not
   * parse. Codex's reading is scraped from the session records its CLI writes,
   * so a host with codex installed but not recently run has a real source, a
   * valid credential and simply nothing current in it. Collapsing that into
   * either neighbour would tell the operator to fix the wrong thing.
   */
  'no_reading',
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
/**
 * The #825 iff, per PROVIDER (#990).
 *
 * Three states, not two, and the third is the one #990 exists to make
 * representable: a provider key that is ABSENT means "not on this host", which
 * is a different fact from `null` ("here, but unreadable") and must not carry a
 * reason — a reason for the absence of something that was never present would
 * invite the panel to render a failure where there is none.
 *
 * Keyed per PROVIDER rather than on the `unavailable` container. The container
 * test the guard body uses (`unavailable === undefined`) is correct only while
 * there is one provider: with two, `{account:{claude:null}, unavailable:
 * {codex:'…'}}` satisfies it while claude's `null` carries no reason at all —
 * the unattributed UNREADABLE #825 was written to remove, re-entering through
 * the door a second provider opens.
 */
function refineProviderUnavailableIff(
  provider: AccountQuotaProvider,
  value: unknown,
  reason: AccountQuotaUnavailableReason | undefined,
  ctx: z.RefinementCtx,
): void {
  if (value === undefined) {
    if (reason !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailable', provider],
        message: `a provider absent from this host must not carry a reason (#990)`,
      });
    }
    return;
  }
  if (value === null) {
    if (reason === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailable', provider],
        message: `an UNREADABLE ${provider} reading must say why (#825)`,
      });
    }
    return;
  }
  if (reason !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['unavailable', provider],
      message: `a ${provider} reading cannot also carry a reason for its absence (#825)`,
    });
  }
}

export const AccountQuotaDisplayStateSchema = z
  .object({
    generated_at: accountQuotaStateShape.generated_at,
    /**
     * `claude` is always present — the surface reports on it whether or not a
     * credential exists, so the key is REQUIRED and `null` when unreadable.
     * `codex` is optional because it is not on every host, and its absence is
     * expressed by the key being missing rather than by a `null` that would
     * claim a failed read (#990).
     */
    account: z
      .object({
        claude: ClaudeAccountQuotaSchema.nullable(),
        codex: CodexAccountQuotaSchema.nullable().optional(),
      })
      .strict(),
    unavailable: z
      .object({
        claude: AccountQuotaUnavailableReasonSchema.optional(),
        codex: AccountQuotaUnavailableReasonSchema.optional(),
      })
      .strict()
      .optional(),
    last_known: LastKnownAccountQuotaSchema.optional(),
  })
  .strict()
  .superRefine((state, ctx) => {
    refineProviderUnavailableIff('claude', state.account.claude, state.unavailable?.claude, ctx);
    refineProviderUnavailableIff('codex', state.account.codex, state.unavailable?.codex, ctx);
    // An `unavailable` with no keys says nothing while looking like it does.
    // Every per-provider branch above is satisfied by it, so it needs its own
    // refusal or the omit-when-empty rule is prose rather than contract.
    if (state.unavailable !== undefined && Object.keys(state.unavailable).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailable'],
        message: 'an empty `unavailable` must be omitted, not sent (#825)',
      });
    }
    if (state.account.claude !== null && state.last_known !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['last_known'],
        message: 'a live reading must not also carry a last-known copy of itself (#987)',
      });
    }
  });

export type AccountQuotaDisplayState = z.infer<typeof AccountQuotaDisplayStateSchema>;
