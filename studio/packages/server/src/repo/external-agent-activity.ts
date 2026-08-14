import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  RUN_SINCE_MS,
  type ExternalAgentActivity,
  type ExternalAgentReport,
  type ExternalAgentTokens,
  type ExternalReporterActivity,
} from '@autonomy-studio/shared';
import { externalAgentActivity } from '../db/schema.js';
import { drainByBatches } from './retention.js';
import { newId } from './ids.js';
import type { Db, DbTx } from './types.js';

/**
 * #988 — the store behind `POST /api/monitor/external-activity`.
 *
 * See `external-agent-activity.ts` in `shared` for WHY reported activity is a
 * table of its own and why none of it is summed into studio's own cost figures.
 * This module owns the three things a schema cannot state: what happens when the
 * same invocation is reported twice, which invocations a window contains, and
 * how the table is kept from growing without bound.
 */

/**
 * Default retention for reported invocations, matching the WIDEST queryable
 * window (`30d`) — nothing can ask for a window older than that, so a row past
 * it is unreadable by construction.
 *
 * Configurable and disable-able exactly like the two ledgers that came before it
 * (`WAKEUP_RETENTION_DAYS`, `WEBHOOK_RETENTION_DAYS`): see
 * `EXTERNAL_ACTIVITY_RETENTION_DAYS` in `index.ts`, which IMPORTS this rather
 * than restating the number — two spellings of one default is how a constant
 * drifts from itself.
 */
export const DEFAULT_EXTERNAL_ACTIVITY_RETENTION_MS = RUN_SINCE_MS['30d'];

/**
 * The most (source, agent, model) groups a snapshot will carry.
 *
 * `source`, `agent` and `model` are FREE TEXT from a reporter studio does not
 * control, so the group count is bounded by what callers invent, not by anything
 * studio owns — and this response is polled every few seconds. Every other
 * dimension of this endpoint is explicitly bounded (the series clamps its bucket
 * count; the model table groups by a closed connection-kind vocabulary), so an
 * unbounded one here would be the single way to make the panel arbitrarily
 * expensive by writing to it.
 *
 * The TOTALS are computed ungrouped, so truncating the table never changes the
 * headline figures — the reading stays complete even when the breakdown is not,
 * and `truncated` says which case the UI is in.
 */
export const MAX_REPORTER_GROUPS = 50;

export interface ExternalActivityWindow {
  /** Window lower bound, epoch MILLISECONDS. */
  sinceMs: number;
  /** Window upper bound — the response's `generatedAt`, as `aggregateAiActivity` uses. */
  nowMs: number;
  /** Owner scope. Authentication ≠ authorization — the route always passes it. */
  ownerId?: string;
}

/**
 * A report naming an invocation studio has already seen UPDATES it.
 *
 * `(ownerId, source, externalId)` is the identity, so a reporter is expected to
 * send an invocation when it starts and again when it ends. The merge is
 * deliberately INFORMATION-PRESERVING rather than last-write-wins, which is the
 * same posture `connection-quota.ts`'s max-upsert takes for the same reason —
 * an at-least-once reporter WILL eventually deliver an old body late:
 *
 *   - a settled invocation never returns to unsettled. A duplicate START report
 *     arriving after the END report (a retry, an out-of-order delivery) would
 *     otherwise blank `endedAt` and put a finished fire back on the panel as
 *     still running.
 *   - a measured token figure is never overwritten by `null`. `null` means
 *     "nobody counted", so accepting it over a real number would destroy a
 *     measurement and then print the loss as unmeasured work.
 *
 * A genuinely NEW invocation must therefore carry a new `externalId`; reusing
 * one is by definition a re-report of the same invocation.
 */
function mergeReport(
  existing: typeof externalAgentActivity.$inferSelect,
  report: ExternalAgentReport,
): Partial<typeof externalAgentActivity.$inferInsert> {
  const keepMeasured = (incoming: number | null, held: number | null) => incoming ?? held;
  return {
    agent: report.agent,
    model: report.model ?? existing.model,
    /* EARLIEST start wins. `startedAt` was the one field a re-report could
     * rewrite unconditionally, which let a late duplicate move an invocation's
     * beginning — and with it `lastAt` and which windows the row belongs to.
     * Under any delivery order the earliest reported start is the honest one. */
    startedAtMs: Math.min(existing.startedAtMs, report.startedAt),
    /* FIRST end wins, not "any non-null end". `outcome: 'unknown'` is allowed to
     * carry an end stamp (a reporter may know an invocation stopped without
     * knowing how), so `report.endedAt ?? existing` let a late, EARLIER end
     * overwrite a settled one — moving the row out of windows that legitimately
     * contained it while its `completed` verdict stayed put. */
    endedAtMs: existing.endedAtMs ?? report.endedAt,
    /* An `unknown` outcome never overwrites a settled one, for the same reason
     * `endedAt` does not: it is the ABSENCE of a verdict, not a verdict. */
    outcome: report.outcome === 'unknown' ? existing.outcome : report.outcome,
    inputTokens: keepMeasured(report.inputTokens, existing.inputTokens),
    outputTokens: keepMeasured(report.outputTokens, existing.outputTokens),
    cacheReadTokens: keepMeasured(report.cacheReadTokens, existing.cacheReadTokens),
    cacheCreationTokens: keepMeasured(report.cacheCreationTokens, existing.cacheCreationTokens),
  };
}

export interface RecordedExternalActivity {
  id: string;
  /** `false` when this report updated an invocation already known. */
  created: boolean;
}

/**
 * Record (or re-record) one external invocation.
 *
 * SELECT-then-write inside one transaction rather than `onConflictDoUpdate`,
 * because the merge above is per-field and conditional — it cannot be expressed
 * as a `SET` list — and because `created` is genuinely wanted by the reporter
 * and is not recoverable from an upsert (SQLite's `changes()` is 1 either way).
 * better-sqlite3 is synchronous and single-writer, so the read and the write
 * cannot interleave with another writer.
 */
export function recordExternalAgentActivity(
  db: Db,
  input: { ownerId: string; report: ExternalAgentReport; nowMs: number },
): RecordedExternalActivity {
  const { ownerId, report, nowMs } = input;
  return db.transaction((tx): RecordedExternalActivity => {
    const existing = tx
      .select()
      .from(externalAgentActivity)
      .where(
        and(
          eq(externalAgentActivity.ownerId, ownerId),
          eq(externalAgentActivity.source, report.source),
          eq(externalAgentActivity.externalId, report.externalId),
        ),
      )
      .get();

    if (existing === undefined) {
      const id = newId('extact');
      tx.insert(externalAgentActivity)
        .values({
          id,
          ownerId,
          source: report.source,
          externalId: report.externalId,
          agent: report.agent,
          model: report.model,
          startedAtMs: report.startedAt,
          endedAtMs: report.endedAt,
          outcome: report.outcome,
          inputTokens: report.inputTokens,
          outputTokens: report.outputTokens,
          cacheReadTokens: report.cacheReadTokens,
          cacheCreationTokens: report.cacheCreationTokens,
          reportedAtMs: nowMs,
        })
        .run();
      return { id, created: true };
    }

    tx.update(externalAgentActivity)
      .set({ ...mergeReport(existing, report), reportedAtMs: nowMs })
      .where(eq(externalAgentActivity.id, existing.id))
      .run();
    return { id: existing.id, created: false };
  });
}

/**
 * Delete up to `limit` invocations reported before `before`. Returns the count.
 *
 * Pruned on `reported_at_ms` — STUDIO's clock — while the window reads
 * `started_at_ms`, the REPORTER's. That asymmetry is deliberate: retention must
 * not be evadable by a reporter whose clock is wrong or hostile, and a row
 * stamped years in the future would otherwise never expire.
 *
 * Nothing DISPLAYABLE is lost by it: `reported_at_ms` is when studio learned of
 * the row, and a window that could still contain it must be younger than that.
 * The one thing this does NOT bound is a reporter that keeps re-reporting the
 * same invocation forever — every write refreshes `reported_at_ms`, so the row
 * stays. That is a live reporter describing a live invocation, which is what the
 * table is for; the route separately refuses a start stamp far in the future, so
 * such a row cannot also be invisible.
 */
export function pruneExternalAgentActivity(
  db: Db,
  opts: { before: number; limit: number },
): number {
  /* ONE statement, as the two sibling ledgers do it: the doomed set is a
   * SUBQUERY, not a fetched list re-deleted row by row. Deleting individually
   * would take the single writer N times per batch and undercut the very
   * stall-avoidance argument that makes this a batched sweep at all.
   *
   * `id` breaks `reportedAtMs` ties so batch boundaries are stable across
   * sweeps — without it two rows sharing a millisecond could be re-selected as
   * the same batch's edge on the next pass. */
  const doomed = db
    .select({ id: externalAgentActivity.id })
    .from(externalAgentActivity)
    .where(lt(externalAgentActivity.reportedAtMs, opts.before))
    .orderBy(asc(externalAgentActivity.reportedAtMs), asc(externalAgentActivity.id))
    .limit(opts.limit);
  return db
    .delete(externalAgentActivity)
    .where(inArray(externalAgentActivity.id, doomed))
    .returning({ id: externalAgentActivity.id })
    .all().length;
}

/** Drain expired reports to a fixpoint in bounded batches (#464's discipline). */
export function drainExternalAgentActivity(
  db: Db,
  opts: { before: number; batch?: number; maxBatches?: number },
): number {
  return drainByBatches((limit) => pruneExternalAgentActivity(db, { before: opts.before, limit }), {
    batch: opts.batch,
    maxBatches: opts.maxBatches,
  });
}

const EMPTY_TOKENS: ExternalAgentTokens = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheCreationTokens: null,
  measuredInvocations: 0,
};

/**
 * Which invocations a window contains — by OVERLAP, not by start stamp.
 *
 * The metered side filters `run_events.ts >= sinceMs` because an event is a
 * point in time. An invocation is an INTERVAL, and filtering intervals by their
 * start would reproduce the exact bug this ticket is about: an autonomy-loop
 * fire runs for up to an hour and a half, so one that began 70 minutes ago and
 * is still running would be absent from the DEFAULT `1h` window — the panel
 * would again report nothing while the agent is visibly working.
 *
 * So a row is in the window if it was still running at some point inside it: it
 * has not ended, or it ended at/after the lower bound. `startedAtMs <= nowMs`
 * excludes a future-stamped row from a window it cannot honestly belong to —
 * which also means no figure derived here (`lastAt` included) can be in the
 * future, so the UI never renders a "last used" that has not happened yet.
 *
 * TWO COSTS, stated because they are real. An invocation that started before the
 * window contributes ALL its tokens to it, though some of that work happened
 * earlier; splitting a reported total across the window boundary would require
 * inventing a distribution the reporter never sent, which is the
 * manufactured-fact shape this codebase refuses. And a reporter that never sends
 * an end report leaves a row reading as in-flight until retention removes it —
 * a broken reporter, bounded rather than permanent.
 */
function windowConditions(filter: ExternalActivityWindow) {
  const conditions = [
    lte(externalAgentActivity.startedAtMs, filter.nowMs),
    or(
      isNull(externalAgentActivity.endedAtMs),
      gte(externalAgentActivity.endedAtMs, filter.sinceMs),
    ),
  ];
  if (filter.ownerId !== undefined) {
    conditions.push(eq(externalAgentActivity.ownerId, filter.ownerId));
  }
  return conditions;
}

/** The count + token columns, written once so the grouped read and the ungrouped
 * total cannot drift into measuring different things. */
function activityColumns() {
  const t = externalAgentActivity;
  /* `sum()` of no rows is NULL, and so is `sum()` over rows that all held NULL —
   * which is exactly the "nobody counted" signal, so it is NOT coalesced. */
  return {
    invocations: sql<number>`count(*)`,
    completed: sql<number>`coalesce(sum(case when ${t.outcome} = 'completed' then 1 else 0 end), 0)`,
    notCompleted: sql<number>`coalesce(sum(case when ${t.outcome} = 'notCompleted' then 1 else 0 end), 0)`,
    inFlight: sql<number>`coalesce(sum(case when ${t.endedAtMs} is null then 1 else 0 end), 0)`,
    // `max()` of no rows is NULL, which IS the "there were none" signal — never
    // coalesced to 0, because epoch zero is a real instant that would render as
    // "last used in 1970".
    lastAt: sql<number | null>`max(${t.startedAtMs})`,
    inputTokens: sql<number | null>`sum(${t.inputTokens})`,
    outputTokens: sql<number | null>`sum(${t.outputTokens})`,
    cacheReadTokens: sql<number | null>`sum(${t.cacheReadTokens})`,
    cacheCreationTokens: sql<number | null>`sum(${t.cacheCreationTokens})`,
    measuredInvocations: sql<number>`coalesce(sum(case when ${t.inputTokens} is not null
      or ${t.outputTokens} is not null
      or ${t.cacheReadTokens} is not null
      or ${t.cacheCreationTokens} is not null then 1 else 0 end), 0)`,
  };
}

type ActivityRow = {
  invocations: number;
  completed: number;
  notCompleted: number;
  inFlight: number;
  lastAt: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  measuredInvocations: number;
};

function tokensOf(row: ActivityRow): ExternalAgentTokens {
  return {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    measuredInvocations: row.measuredInvocations,
  };
}

/**
 * The window's reported activity: totals ungrouped, plus a bounded breakdown by
 * (source, agent, model).
 *
 * That grain mirrors the metered table's (provider, model) — the finest split
 * the stored row actually carries.
 *
 * TAKES A TRANSACTION. `aggregateAiActivity` reads its panels inside ONE SQLite
 * snapshot precisely so they cannot describe different instants; a helper that
 * opened its own read would silently reintroduce that skew.
 *
 * Unlike the metered side, the totals are NOT summed from the groups: the groups
 * are truncated at `MAX_REPORTER_GROUPS`, so summing them would make the
 * headline quietly under-report as soon as a 51st reporter appeared. Two reads
 * of the same snapshot with the same predicate cannot disagree, and `truncated`
 * tells the UI when the table is a prefix rather than the whole story.
 */
export function aggregateExternalAgentActivity(
  db: Db | DbTx,
  filter: ExternalActivityWindow,
): ExternalAgentActivity {
  const where = and(...windowConditions(filter));

  const groupRows = db
    .select({
      source: externalAgentActivity.source,
      agent: externalAgentActivity.agent,
      model: externalAgentActivity.model,
      ...activityColumns(),
    })
    .from(externalAgentActivity)
    .where(where)
    .groupBy(externalAgentActivity.source, externalAgentActivity.agent, externalAgentActivity.model)
    /* A TOTAL order, so the table does not reshuffle between two polls of
     * identical data: busiest first, then the (source, agent, model) tail, which
     * is unique per group and is what makes the order total. Ordered in SQL
     * rather than in JS because the LIMIT below must take the BUSIEST groups —
     * sorting a page after truncating it would keep an arbitrary subset. */
    .orderBy(
      desc(sql`count(*)`),
      asc(externalAgentActivity.source),
      asc(externalAgentActivity.agent),
      asc(externalAgentActivity.model),
    )
    // One more than the cap, purely to detect truncation without a second count.
    .limit(MAX_REPORTER_GROUPS + 1)
    .all();

  const truncated = groupRows.length > MAX_REPORTER_GROUPS;
  const reporters: ExternalReporterActivity[] = groupRows
    .slice(0, MAX_REPORTER_GROUPS)
    .map((row) => ({
      source: row.source,
      agent: row.agent,
      model: row.model,
      invocations: row.invocations,
      completed: row.completed,
      notCompleted: row.notCompleted,
      // The partition is total by construction: whatever is neither `completed`
      // nor `notCompleted` is `unknown`, so no invocation can drop out of the
      // reading by having an outcome this query forgot to count.
      unknown: row.invocations - row.completed - row.notCompleted,
      inFlight: row.inFlight,
      lastAt: row.lastAt,
      tokens: tokensOf(row),
    }));

  const totals = db.select(activityColumns()).from(externalAgentActivity).where(where).get();

  // `.get()` on an ungrouped aggregate always returns a row (zeros over an empty
  // set), but the type is optional — an empty window is the same answer.
  const empty: ActivityRow = {
    invocations: 0,
    completed: 0,
    notCompleted: 0,
    inFlight: 0,
    lastAt: null,
    ...EMPTY_TOKENS,
  };
  const total = totals ?? empty;

  return {
    invocations: total.invocations,
    completed: total.completed,
    notCompleted: total.notCompleted,
    unknown: total.invocations - total.completed - total.notCompleted,
    inFlight: total.inFlight,
    lastAt: total.lastAt,
    tokens: tokensOf(total),
    truncated,
    reporters,
  };
}
