import type { Param } from '@autonomy-studio/shared';
import { rowsFrom } from './callRules';
import { coerceDefaultInput } from './paramRules';

/**
 * #1395 OR4 — the rules behind the editor's Run form: one text row per declared
 * param, prefilled from the version's defaults, turned back into typed values
 * with the SAME coercion the params editor uses for a default
 * (`coerceDefaultInput`). One answer about what `42` means in a `number` field.
 *
 * Unlike a `call_pipeline` node's arguments (`callRules.buildParams`), there is
 * no `${}` branch: nothing resolves an expression at run start, so `${x}` here
 * is the literal text, and a `number` param refuses it.
 */

/** The rows to show: every declared param, holding its default where it has one. */
export function runNowRows(params: readonly Param[]): Record<string, string> {
  const defaults: Record<string, unknown> = {};
  for (const p of params) {
    if (Object.prototype.hasOwnProperty.call(p, 'default')) defaults[p.name] = p.default;
  }
  return rowsFrom(defaults, new Map(params.map((p) => [p.name, p])));
}

type RunNowParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Typed run-now values from the rows.
 *
 * A BLANK row sends nothing, so the version's default applies — which is also
 * what a prefilled default left as it is means. Consequence, stated rather than
 * hidden: a `string` param whose default is non-empty cannot be run with `''`
 * from this form. A blank REQUIRED param with no default is refused here with
 * the server's own wording, before the request is made.
 */
export function buildRunNowParams(
  rows: Readonly<Record<string, string>>,
  params: readonly Param[],
): RunNowParse {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const parsed = coerceDefaultInput(p.type, rows[p.name] ?? '');
    if (!parsed.ok) return { ok: false, error: `${p.name}: ${parsed.error}` };
    if (parsed.has) {
      out[p.name] = parsed.value;
    } else if (p.required && !Object.prototype.hasOwnProperty.call(p, 'default')) {
      return { ok: false, error: `${p.name}: a value is required` };
    }
  }
  return { ok: true, value: out };
}

/**
 * Why the header's Run cannot be pressed, or `null` when it can. Run starts the
 * LATEST SAVED version, never the working graph — running the unsaved draft is
 * Debug (`debugDisabledReason`).
 */
export function runDisabledReason({
  ready,
  archived,
  headVersion,
  previewing,
}: {
  ready: boolean;
  archived: boolean;
  headVersion: number | null;
  previewing: boolean;
}): string | null {
  if (!ready) return 'Wait for the pipeline to load.';
  if (archived) return 'This pipeline is archived, so it cannot run. Unarchive it first.';
  if (headVersion === null) return 'Save a version first: Run starts the latest saved version.';
  // A preview shows an OLDER version while Run would start the latest: pressing
  // it there would run something other than what is on screen.
  if (previewing) return 'Leave the preview to run the latest saved version.';
  return null;
}

/** What an enabled Run says it will do — including what it leaves out. */
export function runTitle(headVersion: number, dirty: boolean): string {
  const what = `Run v${String(headVersion)}, the latest saved version`;
  return dirty ? `${what}. Your unsaved edits are not included.` : `${what}.`;
}

/**
 * #1395 OR4 slice 3 — why the header's Debug cannot be pressed, or `null` when it
 * can. Debug runs the WORKING graph, so it needs no saved version, but it goes
 * through the same write gate as a save: a draft with validation issues would
 * only bounce off the server, so it is refused here with the save's own
 * pointer to the Problems panel.
 */
export function debugDisabledReason({
  ready,
  archived,
  previewing,
  issueCount,
}: {
  ready: boolean;
  archived: boolean;
  previewing: boolean;
  issueCount: number;
}): string | null {
  if (!ready) return 'Wait for the pipeline to load.';
  if (archived) return 'This pipeline is archived, so it cannot run. Unarchive it first.';
  // A preview shows an older version while the working graph is hidden: Debug
  // would run something that is not on screen.
  if (previewing) return 'Leave the preview to debug your working graph.';
  if (issueCount > 0) {
    return `Fix the ${String(issueCount)} validation issue(s) in the Problems panel to debug.`;
  }
  return null;
}

/** What an enabled Debug says it will do. */
export const DEBUG_TITLE = 'Run what is on the canvas now, without saving it as a version.';

/** #1476 OR28 — Validate's tooltip when it can be pressed. */
export const VALIDATE_TITLE =
  'Run the save check on the canvas now, without saving: Problems lists what it finds.';

/**
 * The status line after a Debug starts: that it ran the draft, and how long the
 * run is kept (`DEBUG_RETENTION_DAYS`, reported by the server; `null` = forever).
 */
export function debugStartedText(retentionDays: number | null): string {
  const kept =
    retentionDays === null
      ? 'kept until deleted'
      : `kept for ${String(retentionDays)} day${retentionDays === 1 ? '' : 's'}`;
  return `Debug run started from the unsaved draft (not added to the versions; ${kept}).`;
}

/**
 * #1476 OR28 — why the header's Validate cannot be pressed, or `null` when it
 * can. Validate CHECKS the working graph and writes nothing, so — unlike Debug
 * — issues already listed do not refuse it (finding them is its job), and
 * neither does an archived pipeline. A preview hides the working graph, so
 * validating it would check something that is not on screen.
 */
export function validateDisabledReason({
  ready,
  previewing,
  validating,
}: {
  ready: boolean;
  previewing: boolean;
  validating: boolean;
}): string | null {
  if (!ready) return 'Wait for the pipeline to load.';
  if (previewing) return 'Leave the preview to validate your working graph.';
  if (validating) return 'Validating…';
  return null;
}
