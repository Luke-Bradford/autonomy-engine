import { runStartIsReal, type RunSummary, type RunSummaryPage } from '@autonomy-studio/shared';
import { yieldToEventLoop } from '../connectors/scheduling.js';
import type { CsvValue } from '../util/csv.js';

/**
 * #1484 OR35 M1 — the runs grid's "CSV export of the filtered set".
 *
 * MACHINE values, not the grid's display text: a file is read by a spreadsheet
 * or a script, so times are ISO-8601 UTC to the millisecond (no zone for a
 * reader to guess), durations are milliseconds, and the triggered-by kind is its
 * vocabulary key rather than its label.
 *
 * NOT derived from the grid's `RUN_GRID_COLUMNS` (`web/src/stores/uiStore.ts`),
 * deliberately: the grid's columns are display text and a viewer's choice, and
 * a file wants every fact in machine form whatever the viewer hid. A column
 * added to the grid should be weighed for this list too.
 *
 * SECURITY — only what the grid already shows. A run's `params` and
 * `triggerContext` are deliberately NOT columns: a param may be bound to a
 * secret, and the list never shows either, so an export must not be the one
 * place they leave the server.
 */
export const RUNS_EXPORT_COLUMNS: readonly {
  readonly header: string;
  readonly value: (run: RunSummary) => CsvValue;
}[] = [
  { header: 'run_id', value: (r) => r.id },
  { header: 'pipeline', value: (r) => r.pipelineName },
  { header: 'pipeline_id', value: (r) => r.pipelineId },
  { header: 'version', value: (r) => r.pipelineVersion },
  { header: 'debug', value: (r) => r.debug },
  { header: 'status', value: (r) => r.status },
  { header: 'triggered_by', value: (r) => r.triggeredByKind },
  { header: 'trigger', value: (r) => r.triggerName },
  { header: 'trigger_id', value: (r) => r.triggerId },
  { header: 'queued_at', value: (r) => isoOrNull(r.queuedAt) },
  // A queued run's `startedAt` is a placeholder (`runStartIsReal`).
  { header: 'started_at', value: (r) => (runStartIsReal(r) ? iso(r.startedAt) : null) },
  { header: 'finished_at', value: (r) => isoOrNull(r.finishedAt) },
  {
    header: 'duration_ms',
    value: (r) =>
      !runStartIsReal(r) || r.finishedAt === null ? null : Math.max(0, r.finishedAt - r.startedAt),
  },
  { header: 'activities_succeeded', value: (r) => r.activities?.succeeded ?? null },
  { header: 'activities_failed', value: (r) => r.activities?.failed ?? null },
  { header: 'activities_skipped', value: (r) => r.activities?.skipped ?? null },
  { header: 'activities_reused', value: (r) => r.activities?.reused ?? null },
  { header: 'activities_unfinished', value: (r) => r.activities?.unfinished ?? null },
  { header: 'rows_written', value: (r) => r.rowsWritten },
  { header: 'parent_run_id', value: (r) => r.parentRunId },
  { header: 'parent_pipeline', value: (r) => r.parentPipelineName },
  { header: 'rerun_of', value: (r) => r.rerunOf },
  { header: 'child_runs', value: (r) => r.childRunCount },
  // An annotation is free text, so `;` could appear inside one; a reader that
  // needs them exact has the version doc, which holds them as an array.
  { header: 'annotations', value: (r) => r.annotations.join('; ') },
  { header: 'cost_usd', value: (r) => r.cost.totalCostEstimate },
  // `false` when a response's cost is unknown, so `cost_usd` is a floor.
  { header: 'cost_complete', value: (r) => r.cost.complete },
];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms);
}

/** One CSV row per run, in `RUNS_EXPORT_COLUMNS` order. */
export function runExportRow(run: RunSummary): CsvValue[] {
  return RUNS_EXPORT_COLUMNS.map((column) => column.value(run));
}

/**
 * Every run the filters match, in the list's order, up to `max`.
 *
 * Walks the list's own keyset pages (`readPage` is one `listRunSummariesPage`
 * call), so the export and the grid are one query and cannot disagree about
 * which runs match or in what order.
 *
 * - **Bounded.** Each page asks for at most what is still wanted, so the
 *   one-extra-row probe tells "exactly `max`" from "more than `max`":
 *   `truncated` is true only when the list's probe found a further row. (Under
 *   a non-default sort that row can be one a page already gave, below — then
 *   the note over-warns, which is the safe direction.)
 * - **Yields between pages.** `better-sqlite3` is synchronous, so one page is a
 *   stall of the whole server for its duration. Yielding between pages bounds
 *   that stall at a page rather than at the export (`limits.ts`'s §9 note).
 * - **De-duplicated by id.** Each page is its own transaction, and under any
 *   sort but the default a row can move between pages while the walk runs (a run
 *   finishing changes its Duration). The grid drops a repeat by key; this drops
 *   it here. A run skipped the same way is not recoverable without one long
 *   transaction, which is the stall this walk exists to avoid.
 * - **Refuses a cursor it has already followed**, as `fetchAllPages` does in
 *   the web package: pages of nothing but repeats under a cursor that recurs
 *   (`A`, or `A → B → A`) would otherwise loop until the request is abandoned.
 */
export async function collectRunsForExport(
  readPage: (limit: number, cursor: string | undefined) => RunSummaryPage,
  pageSize: number,
  max: number,
): Promise<{ runs: RunSummary[]; truncated: boolean }> {
  const out: RunSummary[] = [];
  const seen = new Set<string>();
  const followed = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = readPage(Math.min(pageSize, max - out.length), cursor);
    for (const run of page.items) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      out.push(run);
    }
    if (page.nextCursor === null) return { runs: out, truncated: false };
    if (out.length >= max) return { runs: out, truncated: true };
    if (followed.has(page.nextCursor)) {
      throw new Error('runs export: the list returned a cursor it had already given');
    }
    followed.add(page.nextCursor);
    cursor = page.nextCursor;
    await yieldToEventLoop();
  }
}
