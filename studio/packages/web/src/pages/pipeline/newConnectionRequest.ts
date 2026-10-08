import type { ConnectionKindDisabledReason } from '../../lib/connectionKindGroups';

/**
 * #1477 OR29 slice 5b — what an activity's ＋ New connection asks the editor
 * for. The editor hosts the column (`NodePanel` remounts per node, which would
 * take a half-typed draft with it), so the request carries everything the slot
 * knows: which kinds it refuses and why, and how to bind the row once created.
 */
export interface NewConnectionRequest {
  /** Refused kinds, shown disabled in the gallery with the reason. */
  disabledReason: ConnectionKindDisabledReason;
  /**
   * Bind the created connection to the slot that asked. It closes over the
   * node's id and the canvas store, not the panel, so it binds the right node
   * even after the selection has moved.
   */
  bind: (connectionId: string) => void;
}
