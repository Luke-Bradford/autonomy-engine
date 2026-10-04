import { useEffect, useRef, useState } from 'react';
import { exportRunsCsv, type ListRunsQuery } from '../../api/runs';
import { downloadBlob } from '../../api/download';
import { messageOf } from '../../api/client';
import { runsExportFileName, runsExportTruncatedLabel } from './runsExport';

export interface RunsExport {
  /** Save every run the query matches. A no-op while one is in flight. */
  start: () => void;
  busy: boolean;
  /** What the last export has to say, or `null`: a failure, or a cut file. */
  note: { kind: 'error' | 'truncated'; text: string } | null;
}

/**
 * #1484 OR35 M1 — "CSV export of the filtered set": every run `query` matches,
 * in its order, through `GET /api/runs/export.csv` — the whole set, not the
 * pages the grid has loaded.
 *
 * The note describes the FILE the last export produced (or failed to), so it
 * stands even if the filters change while that export is on its way: a cut file
 * or a missing one is news whatever the list now shows. A filter change after
 * the note is up clears it, since it would read as being about the new list.
 * Failure saves nothing (`download.ts`).
 *
 * `query` must be identity-stable (memoised, as `RunsPage`'s `listQuery` is):
 * a new identity IS a filter change here, and clears the note.
 */
export function useRunsExport(query: ListRunsQuery): RunsExport {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<RunsExport['note']>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const [noteFor, setNoteFor] = useState(query);
  if (noteFor !== query) {
    setNoteFor(query);
    setNote(null);
  }

  async function run() {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setNote(null);
    try {
      const { file, truncated } = await exportRunsCsv(query, abort.signal);
      downloadBlob(runsExportFileName(Date.now()), file);
      if (truncated !== null) {
        setNote({ kind: 'truncated', text: runsExportTruncatedLabel(truncated) });
      }
    } catch (err) {
      if (!abort.signal.aborted)
        setNote({ kind: 'error', text: `Export failed: ${messageOf(err)}` });
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return {
    start: () => {
      if (!busy) void run();
    },
    busy,
    note,
  };
}
