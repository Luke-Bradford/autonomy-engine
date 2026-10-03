import {
  isWithinRunWindows,
  type TriggerNextFire,
  type TriggerPublic,
} from '@autonomy-studio/shared';
import { formatWhen } from '../runs/format';
import type { BindingSelection } from '../triggers/binding';
import type { ActiveVersionState } from './versionHistory';

/**
 * #1476 OR28 slice 3 — the rules behind the editor's Trigger ▾ → New trigger…:
 * what a trigger made from the editor starts bound to, and when one cannot be
 * made yet. Pure, beside `runNowRules`, which answers the same questions for
 * Trigger now.
 */

/**
 * The binding a new trigger starts with, or `null` when there is no saved
 * version to bind.
 *
 * ADF's triggers fire the PUBLISHED pipeline, so the default is bind-to-active
 * wherever the server can resolve it: always in a DB-only workspace (where it
 * resolves to the latest version — the settled bind-to-latest rule), and in a
 * git workspace only once something is published (otherwise the server
 * refuses it with a 400). Everywhere else — git with nothing published, or a
 * publish state that failed to load — it pins the latest saved version, which
 * is always a binding the server accepts. Never a guess at active.
 */
export function newTriggerBinding({
  pipelineId,
  head,
  active,
  gitConnected,
}: {
  pipelineId: string;
  head: { id: string } | null;
  active: ActiveVersionState;
  gitConnected: boolean | undefined;
}): BindingSelection | null {
  if (head === null) return null;
  const activeResolves =
    gitConnected === false || (gitConnected === true && active !== null && active !== undefined);
  return activeResolves
    ? { kind: 'active', pipelineId }
    : { kind: 'concrete', pipelineVersionId: head.id };
}

/** Why New trigger… cannot be pressed, or `null` when it can. */
export function newTriggerReason({
  ready,
  archived,
  headVersion,
}: {
  ready: boolean;
  archived: boolean;
  headVersion: number | null;
}): string | null {
  if (!ready) return 'Wait for the pipeline to load.';
  if (archived)
    return 'This pipeline is archived, so a trigger could not run it. Unarchive it first.';
  if (headVersion === null) return 'Save a version first: a trigger fires a saved version.';
  return null;
}

/** What an enabled New trigger… says the trigger will fire. */
export function newTriggerTitle(
  binding: BindingSelection,
  headVersion: number,
  gitConnected: boolean | undefined,
  dirty: boolean,
): string {
  const what =
    binding.kind === 'active'
      ? gitConnected === true
        ? 'Fires the published version.'
        : `Fires the latest saved version (v${String(headVersion)} now).`
      : `Fires v${String(headVersion)}, the latest saved version.`;
  return dirty ? `${what} Your unsaved edits are not included.` : what;
}

/**
 * #1476 slice 4 — when a listed trigger is next due, as row text, or `null`
 * when there is nothing to say (a disabled trigger, or a mode that does not
 * fire on a clock).
 *
 * Worded as what is SCHEDULED, never "next run": a concurrency cap or an
 * archived pipeline can still hold or skip a fire at that moment. The one skip
 * the row can know about ahead of time it states — a schedule tick that falls
 * outside the trigger's run windows (tumbling windows are not gated by them).
 * That check is best-effort: the handler judges the instant it is DELIVERED,
 * which is the due time unless the clock runs late, so an overdue tick is
 * judged at `readAt`, the closest the row can come to it.
 *
 * A time already past at `readAt` reads "due now": the alarm is due and the
 * clock has not delivered it yet (an overdue backfill window included).
 */
export function nextFireText(
  t: Pick<TriggerPublic, 'enabled' | 'mode' | 'runWindows'>,
  next: TriggerNextFire | undefined,
  readAt: number,
): string | null {
  if (!t.enabled || (t.mode !== 'schedule' && t.mode !== 'tumbling')) return null;
  if (next === undefined) return 'nothing scheduled';
  const overdue = next.at <= readAt;
  if (next.source === 'window') {
    return overdue ? 'a closed window is due now' : `next window closes ${formatWhen(next.at)}`;
  }
  const what = overdue ? 'a scheduled tick is due now' : `next scheduled ${formatWhen(next.at)}`;
  return isWithinRunWindows(t.runWindows, new Date(Math.max(next.at, readAt)))
    ? what
    : `${what}, outside its run windows so skipped`;
}
