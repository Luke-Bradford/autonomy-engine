import type { FastifyPluginAsync } from 'fastify';
import { type AccountQuotaDisplayState, type AccountQuotaState } from '@autonomy-studio/shared';
import type { AccountQuotaReading } from '../quota/claude-quota.js';

/**
 * #440 (C1) — `GET /api/quota`, the machine-readable account-quota surface.
 *
 * The studio-native replacement for the prototype engine dashboard's
 * `/api/state`, whose one machine consumer is the build loop's spend guard.
 * See `shared/src/schemas/quota.ts` for the compat contract (why the body is
 * snake_case, why `utilization` is a fraction) and `quota/claude-quota.ts` for
 * why an unobtainable reading is `null` rather than a number.
 *
 * ## Security model
 *
 * NOT owner-scoped, deliberately: the account's subscription utilization is a
 * fact about the HOST PROCESS's environment, not about any owner's data. There
 * is no row to check ownership of, and scoping it to a principal would imply a
 * per-owner reading that does not exist. Authentication ≠ authorization still
 * holds — this route simply has no resource to authorize against, which is a
 * different thing from skipping a check it needed.
 *
 * The reading is derived from the operator's own OAuth credential, which the
 * reader takes from the host credential store and never returns, logs, or puts
 * on a command line. The response carries only two utilization fractions and
 * two reset timestamps. On a single-owner local install (the auth seam's
 * current model) that is the operator's own figure being shown to the operator.
 * A deployment that wants none of this sets `CLAUDE_QUOTA_ENABLED=0`, after
 * which the surface reports `null` and the credential store is never touched.
 *
 * The route never fails: an unobtainable reading is a 200 with
 * `account.claude: null`, because the consumer's parse treats any transport or
 * shape error identically to a null reading, and a 500 here would be a
 * confusing way to say something the body can say precisely.
 *
 * ## macOS ONLY — this surface is `null` everywhere else, permanently
 *
 * The reading comes from the macOS Keychain, so on Linux (including studio's own
 * Docker image) this route returns `account.claude: null` for the lifetime of
 * the process while answering 200 and looking perfectly healthy. The DIRECTION
 * is fail-safe — the consumer treats `null` as UNREADABLE, spends its bounded
 * blind-fire allowance and then stops — but "healthy-looking surface that never
 * once knows the number" is precisely the shape this endpoint exists to prevent,
 * so it is called out here rather than left to be discovered. The cutover (C2)
 * must therefore keep a second, non-Keychain source rather than treating this
 * endpoint as sufficient on its own; a Linux deployment that wants a real
 * reading needs a credential source added here first.
 */
export const quotaRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * The live reading, in the guard's wire shape. Shared by both routes so the
   * display body can never disagree with the guard body about the reading they
   * both describe — the display one only ever ADDS to this.
   */
  const liveState = async (request: {
    log: { warn: (obj: unknown, msg: string) => void };
  }): Promise<AccountQuotaState> => {
    // Total by construction. The real reader already collapses every failure to
    // `null`, so this catch is for the unforeseeable — but the surface's whole
    // value is that it answers, and an unhandled throw here would answer with a
    // 500 whose body the consumer cannot parse.
    let reading: AccountQuotaReading = { value: null, unavailable: 'reader_error' };
    try {
      reading = await fastify.claudeAccountQuota.read();
    } catch (err) {
      request.log.warn({ err }, 'account-quota read failed; reporting UNREADABLE');
    }
    // No re-validation here, deliberately. `claude` was already checked against
    // `ClaudeAccountQuotaSchema` by the reader — the ONE place untrusted
    // provider bytes are validated — and `generated_at` is a locally computed
    // integer, so `satisfies` proves the whole body at compile time. A runtime
    // parse of our OWN output would be a third definition of the same shape
    // that can only ever fail by drifting from itself, and its failure branch
    // would be untestable dead code. CLAUDE.md: validate at boundaries, trust
    // internal code. Returning the literal also makes "never throws" structural
    // rather than something a `safeParse` has to defend.
    // `unavailable` is OMITTED when there is a reading, never sent as `null`
    // (#825). The contract is "present ⟺ no reading", and a key that is always
    // there with a nullable value invites a consumer to branch on the reason
    // instead of on the reading — which is the one way an advisory field could
    // end up gating a fire.
    //
    // Keyed on `reading.value === null`, i.e. on the READING, which is what the
    // contract is stated in terms of. Keying it on the reason instead would make
    // the wire shape agree with the contract only for as long as the reader
    // honours the pairing — and `claudeAccountQuotaReader` is an injectable
    // seam, so that is an assumption about code this route does not own. The
    // `?? 'reader_error'` is unreachable through the union but is what stops an
    // ill-behaved reader turning "no reading" into an unattributed one; the
    // schema's `superRefine` pins the same iff from the other side.
    return {
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude: reading.value },
      ...(reading.value === null
        ? { unavailable: { claude: reading.unavailable ?? 'reader_error' } }
        : {}),
    } satisfies AccountQuotaState;
  };

  fastify.get('/api/quota', async (request): Promise<AccountQuotaState> => liveState(request));

  /**
   * #987 — `GET /api/quota/display`, the HUMAN surface.
   *
   * The same live reading as above, plus — when there is no live reading — the
   * last one that was actually obtained, with the timestamp it was taken at.
   * See `shared/src/schemas/quota.ts` for the contract and
   * `quota/last-known.ts` for why the retained value lives outside the reader.
   *
   * ## Why a SEPARATE ROUTE and not a field on `/api/quota`
   *
   * #825 did add an additive sibling (`unavailable`) to the guard's own body,
   * on the argument that the consumer's hard-coded parse cannot reach it — so
   * "a consumer might read it" is not on its own a reason to refuse one here.
   * The distinction is what the two fields ARE. `unavailable` is advisory
   * metadata whose misuse fails SAFE: the worst a consumer can do with it is
   * refuse to fire. `last_known` is a stale NUMBER, and its misuse fails OPEN —
   * a low reading from an hour ago permitting a fire the live figure would
   * refuse, which is the single outcome this whole surface exists to prevent.
   * A fail-open value must not be one grep away on the endpoint the spend guard
   * already polls; here it is not reachable from that endpoint at all.
   *
   * Not under `/api/monitor/*` either, despite the one caller being the Monitor
   * page: those routes are owner-scoped, and this reading is a fact about the
   * HOST PROCESS with no owner to scope it to (see the security note above).
   * Filing it there would imply a per-owner quota that does not exist.
   *
   * DISPLAY ONLY. Nothing may gate anything on this body.
   */
  fastify.get('/api/quota/display', async (request): Promise<AccountQuotaDisplayState> => {
    const state = await liveState(request);
    const retained = fastify.claudeAccountQuotaLastKnown();
    // Only when there is NO live reading — the schema refuses the other shape,
    // and the reason it does is in its docblock.
    if (state.account.claude !== null || retained === null) return state;
    return {
      ...state,
      last_known: {
        claude: retained.value,
        // Floored at the response's own instant, because `Date.now()` is WALL
        // clock: an NTP step-back or a VM resume between the record and this
        // response would otherwise put `read_at` in the future, and a negative
        // age is a thing no rendering can state honestly. The reader floors the
        // same hazard for the same reason (`claude-quota.ts`'s `at >= cachedAt`).
        read_at: Math.min(state.generated_at, Math.floor(retained.readAtMs / 1000)),
      },
    };
  });
};
