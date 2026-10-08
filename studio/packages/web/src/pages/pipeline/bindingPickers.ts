import {
  CONNECTION_KIND_GROUPS,
  CONNECTION_KIND_LABELS,
  type ConnectionKind,
} from '@autonomy-studio/shared';
import type { ConnectionKindDisabledReason } from '../../lib/connectionKindGroups';
import { connectionOptionLabel } from '../../lib/resourceOptionLabel';

/**
 * #996 M5 slice 4c (#1139) — the one rule a resource picker on the node panel
 * filters by, extracted so the four pickers a `copy` node needs cannot each
 * carry their own version of it.
 *
 * The rule predates this file as a single inline `filter` for the singular
 * connection picker, and the data-movement spec (§3.1) cites that line as the
 * settled behaviour: the panel filters "to accepted kinds PLUS whatever is
 * currently bound, so a node bound to an off-kind dataset still shows its real
 * binding". Copying it four ways — with the dataset side taking a second axis
 * and an optional sink — is how the halves drift apart.
 *
 * The bound-id union is the whole point and is easy to mistake for laxity. A
 * doc can hold a binding this build would not offer: authored before an
 * allowlist narrowed, imported from a workspace with different resources, or
 * simply pointing at a row whose kind changed. Dropping it from the list makes
 * the select fall back to "— none —", which reads as "nothing is bound" while
 * the doc says otherwise — and the next save would silently write that lie.
 */

/**
 * The options a picker offers: everything `accept`s, plus whatever is bound now.
 *
 * `accept` rather than a kind list because the two callers ask different
 * questions — a connection is eligible on kind alone, a dataset on kind AND
 * agreeing with the connection bound to the same end (slice 4a refuses a
 * disagreeing pair at dispatch with `DATASET_CONNECTION_MISMATCH`, so offering
 * one is offering a binding that cannot run).
 */
export function eligibleForBinding<T extends { id: string }>(
  items: readonly T[],
  accept: (item: T) => boolean,
  boundId: string | undefined,
): T[] {
  return items.filter((item) => accept(item) || item.id === boundId);
}

/**
 * #1477 — which side of an activity a connection picker binds. `single` is the
 * one `connectionId` an unpaired activity (HTTP, LLM, Lookup) carries.
 */
export type ConnectionSlotSide = 'single' | 'source' | 'sink';

/**
 * #1477 — why a connection kind cannot be bound on this side of this activity,
 * or `undefined` when it can. ONE answer for both places that ask: the picker
 * lists a refused connection disabled with it, and the New connection gallery
 * shows a refused kind disabled with it, so the two never disagree about what
 * the slot takes.
 */
export function connectionSlotReason(
  accepted: readonly ConnectionKind[],
  title: string,
  side: ConnectionSlotSide,
): ConnectionKindDisabledReason {
  const reason =
    side === 'single' ? `${title} can't use this kind yet` : `Can't be a ${title} ${side} yet`;
  return (kind) => (accepted.includes(kind) ? undefined : reason);
}

export interface ConnectionPickerOption {
  id: string;
  label: string;
  /** Set when the option is listed but cannot be picked here. */
  disabledReason?: string;
}

export interface ConnectionPickerGroup {
  kind: ConnectionKind;
  label: string;
  options: ConnectionPickerOption[];
}

/**
 * #1477 — a connection picker's options, grouped by kind in the gallery's kind
 * order (`CONNECTION_KIND_GROUPS`), kinds with no connection dropped.
 *
 * EVERY connection is listed — the operator's rule: a kind this side refuses is
 * shown disabled with the reason, so the picker says what exists rather than
 * looking empty. The bound connection is never disabled, whatever its kind:
 * `eligibleForBinding`'s rule above, for the same reason.
 */
export function connectionPickerGroups(
  connections: readonly { id: string; name: string; kind: ConnectionKind }[],
  disabledReason: ConnectionKindDisabledReason,
  boundId: string | undefined,
): ConnectionPickerGroup[] {
  return CONNECTION_KIND_GROUPS.flatMap((group) => group.kinds)
    .map((kind) => {
      const reason = disabledReason(kind);
      return {
        kind,
        label: CONNECTION_KIND_LABELS[kind],
        options: connections
          .filter((c) => c.kind === kind)
          .map((c) =>
            reason === undefined || c.id === boundId
              ? { id: c.id, label: connectionOptionLabel(c) }
              : { id: c.id, label: connectionOptionLabel(c), disabledReason: reason },
          ),
      };
    })
    .filter((group) => group.options.length > 0);
}
