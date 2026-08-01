/**
 * U22 slice 1 — the version history list, and the bar that sits over a
 * read-only preview of one version (#903).
 *
 * Named `…Panel` so it cannot collide with `versionHistory.ts` beside it: on a
 * case-insensitive filesystem (the default on macOS, which is where this is
 * developed) `./VersionHistory` resolves to the pure module, and every export
 * arrives `undefined` with no build error. The same reason `externalWaits.ts`
 * sits beside `PendingCallbacks.tsx` rather than beside an `ExternalWaits.tsx`.
 *
 * Presentational only: every decision it renders (ordering, the head/current
 * marks, whether a restore is allowed and what the confirmation says) is made
 * in `versionHistory.ts`, where a unit test can reach it without React Flow.
 */
import { formatWhen } from '../runs/format';
import type { VersionEntry } from './versionHistory';

interface VersionHistoryProps {
  entries: VersionEntry[];
  /** The version being previewed, or `null` while the editor is on screen. */
  previewing: number | null;
  onPreview: (version: number) => void;
}

/** A version's shape in one line — what an operator picks between. */
function shapeSummary(e: VersionEntry): string {
  const parts = [
    `${String(e.nodeCount)} node${e.nodeCount === 1 ? '' : 's'}`,
    `${String(e.edgeCount)} edge${e.edgeCount === 1 ? '' : 's'}`,
  ];
  if (e.containerCount > 0) {
    parts.push(`${String(e.containerCount)} container${e.containerCount === 1 ? '' : 's'}`);
  }
  if (e.paramCount > 0) {
    parts.push(`${String(e.paramCount)} param${e.paramCount === 1 ? '' : 's'}`);
  }
  if (e.outputCount > 0) {
    parts.push(`${String(e.outputCount)} output${e.outputCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

export function VersionHistoryPanel({ entries, previewing, onPreview }: VersionHistoryProps) {
  if (entries.length === 0) {
    return (
      <div className="version-history" data-testid="version-history">
        <p className="page-hint">
          No versions yet — “Save version” mints the first one, and every save after it is kept.
        </p>
      </div>
    );
  }

  return (
    <div className="version-history" data-testid="version-history">
      <ul className="version-history-list">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className={`version-history-row${e.version === previewing ? ' is-previewing' : ''}`}
              /* The pressed state is the honest role here: the row is a toggle
                 into a preview, not a navigation. */
              aria-pressed={e.version === previewing}
              onClick={() => {
                onPreview(e.version);
              }}
            >
              <strong>v{e.version}</strong>
              {e.isHead && <span className="version-history-tag">latest</span>}
              {/* Two different facts, and they part company the moment a
                  preview is open: `current` is what the EDITOR is based on. */}
              {e.isCurrent && <span className="version-history-tag">on the canvas</span>}
              <span className="version-history-when">{formatWhen(e.createdAt)}</span>
              <span className="version-history-shape">{shapeSummary(e)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface VersionPreviewBarProps {
  version: number;
  /** Why this version cannot be restored, or `null` if it can. */
  refusal: string | null;
  restoring: boolean;
  onRestore: () => void;
  onBackToEditing: () => void;
}

/**
 * The bar over a read-only preview. It carries the ONLY route to a restore,
 * which is deliberate twice over: an operator should see a version before
 * replacing the head with it, and the preview is what unmounts the editor's
 * `FlowCanvas` — so the restore that follows remounts it, and the restored
 * node POSITIONS reach the screen. React Flow owns positions once a node id is
 * in its view array, so a domain position write into a live canvas would be
 * dropped and the restore would look half-applied.
 */
export function VersionPreviewBar({
  version,
  refusal,
  restoring,
  onRestore,
  onBackToEditing,
}: VersionPreviewBarProps) {
  return (
    <div className="version-preview-bar" data-testid="version-preview-bar" role="status">
      <strong>Viewing v{version} — read-only.</strong>
      {refusal !== null && <span className="version-preview-refusal">{refusal}</span>}
      <div className="form-actions">
        <button type="button" onClick={onBackToEditing}>
          Back to editing
        </button>
        <button
          type="button"
          onClick={onRestore}
          disabled={refusal !== null || restoring}
          /* The reason is on screen already; naming it here too is what a
             screen reader gets instead of an unexplained disabled control. */
          title={refusal ?? undefined}
        >
          {restoring ? 'Restoring…' : `Restore v${version}`}
        </button>
      </div>
    </div>
  );
}
