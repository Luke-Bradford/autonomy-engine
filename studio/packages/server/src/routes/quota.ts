import type { FastifyPluginAsync } from 'fastify';
import { type AccountQuotaState } from '@autonomy-studio/shared';

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
  fastify.get('/api/quota', async (request): Promise<AccountQuotaState> => {
    // Total by construction. The real reader already collapses every failure to
    // `null`, so this catch is for the unforeseeable — but the surface's whole
    // value is that it answers, and an unhandled throw here would answer with a
    // 500 whose body the consumer cannot parse.
    let claude = null;
    try {
      claude = await fastify.claudeAccountQuota.read();
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
    return {
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude },
    } satisfies AccountQuotaState;
  });
};
