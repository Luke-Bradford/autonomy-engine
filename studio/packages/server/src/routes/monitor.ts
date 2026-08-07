import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  RUN_SINCE_MS,
  RunSinceSchema,
  type AiActivitySnapshot,
  type RunSince,
} from '@autonomy-studio/shared';
import { aggregateAiActivity } from '../repo/ai-activity.js';

/**
 * The window defaults to the last hour: this is the "what are my connected AIs
 * doing" surface, so the default should be recent enough that what it shows is
 * still happening. Wider windows are the operator's explicit choice.
 */
const DEFAULT_SINCE: RunSince = '1h';

const AiActivityQuerystringSchema = z.object({
  /**
   * FIELDED, reusing `RunSinceSchema` rather than minting a second window
   * vocabulary — the run list already offers exactly these four, and two
   * monitoring surfaces disagreeing about what "24h" means is the drift a
   * shared enum exists to prevent. Being a closed enum, junk is a 400 rather
   * than a window that silently matches everything or nothing, and there is no
   * numeric param for the empty string to coerce to `0`.
   */
  since: RunSinceSchema.optional(),
});

/**
 * #917 — the operator-facing monitoring surface for connected AI/LLM use.
 *
 * SECURITY — owner-scoped, unlike its neighbour `GET /api/quota`. The two are
 * deliberately different and it is worth saying why, since they render side by
 * side: quota is an ACCOUNT-level fact about the machine's own credential and
 * is documented as unauthenticated by design, whereas this reads the caller's
 * runs and their event log. `ownerId` comes from `request.principal` and is
 * pushed all the way into the SQL (both the event join and the run count), so a
 * second owner's spend is not merely hidden from the response — it is never
 * summed into the totals in the first place.
 */
export const monitorRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  fastify.get('/api/monitor/ai-activity', async (request): Promise<AiActivitySnapshot> => {
    const { since } = AiActivityQuerystringSchema.parse(request.query);
    const window = since ?? DEFAULT_SINCE;
    /*
     * The lower bound is resolved HERE, not by the caller, for the reason the
     * run list's `since` already documents: it is compared against a column this
     * process stamps, so resolving it server-side measures the window against
     * the same clock that wrote it. A browser resolving it would widen or narrow
     * the window by its own skew, silently.
     */
    const generatedAt = Date.now();
    const windowStart = generatedAt - RUN_SINCE_MS[window];
    const aggregate = aggregateAiActivity(db, {
      sinceMs: windowStart,
      ownerId: request.principal.ownerId,
    });
    return { generatedAt, since: window, windowStart, ...aggregate };
  });
};
