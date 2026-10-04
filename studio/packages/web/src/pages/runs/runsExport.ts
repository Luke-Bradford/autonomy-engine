/** #1484 OR35 M1 — the runs CSV export's wording and file name (`RunsExportButton`). */

/**
 * The file name for an export taken at `now`: `runs-YYYYMMDD-HHmmssZ.csv`, in
 * UTC. No `:` in it, which Windows refuses in a file name.
 */
export function runsExportFileName(now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `runs-${stamp}Z.csv`;
}

/** What the page says when an export stopped at the server's cap. */
export function runsExportTruncatedLabel(cap: number): string {
  return `Exported the first ${cap.toLocaleString('en')} runs. Narrow the filters for the rest.`;
}
