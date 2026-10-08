import type { ConnectionKindDisabledReason } from '../../lib/connectionKindGroups';

/**
 * #1477 OR29 slice 5 — what an activity's connection picker asks the editor's
 * connection column for: ＋ New (5b) or Edit (5c). The editor hosts the column
 * (`NodePanel` remounts per node, which would take a half-typed draft with
 * it), so the request carries everything the slot knows.
 */
export type ConnectionColumnRequest =
  | {
      mode: 'new';
      /** Refused kinds, shown disabled in the gallery with the reason. */
      disabledReason: ConnectionKindDisabledReason;
      /**
       * Bind the created connection to the slot that asked. It closes over the
       * node's id and the canvas store, not the panel, so it binds the right
       * node even after the selection has moved. `false` when the node is gone.
       */
      bind: (connectionId: string) => boolean;
    }
  | {
      mode: 'edit';
      /** The connection bound to the slot that asked. */
      connectionId: string;
      /**
       * The slot's refusals, so a save that changes the kind to one this slot
       * refuses says so: the binding stays, and the run will refuse it.
       */
      disabledReason: ConnectionKindDisabledReason;
    };
