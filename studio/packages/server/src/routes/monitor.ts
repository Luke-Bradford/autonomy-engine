import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  AI_ACTIVITY_BUCKET_MS,
  RUN_SINCE_MS,
  ExternalAgentReportSchema,
  RunSinceSchema,
  type AiActivitySnapshot,
  type ExternalAgentReportAccepted,
  type RunSince,
} from '@autonomy-studio/shared';
import { aggregateAiActivity } from '../repo/ai-activity.js';
import { recordExternalAgentActivity } from '../repo/external-agent-activity.js';

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
 * #988 — the report body, with the two identity fields TIGHTENED beyond the
 * shared schema's length bounds.
 *
 * `source` and `agent` are grouping keys that reach the operator's screen and
 * are chosen by whoever is reporting, so they are constrained to a slug charset
 * here rather than accepted as free text: it keeps a reporter from writing a
 * label that renders as something else (control characters, right-to-left
 * overrides, a newline that breaks the row), and it makes the group cardinality
 * a function of real reporters rather than of typos. `model` and `externalId`
 * stay free-form — they are provider- and reporter-owned vocabularies studio
 * does not get to define — and are bounded by length alone.
 */
const REPORTER_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * How far ahead of studio's clock a reporter's start stamp may be.
 *
 * Some skew is legitimate — the stamp comes from another process's clock — but
 * an unbounded future stamp is a row that is INVISIBLE (the window excludes
 * anything starting after `now`) and yet occupies the table, and one that keeps
 * being re-reported never expires either. An hour is far beyond real skew and
 * far short of anything that could hide a row for long.
 */
const MAX_CLOCK_SKEW_MS = 60 * 60_000;

const ExternalActivityBodySchema = ExternalAgentReportSchema.superRefine((body, ctx) => {
  if (body.startedAt > Date.now() + MAX_CLOCK_SKEW_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['startedAt'],
      message: 'startedAt is too far in the future',
    });
  }
  for (const field of ['source', 'agent'] as const) {
    if (!REPORTER_SLUG.test(body[field])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be a slug: letters, digits, then any of . _ -`,
      });
    }
  }
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
 *
 * #988 ADDED A WRITE HERE, so the paragraph above no longer describes the whole
 * surface. `POST /api/monitor/external-activity` is UNAUTHENTICATED in the same
 * sense every other write route is — `request.principal` is a fixed
 * `LOCAL_PRINCIPAL`, and the server binds `127.0.0.1` unless told otherwise — so
 * anything that can reach the port can insert reported activity. That is the
 * accepted posture for a single-operator local app, and the reason it is
 * ACCEPTABLE here specifically is that the rows it writes are inert: reported
 * activity is displayed, attributed to its reporter, and folded into no total,
 * no price, and no gate. Nothing decides anything on the strength of it. If that
 * ever changes — if a reported figure comes to gate a fire, a spend guard or an
 * admission decision — this route needs an authenticated caller FIRST, because
 * at that point an unauthenticated writer would be steering the system.
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
      // The SAME instant the response is stamped with, so the series' trailing
      // bucket cannot end after the `generatedAt` the client is given (#967).
      nowMs: generatedAt,
      bucketMs: AI_ACTIVITY_BUCKET_MS[window],
    });
    return { generatedAt, since: window, windowStart, ...aggregate };
  });

  /**
   * #988 — an agent studio did NOT launch reports what it is doing.
   *
   * The direction matters and is the settled shape: studio never reaches out to
   * inspect processes it did not start. A reporter sends an invocation when it
   * begins (`endedAt: null`) and again when it ends; both name the same
   * `(source, externalId)`, so the pair is one row and a retry is not a second
   * fire. `201` on first sight, `200` on a re-report — the distinction is
   * returned rather than swallowed so a reporter can tell them apart.
   */
  fastify.post(
    '/api/monitor/external-activity',
    async (request, reply): Promise<ExternalAgentReportAccepted> => {
      const report = ExternalActivityBodySchema.parse(request.body);
      const recorded = recordExternalAgentActivity(db, {
        ownerId: request.principal.ownerId,
        report,
        // Studio's own clock, deliberately: it is what retention prunes by, and
        // it must not be something the caller can set.
        nowMs: Date.now(),
      });
      reply.code(recorded.created ? 201 : 200);
      return recorded;
    },
  );
};
