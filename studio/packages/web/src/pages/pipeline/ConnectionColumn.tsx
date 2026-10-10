import { useEffect, useState, type RefObject } from 'react';
import { CONNECTION_KIND_LABELS, type ConnectionPublic } from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { listConnections } from '../../api/connections';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';
import { ConnectionKindDrawer } from '../../lib/ConnectionKindGallery';
import { DrawerShell } from '../../lib/form/DrawerShell';
import { useDrawerForm } from '../../lib/form/useDrawerForm';
import { ConnectionForm } from '../connections/ConnectionForm';
import {
  blankForm,
  detectedForm,
  formForEdit,
  savePayloadSignature,
} from '../connections/connectionFormState';
import { useConnectionAdvisories } from '../connections/useConnectionAdvisories';
import type { ConnectionColumnRequest } from './connectionColumnRequest';

/**
 * #1477 OR29 slice 5 — an activity's ＋ New connection (5b) or Edit (5c), in a
 * column beside the editor (as the Triggers column, #1476), so nothing
 * navigates away and the canvas draft is untouched.
 *
 * NEW: the same two pieces as Manage → Connections → New connection: the kind
 * gallery first, with the kinds this slot refuses shown disabled and why, then
 * that kind's `ConnectionForm`. Create binds the new row to the slot that asked.
 * The form keeps its Kind select after a pick, as on the Connections page, so
 * a draft can be switched to a kind the slot refuses. Create still saves it —
 * the connection is valid on its own — but it is NOT bound: a binding the
 * dispatch would refuse is not offered by the picker, and must not be written
 * behind its back either. The editor is told why instead (`onNotice`).
 *
 * EDIT: the connection is READ AGAIN when the column opens, not taken from the
 * editor's list. That list is read once when the editor mounts, and the save
 * writes the whole row, so a form prefilled from it hours later would write
 * the old values over a change made elsewhere — and the kind-change advisories
 * would compare against a stale kind. The fresh list goes back to the editor
 * (`onListed`), and the advisories are read for this connection then, as
 * Manage → Connections reads them on its edit form's open
 * (`useConnectionAdvisories`). The advisories know saved pipeline versions only,
 * not this editor's draft, so a save that moves the kind to one this slot
 * refuses says so here (`onNotice`); the binding itself is left alone.
 *
 * Like the Triggers column, its guard holds no route (`holdRoute: false`): the
 * editor already holds leaving its path, the router consults one blocker, so
 * `dirty` is reported up and folded into the editor's guard. Cancel, ✕ and
 * Escape on a dirty form still ask through this guard's own prompt.
 */
export function ConnectionColumn({
  request,
  connections,
  returnFocusTo,
  onClose,
  onListed,
  onSaved,
  onNotice,
  onDirtyChange,
}: {
  request: ConnectionColumnRequest;
  /** The editor's connection list: an edit form's stored row is read from it. */
  connections: readonly ConnectionPublic[];
  /** The picker button that asked: focus goes back to it when the column closes. */
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** A fresh read of every connection, taken when an Edit column opens. */
  onListed: (connections: ConnectionPublic[]) => void;
  /** The stored row, created or updated, for the editor's connection list. */
  onSaved: (connection: ConnectionPublic) => void;
  onNotice: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { form, setForm, openForm, seq, guard, dirty } = useDrawerForm(savePayloadSignature, {
    holdRoute: false,
  });
  const advisories = useConnectionAdvisories();
  const listLoad = useGuardedLoad();
  const [loadError, setLoadError] = useState<string | null>(null);
  const editId = request.mode === 'edit' ? request.connectionId : null;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  // Closing the column takes its draft with it, so it stops holding the editor.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // The column is keyed per ask, so this runs once for each Edit.
  const { loadFor } = advisories;
  useEffect(() => {
    if (editId === null) return;
    void listLoad(listConnections, {
      onData: (list) => {
        onListed(list);
        const row = list.find((c) => c.id === editId);
        if (row === undefined) {
          onNotice('That connection no longer exists.');
          onClose();
          return;
        }
        openForm(formForEdit(row));
        loadFor(row.id);
      },
      onError: (err) => setLoadError(messageOf(err)),
    });
    // Once per ask: the handlers above are the editor's, and a re-render that
    // hands down new closures must not read the connection again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);

  const title = request.mode === 'edit' ? 'Edit connection' : 'New connection';
  return (
    <section className="pipeline-connection-column" aria-label={title}>
      {guard.routeHold}
      {form !== null ? (
        <ConnectionForm
          key={seq}
          form={form}
          // From the editor's list, which `onListed` has just refreshed, so an
          // update the column saves moves it too. A New form has no stored row,
          // and every dependents advisory returns early for it (`form.id === null`).
          stored={editId === null ? undefined : connections.find((c) => c.id === editId)}
          datasets={advisories.datasets}
          datasetsUnavailable={advisories.datasetsUnavailable}
          dependents={advisories.dependents}
          dependentsUnavailable={advisories.dependentsUnavailable}
          onChange={setForm}
          guard={guard}
          returnFocusTo={returnFocusTo}
          onClose={() => guard.request(onClose)}
          onSaved={(saved) => {
            onSaved(saved);
            const refused = request.disabledReason(saved.kind);
            const label = `${saved.name} (${CONNECTION_KIND_LABELS[saved.kind]})`;
            if (request.mode === 'edit') {
              if (refused !== undefined)
                onNotice(`Saved ${label}. ${refused}, so runs will refuse it here.`);
            } else if (refused !== undefined) {
              onNotice(`Created ${label}, not bound here. ${refused}.`);
            } else if (!request.bind(saved.id)) {
              onNotice(`Created ${label}, not bound: the activity was deleted.`);
            }
            // Unmounting the column reports it clean (the effect above).
            onClose();
          }}
        />
      ) : request.mode === 'new' ? (
        <ConnectionKindDrawer
          returnFocusTo={returnFocusTo}
          disabledReason={request.disabledReason}
          onClose={onClose}
          onPick={(kind) => openForm(blankForm(kind))}
          onDetect={(detected) => openForm(detectedForm(detected), blankForm(detected.kind))}
        />
      ) : (
        <DrawerShell
          title={title}
          onEscape={onClose}
          onClose={onClose}
          returnFocusTo={returnFocusTo}
        >
          <div className="form-drawer-body">
            {loadError === null ? (
              <p role="status">Loading the connection…</p>
            ) : (
              <p role="alert">Could not load the connection: {loadError}</p>
            )}
          </div>
        </DrawerShell>
      )}
    </section>
  );
}
