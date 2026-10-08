/** #1484 OR35 M1 — the runs CSV export's wording and file name (`RunsExportButton`). */

import { fileTimestamp } from '../../api/download';

/**
 * The file name for an export taken at `now`: `runs-YYYYMMDD-HHmmssZ.csv`, in
 * UTC. No `:` in it, which Windows refuses in a file name.
 */
export function runsExportFileName(now: number): string {
  return `runs-${fileTimestamp(now)}.csv`;
}

/** What the page says when an export stopped at the server's cap. */
export function runsExportTruncatedLabel(cap: number): string {
  return `The CSV holds the first ${cap.toLocaleString('en')} runs. Narrow the filters for the rest.`;
}
