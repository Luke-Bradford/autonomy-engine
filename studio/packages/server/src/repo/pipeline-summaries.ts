import { sql, type SQL } from 'drizzle-orm';
import {
  PIPELINE_SUMMARY_WINDOW_DAYS,
  SUMMARY_FAILED_STATUSES,
  SUMMARY_SUCCEEDED_STATUSES,
  type PipelineSummary,
  type RunStatus,
  type Trigger,
  type TriggerNextFire,
} from '@autonomy-studio/shared';
import { pipelineVersions, pipelines, runs } from '../db/schema.js';
import { listTriggers } from './triggers.js';
import type { Db } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A bound `in (…)` list — values, never interpolated text. */
function boundList(statuses: readonly string[]): SQL {
  return sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );
}

/**
 * #1569 OR37 — every live pipeline's row facts for the pipelines grid, in a
 * fixed number of reads whatever the pipeline count (OR19 #1410: no N+1):
 *
 *  1. the live pipelines, each with its latest saved version's time and node
 *     count;
 *  2. each pipeline's newest run (a window function over the owner's runs);
 *  3. the run window's counts, grouped in SQL;
 *  4. the window's p50/p95 durations, ranked in SQL — so the answer is one row
 *     per pipeline however many runs the window holds, never every run;
 *  5. the owner's triggers, and their armed next fires.
 *
 * Runs are joined to their pipeline through the immutable version they bound,
 * and are owner-proved on BOTH the run row (as the Monitor's lists are) and the
 * pipeline row: authentication ≠ authorisation. Runs bound to a Debug version
 * are left out (see `PipelineSummarySchema`). The last run is keyed on
 * `started_at`, the Monitor's own order; admission re-stamps a queued run's.
 *
 * `nextFires` is injected so this repo module does not import the scheduler
 * (`listTriggerNextFires`, which reads the ARMED alarms).
 */
export function listPipelineSummaries(
  db: Db,
  ownerId: string,
  {
    now,
    nextFires,
  }: { now: number; nextFires: (triggers: readonly Trigger[]) => TriggerNextFire[] },
): PipelineSummary[] {
  const days = PIPELINE_SUMMARY_WINDOW_DAYS;
  const since = now - days * DAY_MS;

  const heads = db.all<{
    id: string;
    updatedAt: number;
    headCreatedAt: number | null;
    activities: number | null;
  }>(sql`
    select ${pipelines.id} as id,
           ${pipelines.updatedAt} as updatedAt,
           (select max(pv.created_at) from ${pipelineVersions} pv
             where pv.pipeline_id = ${pipelines.id} and pv.debug = 0) as headCreatedAt,
           (select json_array_length(pv.nodes) from ${pipelineVersions} pv
             where pv.pipeline_id = ${pipelines.id} and pv.debug = 0
             order by pv.version desc limit 1) as activities
      from ${pipelines}
     where ${pipelines.ownerId} = ${ownerId} and ${pipelines.archived} = 0`);

  // The runs this owner may see of their live pipelines' saved versions; every
  // read below narrows it.
  const ownedRuns = sql`
    from ${runs}
    join ${pipelineVersions} on ${pipelineVersions.id} = ${runs.pipelineVersionId}
    join ${pipelines} on ${pipelines.id} = ${pipelineVersions.pipelineId}
   where ${runs.ownerId} = ${ownerId}
     and ${pipelines.ownerId} = ${ownerId}
     and ${pipelines.archived} = 0
     and ${pipelineVersions.debug} = 0`;

  const lastRuns = db.all<{
    pipelineId: string;
    runId: string;
    status: RunStatus;
    startedAt: number;
    finishedAt: number | null;
  }>(sql`
    select pipelineId, runId, status, startedAt, finishedAt from (
      select ${pipelineVersions.pipelineId} as pipelineId, ${runs.id} as runId,
             ${runs.status} as status, ${runs.startedAt} as startedAt,
             ${runs.finishedAt} as finishedAt,
             row_number() over (
               partition by ${pipelineVersions.pipelineId}
               order by ${runs.startedAt} desc, ${runs.id} desc
             ) as rn
      ${ownedRuns}
    ) where rn = 1`);

  const succeeded = boundList(SUMMARY_SUCCEEDED_STATUSES);
  const failed = boundList(SUMMARY_FAILED_STATUSES);
  const counts = db.all<{
    pipelineId: string;
    runs: number;
    succeeded: number;
    failed: number;
  }>(sql`
    select ${pipelineVersions.pipelineId} as pipelineId,
           count(*) as runs,
           sum(${runs.status} in (${succeeded})) as succeeded,
           sum(${runs.status} in (${failed})) as failed
    ${ownedRuns} and ${runs.startedAt} >= ${since}
    group by ${pipelineVersions.pipelineId}`);

  // Nearest rank: the ceil(p·n)-th shortest, as integer maths —
  // ceil(p·n) = (100p·n + 99) / 100 for a whole-percent p.
  const durations = db.all<{ pipelineId: string; p50: number; p95: number }>(sql`
    select pipelineId,
           max(case when rn = (50 * n + 99) / 100 then dur end) as p50,
           max(case when rn = (95 * n + 99) / 100 then dur end) as p95
      from (
        select pipelineId, dur,
               row_number() over (partition by pipelineId order by dur) as rn,
               count(*) over (partition by pipelineId) as n
          from (
            select ${pipelineVersions.pipelineId} as pipelineId,
                   max(0, ${runs.finishedAt} - ${runs.startedAt}) as dur
            ${ownedRuns} and ${runs.startedAt} >= ${since}
              and ${runs.finishedAt} is not null
              and ${runs.status} in (${succeeded}, ${failed})
          )
      )
     group by pipelineId`);

  // A trigger reaches a pipeline through the version it binds; an unbound one
  // (`pipelineVersionId: null`) belongs to no pipeline yet.
  const ownerTriggers = listTriggers(db, { ownerId });
  const versionIds = [
    ...new Set(
      ownerTriggers.flatMap((t) => (t.pipelineVersionId === null ? [] : [t.pipelineVersionId])),
    ),
  ];
  const pipelineOfVersion = new Map<string, string>();
  if (versionIds.length > 0) {
    for (const row of db.all<{ id: string; pipelineId: string }>(sql`
      select ${pipelineVersions.id} as id, ${pipelineVersions.pipelineId} as pipelineId
        from ${pipelineVersions}
       where ${pipelineVersions.id} in (${boundList(versionIds)})`)) {
      pipelineOfVersion.set(row.id, row.pipelineId);
    }
  }
  const triggersOf = new Map<string, Trigger[]>();
  for (const t of ownerTriggers) {
    const pid =
      t.pipelineVersionId === null ? undefined : pipelineOfVersion.get(t.pipelineVersionId);
    if (pid === undefined) continue;
    const list = triggersOf.get(pid);
    if (list === undefined) triggersOf.set(pid, [t]);
    else list.push(t);
  }
  const pipelineOfTrigger = new Map<string, string>();
  for (const [pid, ts] of triggersOf) for (const t of ts) pipelineOfTrigger.set(t.id, pid);
  const nextFireOf = new Map<string, number>();
  for (const fire of nextFires(ownerTriggers)) {
    const pid = pipelineOfTrigger.get(fire.triggerId);
    if (pid === undefined) continue;
    const prev = nextFireOf.get(pid);
    if (prev === undefined || fire.at < prev) nextFireOf.set(pid, fire.at);
  }

  const lastOf = new Map(lastRuns.map((r) => [r.pipelineId, r]));
  const countOf = new Map(counts.map((c) => [c.pipelineId, c]));
  const durOf = new Map(durations.map((d) => [d.pipelineId, d]));

  return heads.map((h): PipelineSummary => {
    const last = lastOf.get(h.id);
    const c = countOf.get(h.id);
    const d = durOf.get(h.id);
    const ok = c?.succeeded ?? 0;
    const bad = c?.failed ?? 0;
    const ts = triggersOf.get(h.id) ?? [];
    return {
      pipelineId: h.id,
      lastRun:
        last === undefined
          ? null
          : {
              runId: last.runId,
              status: last.status,
              startedAt: last.startedAt,
              finishedAt: last.finishedAt,
            },
      window: {
        days,
        runs: c?.runs ?? 0,
        succeeded: ok,
        failed: bad,
        successRate: ok + bad === 0 ? null : ok / (ok + bad),
        p50Ms: d?.p50 ?? null,
        p95Ms: d?.p95 ?? null,
      },
      triggers: {
        total: ts.length,
        enabled: ts.filter((t) => t.enabled).length,
        items: ts.map((t) => ({ id: t.id, name: t.name, mode: t.mode, enabled: t.enabled })),
      },
      nextFireAt: nextFireOf.get(h.id) ?? null,
      activities: h.activities,
      modifiedAt: Math.max(h.updatedAt, h.headCreatedAt ?? h.updatedAt),
    };
  });
}
