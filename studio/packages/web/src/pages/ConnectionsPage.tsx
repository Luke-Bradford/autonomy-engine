import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectionDependentsResponse,
  type ConnectionPublic,
  type Dataset,
} from '@autonomy-studio/shared';
import { messageOf } from '../api/client';
import { deleteConnection, listConnectionDependents, listConnections } from '../api/connections';
import { listDatasets } from '../api/datasets';
import { downloadTextFile, exportFileName } from '../api/download';
import { exportConnection } from '../api/portability';
import { useBusyAction } from '../hooks/useBusyAction';
import { useGuardedLoad } from '../hooks/useGuardedLoad';
import {
  datasetsOnConnection,
  deleteConfirmMessage,
  type StrandCheck,
} from './connections/strandedDatasets';
import { deleteConfirmTriggerClause, type TriggerCheck } from './connections/dependentTriggers';
import { deleteConfirmNodeClause, nodeCheckOf } from './connections/dependentNodes';
import { ImportPanel } from './ImportPanel';
import { useDrawerForm } from '../lib/form/useDrawerForm';
import { ConnectionKindName } from '../lib/KindName';
import { ConnectionKindDrawer } from '../lib/ConnectionKindGallery';
import { useConfirm } from '../lib/confirm/useConfirm';
import { useFocusAfterRemoval } from '../hooks/useFocusAfterRemoval';
import { RowMoreMenu, type RowMenuOrigin } from '../lib/RowMoreMenu';

import { ConnectionForm } from './connections/ConnectionForm';
import { blankForm, formForEdit, savePayloadSignature } from './connections/connectionFormState';
/**
 * Connections page: the first MVP-bar step ("Add a Connection"). Full CRUD
 * over `/api/connections`. Secrets are write-only end to end — the list never
 * carries one, and the edit form leaves the secret field blank (blank = keep
 * the existing secret; typing a value rotates it).
 */
export function ConnectionsPage() {
  const [confirm, confirmDialog] = useConfirm();
  const [connections, setConnections] = useState<ConnectionPublic[] | null>(null);
  // #1470 — a removed row hands focus to its neighbour's ⋯, else to this.
  const createRef = useRef<HTMLButtonElement>(null);
  const { restoreFocus: removalFocus, removing: removingRow } = useFocusAfterRemoval(
    connections,
    createRef,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const {
    form,
    setForm,
    openForm,
    seq: formSeq,
    guard,
    openerRef,
    closeWhere,
    ...drawer
  } = useDrawerForm(savePayloadSignature);
  /**
   * #1477 — "New connection" opens the kind gallery first, as ADF's "New
   * linked service" does; picking a kind opens that kind's form. Only while no
   * form is open: every way a form opens clears it, and opening it closes the
   * form (through the guard, via `openFrom`).
   */
  const [choosingKind, setChoosingKind] = useState(false);
  // Each press of New is a fresh gallery (empty search, focus in it), even
  // when one is already open.
  const [gallerySeq, setGallerySeq] = useState(0);
  const drawerOpen = form !== null || choosingKind;
  /**
   * #1174 — the datasets bound to the connection being edited, and whether that
   * question could be answered at all.
   *
   * THREE STATES, NOT TWO. `null` with no error is "not read yet"; a non-null
   * `datasetsUnavailable` is "could not read"; a list is a list. An empty list
   * and a failed read must stay distinguishable, because collapsing them would
   * render "nothing would be stranded" on the strength of a fetch that failed
   * (prevention-log #18 — the healthy verdict is earned, never the fallback).
   * `strandedDatasets.ts` is total over the three.
   */
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [datasetsUnavailable, setDatasetsUnavailable] = useState<string | null>(null);
  /**
   * #1211 — the enabled TRIGGERS a kind change or a delete would switch off,
   * and whether that question could be answered at all. Same three states and
   * the same reason as the datasets pair above, kept as a separate pair rather
   * than folded in with them: the two are read from different routes and either
   * can fail alone, and a shared "unavailable" would silence the advisory that
   * did succeed.
   */
  const [dependents, setDependents] = useState<ConnectionDependentsResponse | null>(null);
  const [dependentsUnavailable, setDependentsUnavailable] = useState<string | null>(null);
  const guardedLoad = useGuardedLoad();
  /**
   * A SECOND instance, deliberately — `useGuardedLoad`'s "one instance per state
   * target" rule. Two fetchers sharing one instance discard each other's
   * answers, so the connections load and this one cannot be pointed at the same
   * runner.
   *
   * Note this is the opposite call from `DatasetsPage.tsx`, which loads the very
   * same PAIR through ONE fetcher and says why: its store picker resolves
   * dataset rows against connection rows, so a list from a different moment
   * would mis-render. Here the two are not resolved against each other on the
   * critical surface — the connections table stands alone, and the datasets list
   * feeds a DIAGNOSTIC. One fetcher would mean a datasets outage takes the
   * connections list down with it, so the page whose job is connections would
   * show an error banner because an advisory failed. The third state below
   * exists exactly so that failure stays local.
   */
  const datasetsLoad = useGuardedLoad();
  /**
   * A THIRD instance, for the same "one instance per state target" reason: this
   * load and the datasets load write different state, so sharing a runner would
   * make each discard the other's answer. #1211.
   */
  const dependentsLoad = useGuardedLoad();

  // The ONE load path: the mount effect below and every post-mutation refetch
  // (delete / save / import) go through it. That is what ORDERS them — #1062:
  // the New connection button is not gated behind the list having arrived, so a
  // create could complete while the initial load was still in flight, and the
  // mount load would then land second and write the list as it was before the
  // connection existed. `useGuardedLoad` drops the superseded answer; it also
  // owns the AbortController that used to live in this effect, and declines to
  // start a refresh at all once the page has unmounted.
  //
  // Failures are caught here rather than by the caller: a refresh failure after
  // e.g. a create — where the form has already closed — still has to reach
  // `loadError` instead of being swallowed by the gone form's handler. The
  // message is the bare `err.message` this page has always shown.
  const refresh = useCallback(
    () =>
      guardedLoad(listConnections, {
        onData: (list) => {
          setConnections(list);
          setLoadError(null);
        },
        onError: (err) => setLoadError(err instanceof Error ? err.message : String(err)),
      }),
    [guardedLoad],
  );

  // `refresh` is stable (so is the runner it closes over), so this is the
  // initial load and nothing more.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * #1174 — read the datasets, for the strand advisory only.
   *
   * ON EDIT-FORM OPEN, NOT ON MOUNT, and that is the whole staleness argument.
   * A mount load would be read hours later by an operator who left the tab open
   * and added datasets elsewhere, and would then answer "nothing would be
   * stranded" from a snapshot that predates them — the manufactured-benign-
   * default this page's three states exist to refuse, reached by a slower route.
   * Bound to the gesture instead: the reading is at most as old as the form.
   * It also costs a read-only visit nothing, which a mount load would not.
   *
   * NOT for the New-connection form: a connection that does not exist yet has
   * no `connectionId` for any dataset to name.
   */
  const refreshDatasets = useCallback(
    () =>
      datasetsLoad(listDatasets, {
        onData: (list) => {
          setDatasets(list);
          setDatasetsUnavailable(null);
        },
        // Local to the advisory. This never reaches `loadError` — a diagnostic
        // that could not be computed must not present as a failure of the page.
        onError: (err) => {
          setDatasets(null);
          setDatasetsUnavailable(messageOf(err));
        },
      }),
    [datasetsLoad],
  );

  /**
   * #1211 — read the triggers this connection's version-bound dependents would
   * lose, on EDIT-FORM OPEN for exactly the staleness reason `refreshDatasets`
   * documents above: bound to the gesture, so the reading is at most as old as
   * the form. Not on mount, and not for the New-connection form (nothing can
   * depend on a row that does not exist yet).
   */
  const refreshDependents = useCallback(
    (connectionId: string) =>
      dependentsLoad((signal) => listConnectionDependents(connectionId, signal), {
        onData: (result) => {
          setDependents(result);
          setDependentsUnavailable(null);
        },
        // Local to the advisory, exactly like the datasets read — a diagnostic
        // that could not be computed must not present as a failure of the page.
        onError: (err) => {
          setDependents(null);
          setDependentsUnavailable(messageOf(err));
        },
      }),
    [dependentsLoad],
  );

  const openEditForm = useCallback(
    (conn: ConnectionPublic) => {
      setDatasets(null);
      setDatasetsUnavailable(null);
      setDependents(null);
      setDependentsUnavailable(null);
      setChoosingKind(false);
      openForm(formForEdit(conn));
      void refreshDatasets();
      void refreshDependents(conn.id);
    },
    [openForm, refreshDatasets, refreshDependents],
  );

  /**
   * Save the connection's export envelope to disk (#959). The fetch happens
   * first and its failure is REPORTED — a bare `<a download>` would have
   * written a 404 body to the operator's disk as a `.json` file with nothing
   * said (see `api/download.ts`).
   *
   * SECURITY: the envelope carries NO secret material. The export route ships
   * `requiresSecret: secretRef !== null` — a boolean, never the ciphertext —
   * and an import turns that boolean into the `requiresSecret` attention item
   * the panel below renders. That is the server's guarantee, not this page's.
   */
  /* #960 — per-row single-flight. Since #1397 Export is an item in the row's
     menu, which shows it disabled while that row's export is in flight; the
     guard still refuses a second start, whatever asks. */
  const { active: exporting, run: runExport } = useBusyAction();

  const onExport = useCallback(
    (conn: ConnectionPublic) =>
      runExport(conn.id, async () => {
        setLoadError(null);
        try {
          downloadTextFile(
            exportFileName('connection', conn.name, conn.id),
            await exportConnection(conn.id),
          );
        } catch (err) {
          setLoadError(`Could not export “${conn.name}”: ${messageOf(err)}`);
        }
      }),
    [runExport],
  );

  /**
   * #1174 — the delete confirm names the datasets it would strand.
   *
   * A connection DELETE strands every dataset naming it, whatever their kinds:
   * `routes/connections.ts`'s delete re-gates dependent TRIGGERS and nothing
   * scans datasets, so the `connectionId` simply dangles.
   *
   * THE LIST IS FETCHED HERE, not read from `datasets` state, for two reasons.
   * Delete is reachable from the table without ever opening a form, so the state
   * may hold nothing (or another connection's reading). And this is the
   * irreversible act on the page — the one place worth paying a request to be
   * sure the count is current rather than as old as the last form open. Awaiting
   * the page's guarded load would not do it either: that load resolves the same
   * way whether it wrote, was superseded, or was skipped, and React state is not
   * readable in this closure afterwards regardless.
   *
   * A FAILED READ DOES NOT BLOCK THE DELETE and does not claim there is nothing
   * to strand — the confirm says the check could not be made and lets the
   * operator decide, which is the advisory polarity #1145/#1158 set.
   */
  /**
   * Re-entrancy guard for the delete path, which #1174 made necessary.
   *
   * The old `window.confirm` BLOCKED the main thread, so while it was the FIRST
   * statement of this handler a second click could not even be dispatched — the
   * old code was accidentally immune to a double-click. Reading the dataset list
   * first puts a real round trip in front of the dialog, and the dialog itself
   * (#1397) no longer blocks anything: a double-click queues two handlers, the
   * second raises a second confirm for a connection the first has already
   * deleted, and accepting it 404s into `loadError` — an error banner over an
   * operation that in fact succeeded. The guard spans the dialog too, so the
   * row stays held while its question is open.
   *
   * The guard itself now lives in `useBusyAction`, which was extracted from this
   * handler in #960 and carries both of its arguments — the ref (read and
   * written SYNCHRONOUSLY inside one handler, before any await, because a
   * `useState` flag would not have re-rendered by the time the second click's
   * handler runs) and the per-id keying (the race is one ROW being deleted
   * twice, not the page being used twice).
   *
   * Delete deliberately gains no `disabled` affordance here: its dialog is the
   * feedback, and the guard's whole purpose is to suppress the SECOND dialog.
   */
  const { run: runDelete } = useBusyAction();

  const onDelete = useCallback(
    (conn: ConnectionPublic, origin: RowMenuOrigin) =>
      runDelete(conn.id, async () => {
        /**
         * #1211 — TWO reads now, CONCURRENTLY and independently failable. The
         * datasets list and the dependent triggers come from different routes,
         * and `allSettled` is what keeps a failure of one from erasing the
         * other's answer: each folds into its OWN three-state check, so a
         * datasets outage still lets the dialog name the triggers it is about
         * to switch off. Sequential awaits would also have doubled the dead
         * time in front of a dialog that already waits for a round trip.
         *
         * The delete path fetches fresh rather than reading the form-open
         * state above, for the reason #1174 gives: Delete is reachable from the
         * row without any form ever having been opened.
         */
        const [datasetsResult, dependentsResult] = await Promise.allSettled([
          listDatasets(),
          listConnectionDependents(conn.id),
        ]);
        const check: StrandCheck =
          datasetsResult.status === 'fulfilled'
            ? {
                state: 'known',
                names: datasetsOnConnection(datasetsResult.value, conn.id).map((d) => d.name),
              }
            : { state: 'unavailable', detail: messageOf(datasetsResult.reason) };
        const triggerCheck: TriggerCheck =
          dependentsResult.status === 'fulfilled'
            ? {
                state: 'known',
                names: dependentsResult.value.triggers.map((t) => t.name),
                dynamicNames: dependentsResult.value.dynamic.map((t) => t.name),
              }
            : { state: 'unavailable', detail: messageOf(dependentsResult.reason) };

        // #1252 — the nodes naming it break too, whether or not a trigger is
        // bound to them. Same read, so the same failure detail.
        const nodeClause = deleteConfirmNodeClause(
          dependentsResult.status === 'fulfilled'
            ? nodeCheckOf(dependentsResult.value, null)
            : nodeCheckOf(null, messageOf(dependentsResult.reason)),
        );
        const message = [
          deleteConfirmMessage(conn.name, check),
          deleteConfirmTriggerClause(triggerCheck),
          nodeClause,
        ]
          .filter((part) => part !== '')
          .join('\n\n');
        // Typing the name is asked for only when a check that SUCCEEDED named
        // something depending on it — a dynamic reference that can resolve to
        // it included, since the message names those too. A check that failed
        // stays advisory (#1145/#1158): the message says so, and an outage adds
        // no friction to the delete.
        const hasDependants =
          (check.state === 'known' && check.names.length > 0) ||
          (triggerCheck.state === 'known' &&
            triggerCheck.names.length + triggerCheck.dynamicNames.length > 0) ||
          (dependentsResult.status === 'fulfilled' &&
            dependentsResult.value.nodes.length + dependentsResult.value.dynamicNodes.length > 0);
        const confirmed = await confirm({
          message,
          confirmLabel: 'Delete',
          ...(hasDependants ? { typeToConfirm: conn.name } : {}),
          // The menu item that asked unmounted while the reads above ran.
          restoreFocus: removalFocus(origin),
        });
        if (!confirmed) return;
        const forget = removingRow(conn.id, origin);
        try {
          await deleteConnection(conn.id);
          closeWhere((open) => open.id === conn.id);
          await refresh();
        } catch (err) {
          forget();
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }),
    [removalFocus, removingRow, confirm, runDelete, refresh, closeWhere],
  );

  return (
    <section aria-labelledby="connections-heading">
      <div className="page-header">
        <h2 id="connections-heading">Connections</h2>
        <button
          ref={createRef}
          type="button"
          onClick={(e) =>
            drawer.openFrom(e.currentTarget, () => {
              setForm(null);
              setChoosingKind(true);
              setGallerySeq((n) => n + 1);
            })
          }
        >
          New connection
        </button>
      </div>

      <p className="page-hint">
        A connection is a worker: an LLM API key, a local model, an agent CLI, or an HTTP endpoint.
        Pipelines reference connections; secrets are stored encrypted and never shown again.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {/* #1396 — the list and the form side by side; the form is a column, not
          an overlay, so the row actions stay reachable while it is open. */}
      {guard.routeHold}
      <div className={drawerOpen ? 'drawer-layout-open' : undefined}>
        <div>
          {connections === null && !loadError && <p>Loading connections…</p>}

          {connections !== null && connections.length === 0 && (
            <p>No connections yet. Add one to give your pipelines something to run against.</p>
          )}

          {connections !== null && connections.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((conn) => (
                  <tr key={conn.id}>
                    <td>{conn.name}</td>
                    <td>
                      <ConnectionKindName kind={conn.kind} />
                    </td>
                    <td>
                      {/* #1397 — Edit is the row's one inline action; the rest
                          are in its menu, Delete last. */}
                      <div className="row-actions">
                        <button
                          type="button"
                          onClick={(e) =>
                            drawer.openFrom(e.currentTarget, () => openEditForm(conn))
                          }
                          aria-label={`Edit ${conn.name}`}
                        >
                          Edit
                        </button>
                        <RowMoreMenu
                          name={conn.name}
                          actions={[
                            {
                              label: 'Export',
                              onSelect: () => void onExport(conn),
                              disabled: exporting.has(conn.id),
                            },
                          ]}
                          destructive={{
                            label: 'Delete',
                            onSelect: (origin) => void onDelete(conn, origin),
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {choosingKind && form === null && (
          <ConnectionKindDrawer
            key={gallerySeq}
            returnFocusTo={openerRef}
            onClose={() => setChoosingKind(false)}
            onPick={(kind) => {
              setChoosingKind(false);
              openForm(blankForm(kind));
            }}
          />
        )}

        {form && (
          <ConnectionForm
            /* Remount on every OPEN. The table stays interactive while the form
             is open, so "Edit" on another row swaps `form` in place — and
             without a key the child keeps its own local state across that swap:
             connection A's `probing`/`error`, and A's probe verdict, rendered
             against B. The verdict is the sharp one, because a signature over
             the DRAFT cannot see the switch: two connections sharing non-secret
             config (a staging/prod pair, or an export/import clone) produce an
             identical signature, so A's "Connected." would render for a B that
             was never probed.

             Keyed on the open COUNTER rather than on `form.id`, because `id` is
             `null` for every new-connection form and `blankForm(kind)` is
             byte-identical each time, so the signature would match and the
             previous draft's verdict would render against a form nothing has
             tested. (#1477's kind gallery now unmounts the form between two
             New presses; the counter is what still covers Edit → Edit.) */
            key={formSeq}
            form={form}
            /* #1174 — the inputs the strand note needs, read from the LIST rather
             than snapshotted at form-open, so a refreshed list moves them;
             `undefined` means the row is gone from under the open form, which
             the save's own 404 reports and the note deliberately stays silent
             about (there is no stored kind left for an edit to have changed
             FROM).

             #1211 widened this from `storedKind` to the whole row: the trigger
             note's readiness predicate runs the SERVER's own
             `connectionNotReadyReason`, which reads `enabled` and
             `secretStatus` as well as the kind. One prop rather than three,
             with the same "from the list" semantics. */
            stored={connections?.find((conn) => conn.id === form.id)}
            datasets={datasets}
            datasetsUnavailable={datasetsUnavailable}
            dependents={dependents}
            dependentsUnavailable={dependentsUnavailable}
            onChange={setForm}
            guard={guard}
            returnFocusTo={openerRef}
            onClose={drawer.requestClose}
            onSaved={async () => {
              drawer.closeIfLatest(formSeq);
              await refresh();
            }}
          />
        )}
      </div>

      {/* The import surface lives on the list an imported connection lands in —
          but it takes ANY export envelope, because `POST /api/import` does (see
          `ImportPanel`). A pipeline or trigger file is imported and then
          reported with a pointer to its own section, rather than refused by a
          client-side rule the server does not have. */}
      <ImportPanel listKind="connection" onImported={refresh} />
      {confirmDialog}
    </section>
  );
}
