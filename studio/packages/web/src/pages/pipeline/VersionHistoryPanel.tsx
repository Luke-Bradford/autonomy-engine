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
  /**
   * Inert rows. Set while a restore is in flight: a row toggles the preview,
   * and both directions (leaving it, or switching to another version) remount
   * the editor under a response that is about to rebase the canvas.
   *
   * Required rather than defaulted to `false` — a caller that forgets it should
   * fail to compile, not silently get the unlocked behaviour.
   */
  locked: boolean;
  onPreview: (version: number) => void;
}

function count(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * A version's shape in one line — what an operator picks between.
 *
 * Nodes and edges are always stated, including at zero (an empty version is a
 * real thing to have saved, and "0 nodes" is what says so). The other three are
 * stated only when present, so a doc with no containers does not carry three
 * zeroes past every row that does.
 */
function shapeSummary(e: VersionEntry): string {
  const parts = [count(e.nodeCount, 'node'), count(e.edgeCount, 'edge')];
  if (e.containerCount > 0) parts.push(count(e.containerCount, 'container'));
  if (e.paramCount > 0) parts.push(count(e.paramCount, 'param'));
  if (e.outputCount > 0) parts.push(count(e.outputCount, 'output'));
  return parts.join(' · ');
}

export function VersionHistoryPanel({
  entries,
  previewing,
  locked,
  onPreview,
}: VersionHistoryProps) {
  if (entries.length === 0) {
    return (
      <div className="version-history" id="version-history-panel" data-testid="version-history">
        <p className="page-hint">
          No versions yet — “Save version” mints the first one, and every save after it is kept.
        </p>
      </div>
    );
  }

  return (
    <div className="version-history" id="version-history-panel" data-testid="version-history">
      <ul className="version-history-list">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className={`version-history-row${e.version === previewing ? ' is-previewing' : ''}`}
              /* The pressed state is the honest role here: the row is a toggle
                 into a preview, not a navigation. */
              aria-pressed={e.version === previewing}
              disabled={locked}
              title={locked ? 'Restoring — wait for it to finish.' : undefined}
              onClick={() => {
                onPreview(e.version);
              }}
            >
              <strong>v{e.version}</strong>
              {e.isHead && <span className="version-history-tag">latest</span>}
              {/* Two different facts, and they part company the moment a
                  preview is open: `current` is what the EDITOR is based on. */}
              {e.isCurrent && <span className="version-history-tag">on the canvas</span>}
              {/* #979 — a THIRD fact, and the only one that describes what is
                  deployed: what a new `active`-bound trigger will resolve to. */}
              {e.isActive && <span className="version-history-tag is-active">active</span>}
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
  /**
   * #979 — why this version cannot be PUBLISHED, or `null` if it can. Its own
   * prop rather than a shared `refusal`: the two acts are refused for entirely
   * different reasons and are routinely available one at a time (the head can
   * be published but not restored; an imported older version, the reverse).
   */
  publishRefusal: string | null;
  publishing: boolean;
  onPublish: () => void;
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
  publishRefusal,
  publishing,
  onPublish,
  onRestore,
  onBackToEditing,
}: VersionPreviewBarProps) {
  // Both in-flight acts make the bar's own controls inert; only the RESTORE
  // rebases the canvas, which is why `previewLocked` upstream still keys on
  // `restoring` alone (publishing moves a pointer and touches no editor state).
  const busy = restoring || publishing;
  return (
    <div className="version-preview-bar" data-testid="version-preview-bar" role="status">
      <strong>Viewing v{version} — read-only.</strong>
      {refusal !== null && <span className="version-preview-refusal">{refusal}</span>}
      <div className="form-actions">
        <button
          type="button"
          onClick={onBackToEditing}
          /* The restore rebases the canvas onto the version it is minting, and
             that is only safe into an editor that is not mounted. Leaving here
             mid-flight remounts one, and anything typed into it would be
             overwritten by the arriving response. */
          disabled={busy}
          title={busy ? 'Wait for the action in flight to finish.' : undefined}
        >
          Back to editing
        </button>
        <button
          type="button"
          onClick={onRestore}
          disabled={refusal !== null || busy}
          /* The reason is on screen already; naming it here too is what a
             screen reader gets instead of an unexplained disabled control. */
          title={refusal ?? undefined}
        >
          {restoring ? 'Restoring…' : `Restore v${version}`}
        </button>
        <button
          type="button"
          onClick={onPublish}
          disabled={publishRefusal !== null || busy}
          /* Unlike the restore refusal, this one is NOT printed in the bar: it
             is the ordinary state of nearly every version (git provenance is
             stamped only on an import), so showing it standingly would read as
             a permanent error banner.

             But `title` alone is not an accessible substitute for the restore
             refusal's on-screen sentence — a disabled control is skipped by
             much AT, and a tooltip needs a hover nobody on a keyboard can
             produce. So the reason is also carried in a visually-hidden element
             the button DESCRIBES itself by: hidden from the layout, present in
             the accessibility tree. */
          title={publishRefusal ?? undefined}
          aria-describedby={publishRefusal !== null ? 'publish-refusal' : undefined}
        >
          {publishing ? 'Publishing…' : `Publish v${version}`}
        </button>
        {publishRefusal !== null && (
          <span id="publish-refusal" className="visually-hidden">
            {publishRefusal}
          </span>
        )}
      </div>
    </div>
  );
}
