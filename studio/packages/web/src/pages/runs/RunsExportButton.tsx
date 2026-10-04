import { useEffect, useRef, useState } from 'react';
import { exportRunsCsv, type ListRunsQuery } from '../../api/runs';
import { downloadTextFile } from '../../api/download';
import { messageOf } from '../../api/client';

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

/**
 * #1484 OR35 M1 — "CSV export of the filtered set". Saves every run `query`
 * matches, in its order, through `GET /api/runs/export.csv` — the whole set, not
 * the pages the grid has loaded.
 *
 * A file the server cut at its cap says so beside the button; a failure is an
 * alert and nothing reaches the disk (`download.ts`). Disabled while one is in
 * flight, so a second click cannot start a second walk of the same list.
 */
export function RunsExportButton({ query }: { query: ListRunsQuery }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState<number | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  // The query on screen NOW, for an export that answers after a filter changed.
  const current = useRef(query);
  useEffect(() => {
    current.current = query;
  }, [query]);

  // A note about the LAST export is about the filters it was taken under, so a
  // filter change clears it rather than leaving it under a different list.
  const [shownFor, setShownFor] = useState(query);
  if (shownFor !== query) {
    setShownFor(query);
    setError(null);
    setTruncated(null);
  }

  async function exportCsv() {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    setTruncated(null);
    // The file is still saved if the filters change while it is on its way —
    // it is the export that was asked for — but its note is not shown under a
    // list it does not describe.
    const askedFor = query;
    try {
      const { csv, truncated: cap } = await exportRunsCsv(askedFor, abort.signal);
      downloadTextFile(runsExportFileName(Date.now()), csv, 'text/csv');
      if (current.current === askedFor) setTruncated(cap);
    } catch (err) {
      if (!abort.signal.aborted && current.current === askedFor) {
        setError(`Export failed: ${messageOf(err)}`);
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void exportCsv()}
        disabled={busy}
        title="Save every run these filters match as a CSV file"
      >
        {busy ? 'Exporting…' : 'Export CSV'}
      </button>
      {error !== null && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
      {truncated !== null && <span role="status">{runsExportTruncatedLabel(truncated)}</span>}
    </>
  );
}
