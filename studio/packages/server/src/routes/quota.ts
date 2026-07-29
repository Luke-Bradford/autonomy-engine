import type { FastifyPluginAsync } from 'fastify';
import { QuotaStateSchema, type QuotaState } from '@autonomy-studio/shared';

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
 */
export const quotaRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/quota', async (): Promise<QuotaState> => {
    // Total by construction. The real reader already collapses every failure to
    // `null`, so this catch is for the unforeseeable — but the surface's whole
    // value is that it answers, and an unhandled throw here would answer with a
    // 500 whose body the consumer cannot parse.
    let claude = null;
    try {
      claude = await fastify.claudeQuota.read();
    } catch (err) {
      fastify.log.warn({ err }, 'account-quota read failed; reporting UNREADABLE');
    }
    return QuotaStateSchema.parse({
      generated_at: Math.floor(Date.now() / 1000),
      account: { claude },
    } satisfies QuotaState);
  });
};
