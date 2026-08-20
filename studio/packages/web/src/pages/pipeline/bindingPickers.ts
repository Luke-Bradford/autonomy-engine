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
