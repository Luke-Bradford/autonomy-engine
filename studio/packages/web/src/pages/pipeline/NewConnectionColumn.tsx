import { useEffect, type RefObject } from 'react';
import { CONNECTION_KIND_LABELS, type ConnectionPublic } from '@autonomy-studio/shared';
import { ConnectionKindDrawer } from '../../lib/ConnectionKindGallery';
import { useDrawerForm } from '../../lib/form/useDrawerForm';
import { ConnectionForm } from '../connections/ConnectionForm';
import { blankForm, savePayloadSignature } from '../connections/connectionFormState';
import type { NewConnectionRequest } from './newConnectionRequest';

/**
 * #1477 OR29 slice 5b — an activity's ＋ New connection, in a column beside the
 * editor (as the Triggers column, #1476), so nothing navigates away and the
 * canvas draft is untouched.
 *
 * The same two pieces as Manage → Connections → New connection: the kind
 * gallery first, with the kinds this slot refuses shown disabled and why, then
 * that kind's `ConnectionForm`. Create binds the new row to the slot that asked.
 *
 * The form keeps its Kind select after a pick, as on the Connections page, so
 * a draft can be switched to a kind the slot refuses. Create still saves it —
 * the connection is valid on its own — but it is NOT bound: a binding the
 * dispatch would refuse is not offered by the picker, and must not be written
 * behind its back either. The editor is told why instead (`onNotice`).
 *
 * Like the Triggers column, its guard holds no route (`holdRoute: false`): the
 * editor already holds leaving its path, the router consults one blocker, so
 * `dirty` is reported up and folded into the editor's guard. Cancel, ✕ and
 * Escape on a dirty form still ask through this guard's own prompt.
 */
export function NewConnectionColumn({
  request,
  returnFocusTo,
  onClose,
  onCreated,
  onNotice,
  onDirtyChange,
}: {
  request: NewConnectionRequest;
  /** The ＋ New button that asked: focus goes back to it when the column closes. */
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** The stored row, to add to the editor's connection list. */
  onCreated: (connection: ConnectionPublic) => void;
  onNotice: (message: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { form, setForm, openForm, seq, guard, dirty } = useDrawerForm(savePayloadSignature, {
    holdRoute: false,
  });

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  // Closing the column takes its draft with it, so it stops holding the editor.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  return (
    <aside className="pipeline-new-connection" aria-label="New connection">
      {guard.routeHold}
      {form === null ? (
        <ConnectionKindDrawer
          returnFocusTo={returnFocusTo}
          disabledReason={request.disabledReason}
          onClose={onClose}
          onPick={(kind) => openForm(blankForm(kind))}
        />
      ) : (
        <ConnectionForm
          key={seq}
          form={form}
          stored={undefined}
          // A connection that does not exist yet has nothing bound to it: every
          // dependents advisory returns early for a new form (`form.id === null`).
          datasets={null}
          datasetsUnavailable={null}
          dependents={null}
          dependentsUnavailable={null}
          onChange={setForm}
          guard={guard}
          returnFocusTo={returnFocusTo}
          onClose={() => guard.request(onClose)}
          onSaved={(saved) => {
            onCreated(saved);
            const refused = request.disabledReason(saved.kind);
            if (refused === undefined) request.bind(saved.id);
            else
              onNotice(
                `Created ${saved.name} (${CONNECTION_KIND_LABELS[saved.kind]}), not bound here. ${refused}.`,
              );
            // Unmounting the column reports it clean (the effect above).
            onClose();
          }}
        />
      )}
    </aside>
  );
}
