import { useCallback, useState } from 'react';
import type { ConnectionDependentsResponse, Dataset } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { listConnectionDependents } from '../../api/connections';
import { listDatasets } from '../../api/datasets';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';

/**
 * What an EDIT connection form's advisories read: the datasets bound to the
 * connection (#1174, the strand note) and the dependents a kind change or a
 * delete would switch off (#1211). Shared by Manage → Connections and the
 * editor's Edit connection column (#1477), so both forms warn from the same
 * readings.
 *
 * THREE STATES, NOT TWO, for each pair. `null` with no error is "not read yet";
 * a non-null `…Unavailable` is "could not read"; a value is a value. An empty
 * list and a failed read must stay distinguishable, because collapsing them
 * would render "nothing would be stranded" on the strength of a fetch that
 * failed (prevention-log #18 — the healthy verdict is earned, never the
 * fallback). `strandedDatasets.ts` and `dependentTriggers.ts` are total over
 * the three. The two pairs are separate because they come from different
 * routes and either can fail alone: a shared "unavailable" would silence the
 * advisory that did succeed.
 *
 * Failures stay LOCAL to the advisory: a diagnostic that could not be computed
 * must not present as a failure of the page or column hosting the form.
 *
 * `loadFor` is called ON EDIT-FORM OPEN, not on mount, and that is the whole
 * staleness argument: a mount load would be read hours later by an operator
 * who left the tab open and added datasets elsewhere, and would then answer
 * "nothing would be stranded" from a snapshot that predates them. Bound to the
 * gesture, the reading is at most as old as the form. Not for a New form: a
 * connection that does not exist yet has nothing bound to it.
 */
export function useConnectionAdvisories() {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [datasetsUnavailable, setDatasetsUnavailable] = useState<string | null>(null);
  const [dependents, setDependents] = useState<ConnectionDependentsResponse | null>(null);
  const [dependentsUnavailable, setDependentsUnavailable] = useState<string | null>(null);
  /*
   * One `useGuardedLoad` instance per state target, deliberately: two fetchers
   * sharing one instance discard each other's answers. (`DatasetsPage.tsx`
   * loads datasets and connections through ONE fetcher and says why — its store
   * picker resolves one list against the other. Here they are not resolved
   * against each other, and one fetcher would let a datasets outage take the
   * trigger advisory down with it.)
   */
  const datasetsLoad = useGuardedLoad();
  const dependentsLoad = useGuardedLoad();

  const loadFor = useCallback(
    (connectionId: string) => {
      setDatasets(null);
      setDatasetsUnavailable(null);
      setDependents(null);
      setDependentsUnavailable(null);
      void datasetsLoad(listDatasets, {
        onData: (list) => {
          setDatasets(list);
          setDatasetsUnavailable(null);
        },
        onError: (err) => {
          setDatasets(null);
          setDatasetsUnavailable(messageOf(err));
        },
      });
      void dependentsLoad((signal) => listConnectionDependents(connectionId, signal), {
        onData: (result) => {
          setDependents(result);
          setDependentsUnavailable(null);
        },
        onError: (err) => {
          setDependents(null);
          setDependentsUnavailable(messageOf(err));
        },
      });
    },
    [datasetsLoad, dependentsLoad],
  );

  return { datasets, datasetsUnavailable, dependents, dependentsUnavailable, loadFor };
}
