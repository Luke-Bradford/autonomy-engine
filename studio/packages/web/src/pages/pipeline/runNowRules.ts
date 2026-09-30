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
 * Debug, a later slice of #1395.
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
