import type { RunsExport } from './useRunsExport';

/**
 * #1484 OR35 M1 — the runs list's Export CSV (`useRunsExport`). On the title
 * row; disabled while an export is in flight, so a second click cannot start a
 * second walk of the same list.
 */
export function RunsExportButton({ exporter }: { exporter: RunsExport }) {
  return (
    <button
      type="button"
      onClick={exporter.start}
      disabled={exporter.busy}
      title="Save every run these filters match as a CSV file"
    >
      {exporter.busy ? 'Exporting…' : 'Export CSV'}
    </button>
  );
}

/**
 * What the last export has to say. BELOW the title row, never on it: the row
 * does not wrap (`index.css`, `.runs-page > .page-header`), and a server's error
 * message is as long as it likes.
 */
export function RunsExportNote({ exporter }: { exporter: RunsExport }) {
  const { note } = exporter;
  if (note === null) return null;
  return note.kind === 'error' ? (
    <p role="alert" className="error">
      {note.text}
    </p>
  ) : (
    <p role="status" className="runs-export-note">
      {note.text}
    </p>
  );
}
