import {
  DATASET_CONNECTION_KINDS,
  type ConnectionKind,
  type Dataset,
} from '@autonomy-studio/shared';

/**
 * #1174 — which datasets an edit to a connection would STRAND, computed once
 * for the two surfaces that have to say it.
 *
 * THE DEFECT. A connection's `kind` is mutable (`routes/connections.ts`
 * documents the transition) and its row is deletable, and nothing re-checks the
 * datasets that named it — `routes/datasets.ts` gates `connectionId` at
 * DATASET-write time only, and there is no reverse edge. #1158 made the
 * consequence visible on the datasets LIST (`datasets/StoreCell.tsx`). This is
 * the other end of the same edit: the operator makes the change on the
 * Connections page and, until now, found out on a different page, later, only
 * if they went looking. The point at which they can still reconsider is the
 * edit itself.
 *
 * ADVISORY, NEVER A GATE — the polarity #1145 and #1158 both set deliberately,
 * and the reason is written down in both: the server stores these rows today
 * and refusing one would make an existing resource unsaveable after an
 * unrelated rename. Dispatch is where this is enforced and already is, by the
 * `CONNECTION_KIND_INVALID` / `DATASET_CONNECTION_MISMATCH` pincer. Nothing
 * here disables Save or Delete.
 *
 * WHY A PURE MODULE RATHER THAN A COMPONENT. The two surfaces are not both
 * rendered: the edit form draws a note, and the delete path builds a
 * `window.confirm` STRING. A shared component would serve one of them. What
 * they actually share is the RULE and the WORDING, so those live here and each
 * surface renders the sentence its own way.
 *
 * NO NEW SERVER ROUTE, decided here because #1174 asks for it to be. Every
 * dataset row already carries `connectionId` and `api/datasets.ts`'s
 * `listDatasets()` already walks every page, so this direction of the edge is a
 * filter over rows the client can hold. It is also PROVABLY COMPLETE rather
 * than merely convenient: `GET /api/datasets` is owner-scoped and
 * `routes/datasets.ts`'s `requireOwnedConnection` means only the owner's
 * datasets can name the owner's connections, so no row the client cannot see
 * can reference a connection it can. The opposite direction — M9's
 * `GET /api/datasets/:id/references` — needed a route precisely because it
 * crosses pipeline VERSIONS and cannot be answered from rows the client holds.
 */

/**
 * What is known about the datasets bound to a connection, at the moment a
 * surface has to speak.
 *
 * THE THIRD STATE IS THE POINT. A list that was never read and a list that was
 * read and found empty are DIFFERENT facts, and collapsing them renders
 * "nothing would be stranded" on the strength of a fetch that failed —
 * prevention-log #18, the healthy verdict must be EARNED rather than be the
 * fallback, and #473's lesson in miniature (an absent fact manufactured as a
 * benign default). Every consumer below is total over these three.
 */
export type StrandCheck =
  /** The list is in flight. Nothing can be said yet, and nothing is claimed. */
  | { state: 'loading' }
  /** The list could not be read. `detail` is the failure's own message. */
  | { state: 'unavailable'; detail: string }
  /** The list was read. An empty `names` is a real, earned "none". */
  | { state: 'known'; names: readonly string[] };

/** How many names either surface spells out before it starts counting. */
export const STRAND_NAME_LIMIT = 5;

/**
 * `a, b and 3 more` — bounded, because neither surface has room for an
 * unbounded list. `.contract-advisory` has no `max-width` and a `window.confirm`
 * is a fixed dialog, so a workspace with forty datasets on one store would push
 * the actionable half of the sentence off both.
 */
export function formatNameList(names: readonly string[], limit = STRAND_NAME_LIMIT): string {
  const shown = names.slice(0, limit);
  const extra = names.length - shown.length;
  const listed = shown.join(', ');
  return extra > 0 ? `${listed} and ${extra} more` : listed;
}

/** Every dataset naming this connection — what a DELETE strands, whatever its kind. */
export function datasetsOnConnection(
  datasets: readonly Dataset[],
  connectionId: string,
): Dataset[] {
  return datasets.filter((dataset) => dataset.connectionId === connectionId);
}

/**
 * The datasets this kind change BREAKS: bound to the connection, agreeing with
 * the kind it has now, and not agreeing with the kind it is about to have.
 *
 * NOT "everything that disagrees with the new kind", which is the tempting
 * one-liner and is wrong twice. It would repeat, at the moment of the edit, a
 * warning the datasets list already carries for a dataset that was ALREADY
 * mismatched — and it would fire on the REPAIR direction, where a kind change
 * moves a mismatched dataset back into agreement. "Would strand" is a claim
 * about the delta, so the delta is what it is computed from.
 *
 * The membership test is `DATASET_CONNECTION_KINDS` directly rather than
 * `datasetConnectionKindAdvisory(...) === null`: that helper returns `null` for
 * TWO reasons — agreement, and a `null` connection kind it deliberately refuses
 * to speak about — so reading it as a boolean would overload a documented
 * "says nothing" into "says yes".
 */
export function strandedByKindChange(
  datasets: readonly Dataset[],
  connectionId: string,
  storedKind: ConnectionKind,
  nextKind: ConnectionKind,
): Dataset[] {
  if (storedKind === nextKind) return [];
  return datasetsOnConnection(datasets, connectionId).filter((dataset) => {
    const stores = DATASET_CONNECTION_KINDS[dataset.kind];
    return stores.includes(storedKind) && !stores.includes(nextKind);
  });
}

/**
 * The note the edit form draws when the Kind select has moved off the stored
 * kind. `null` means there is nothing to say — reached ONLY from a `known`
 * check with no stranded datasets, never from a check that failed.
 */
export function kindChangeAdvisory(check: StrandCheck, nextKind: ConnectionKind): string | null {
  switch (check.state) {
    case 'loading':
      return 'Still checking which datasets read this connection.';
    case 'unavailable':
      return `Could not check which datasets read this connection (${check.detail}) — changing its kind may strand some.`;
    case 'known': {
      if (check.names.length === 0) return null;
      const count = check.names.length;
      const noun = count === 1 ? 'dataset' : 'datasets';
      return `Saving this as a ${nextKind} connection strands ${count} ${noun} that read it (${formatNameList(check.names)}) — each keeps pointing here and fails at dispatch until its kind or its store changes.`;
    }
  }
}

/**
 * The `window.confirm` body for deleting a connection.
 *
 * `window.confirm` is the surface every other destructive act in this app uses
 * (see `author/FactoryResources.tsx` and `pipeline/FlowCanvas.tsx`, which say
 * so), and the message is built by a named function rather than inline for the
 * reason `PipelinesPage`'s `archiveConfirmMessage` is — a confirm string that
 * states a consequence is a rule, and a rule belongs somewhere a test can reach
 * it without a DOM.
 *
 * The register matches `DatasetsPage`'s own delete confirm: name the
 * consequence, not only the row.
 *
 * DELETE STRANDS EVERY dataset on the connection, not just the disagreeing
 * ones — a dangling `connectionId` is a dangling id whatever the kinds were.
 */
export function deleteConfirmMessage(connectionName: string, check: StrandCheck): string {
  const head = `Delete connection "${connectionName}"?`;
  switch (check.state) {
    case 'loading':
      return `${head}\n\nStill checking which datasets read it — any that do will be left pointing at a connection that no longer exists.`;
    case 'unavailable':
      return `${head}\n\nCould not check which datasets read it (${check.detail}) — any that do will be left pointing at a connection that no longer exists.`;
    case 'known': {
      if (check.names.length === 0) return head;
      const count = check.names.length;
      const verb = count === 1 ? 'dataset reads' : 'datasets read';
      return `${head}\n\n${count} ${verb} it (${formatNameList(check.names)}) and will be left pointing at a connection that no longer exists — each fails at dispatch until it is re-bound.`;
    }
  }
}
