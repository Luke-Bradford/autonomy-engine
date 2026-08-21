import {
  datasetConnectionKindAdvisory,
  type ConnectionPublic,
  type DatasetKind,
} from '@autonomy-studio/shared';

/**
 * The store a dataset names, by NAME where that resolves and by raw id where it
 * does not — plus, since #1158, whether the two AGREE.
 *
 * A dangling `connectionId` is reachable: `routes/datasets.ts` checks the
 * binding at WRITE time and says so explicitly — *"the connection can still be
 * deleted afterwards"* — and `routes/connections.ts`'s delete re-gates triggers
 * only, nothing scans datasets. Rendering an unresolved id as blank would leave
 * the one page whose job is to make the binding legible saying nothing about
 * the one binding that is broken.
 *
 * #1158's addition is the same argument one step out. A connection's `kind` is
 * MUTABLE (`routes/connections.ts` documents the transition), and nothing
 * re-checks the datasets that named it — so a `sqlite` store can become an
 * `http` connection and strand every dataset on it. #1145 already computes the
 * sentence for that, but rendered it on the edit FORM, where it is only ever
 * read by someone who already suspected. Here it is unmissable.
 *
 * ADVISORY, never a gate — the polarity `datasetConnectionKindAdvisory` and
 * #1145 both set deliberately, and #1158 restates: nothing here disables or
 * refuses anything. Dispatch is where this is enforced, and it already is, by a
 * pincer (`CONNECTION_KIND_INVALID` / `DATASET_CONNECTION_MISMATCH`). This is a
 * diagnostic, so an operator finds out before a schedule does.
 *
 * LIFTED out of `DatasetsPage.tsx` at #996 M9, unchanged: the dataset DETAIL
 * page shows the same store and owes the same advisory, and a detail page that
 * said less about a dataset than the list it is reached from would be a strange
 * thing to build. It is the shared surface for both, not a copy.
 *
 * Compact where it is DRAWN, complete where it is READ. The cell sits in a
 * fixed-width table and the advisory runs to ~20 words; five of them stacked is
 * a wall nobody reads. The short marker carries the full sentence BOTH ways,
 * which is the pattern `RunTimeline`, `TokenFlowChart` and
 * `VersionHistoryPanel` already share: `visually-hidden` text so it is in the
 * accessible name (a `title` alone is a tooltip a keyboard never opens), and
 * `title` so a sighted mouse user gets the same sentence on hover instead of
 * being sent to the edit form to find out what "mismatch" meant.
 *
 * No glyph. Every other `.contract-advisory` in this file and across
 * `packages/web/src` is plain text, and the ones that DO pair a decorative mark
 * with a longer string (`HubRail`, `ActivityToolbox`) put the mark in its own
 * `aria-hidden` span so it stays out of the accessible name. A bare `⚠` folded
 * into that name would be read aloud differently by every screen reader, for no
 * gain the `.contract-advisory` colour does not already carry.
 */
export function StoreCell({
  connections,
  connectionId,
  datasetKind,
}: {
  connections: readonly ConnectionPublic[];
  connectionId: string;
  datasetKind: DatasetKind;
}) {
  const hit = connections.find((conn) => conn.id === connectionId);
  if (!hit) {
    return (
      <span className="contract-advisory">
        <code>{connectionId}</code> (missing)
      </span>
    );
  }
  // A resolved connection is the ONLY state with a kind to compare. The helper
  // refuses to speak on a null one, so the dangling branch above returns first
  // rather than passing `null` down and relying on that.
  const disagreement = datasetConnectionKindAdvisory(datasetKind, hit.kind);
  return (
    <>
      {hit.name}
      {disagreement !== null && (
        <>
          {' '}
          <span className="contract-advisory" title={disagreement}>
            kind mismatch
            <span className="visually-hidden">: {disagreement}</span>
          </span>
        </>
      )}
    </>
  );
}
