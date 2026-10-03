import { sql, type SQL } from 'drizzle-orm';
import type { RunTriggeredByKind } from '@autonomy-studio/shared';
import {
  pipelineVersions,
  runs,
  triggers,
  tumblingWindowState,
  webhookDeliveries,
} from '../db/schema.js';

/**
 * #1484 OR35 M1 — what STARTED a run (`RUN_TRIGGERED_BY_KINDS`), as ONE SQL
 * expression rather than a TypeScript function. The Monitor will filter and sort
 * by this server-side under keyset paging, and a `WHERE` cannot call TypeScript;
 * an expression can be selected now and reused in a predicate later, so there is
 * never a second classifier to drift from this one.
 *
 * The query that selects it must join `pipeline_versions` (inner) and `triggers`
 * (left) on the run, as `listRunSummariesPage` does.
 *
 * PRECEDENCE, first match wins:
 * 1. `rerun_of` set → `rerun`. A reseed row has no trigger, no context and no
 *    parent, so this must come before the editor fallback. `rerun_of` is
 *    `ON DELETE SET NULL`, so a rerun whose SOURCE was deleted reads `editor`:
 *    the row no longer carries the fact, and this does not invent it back.
 * 2. `parent_run_id` set → `call`.
 * 3. Trigger-launched (a trigger context, or a trigger id on a pre-S9 row) →
 *    the `fireKind` the firing caller stamped. The context survives the
 *    trigger's deletion (`trigger_id` is `ON DELETE SET NULL`; the JSON is not),
 *    so a deleted trigger's runs keep their kind.
 * 4. A debug version → `debug` (a debug version can never be bound to a trigger;
 *    `routes/triggers.ts` refuses it).
 * 5. Otherwise → `editor`: the editor's Run of a saved version.
 *
 * ROWS WRITTEN BEFORE `fireKind` EXISTED carry no stamp, so step 3 reads the best
 * surviving evidence, exact where a table recorded the link:
 * - a tumbling window's run (`tumbling_window_state.run_id`, or window facts on
 *   the context) → `tumbling`. Checked before `scheduledTime`, which a tumbling
 *   fire also sets (to its window end);
 * - an occurrence time → `schedule`;
 * - a recorded webhook delivery (`webhook_deliveries.run_id`) → `webhook`;
 * - an event-mode trigger's fire WITH a body → `event` (Fire now sends params,
 *   never a body);
 * - a pre-S9 row with no context at all → its trigger's mode when that is
 *   `schedule` or `event`. That is a GUESS: those rows cannot tell a tick from a
 *   Fire now;
 * - anything else → `manual` (Fire now).
 */
export const RUN_TRIGGERED_BY_SQL: SQL<RunTriggeredByKind> = sql<RunTriggeredByKind>`case
  when ${runs.rerunOf} is not null then 'rerun'
  when ${runs.parentRunId} is not null then 'call'
  when ${runs.triggerContext} is not null or ${runs.triggerId} is not null then coalesce(
    json_extract(${runs.triggerContext}, '$.fireKind'),
    case
      when json_extract(${runs.triggerContext}, '$.windowEpoch') is not null
        or json_extract(${runs.triggerContext}, '$.windowStart') is not null
        or exists (select 1 from ${tumblingWindowState} where ${tumblingWindowState.runId} = ${runs.id})
        then 'tumbling'
      when json_extract(${runs.triggerContext}, '$.scheduledTime') is not null then 'schedule'
      when exists (select 1 from ${webhookDeliveries} where ${webhookDeliveries.runId} = ${runs.id})
        then 'webhook'
      when ${runs.triggerContext} is not null and ${triggers.mode} = 'event'
        and json_extract(${runs.triggerContext}, '$.body') is not null then 'event'
      when ${runs.triggerContext} is null and ${triggers.mode} in ('schedule', 'event')
        then ${triggers.mode}
      else 'manual'
    end
  )
  when ${pipelineVersions.debug} then 'debug'
  else 'editor'
end`;
