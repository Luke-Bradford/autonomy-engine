import {
  CONNECTION_KIND_GROUPS,
  CONNECTION_KIND_LABELS,
  type ConnectionKind,
} from '@autonomy-studio/shared';

/**
 * #1477 — why a kind cannot be picked HERE (a Copy sink that cannot be a
 * file, say), or `undefined` when it can. The gallery shows such a kind,
 * disabled, with this reason: hiding it would make the list look like
 * everything studio supports when it is not.
 */
export type ConnectionKindDisabledReason = (kind: ConnectionKind) => string | undefined;

export interface ConnectionKindTile {
  kind: ConnectionKind;
  /** Set when the kind is shown but cannot be picked in this context. */
  disabledReason?: string;
}

export interface ConnectionKindGroup {
  key: string;
  label: string;
  tiles: ConnectionKindTile[];
}

/**
 * The gallery's groups for a search, in `CONNECTION_KIND_GROUPS` order, empty
 * groups dropped. The same matching rules as the activity toolbox
 * (`toolboxGroups`): trimmed, case-insensitive, on what is SHOWN (the label)
 * and what is STORED (the kind id), plus the group's label so "database"
 * lists the databases. Not on the descriptions: prose words ("file", "API")
 * would match kinds that are not that.
 */
export function connectionKindGroups(
  query: string,
  disabledReason?: ConnectionKindDisabledReason,
): ConnectionKindGroup[] {
  const needle = query.trim().toLowerCase();
  const groups: ConnectionKindGroup[] = [];
  for (const group of CONNECTION_KIND_GROUPS) {
    const groupMatches = needle !== '' && group.label.toLowerCase().includes(needle);
    const tiles = group.kinds
      .filter(
        (kind) =>
          needle === '' ||
          groupMatches ||
          CONNECTION_KIND_LABELS[kind].toLowerCase().includes(needle) ||
          kind.includes(needle),
      )
      .map((kind) => {
        const reason = disabledReason?.(kind);
        return reason === undefined ? { kind } : { kind, disabledReason: reason };
      });
    if (tiles.length > 0) groups.push({ key: group.key, label: group.label, tiles });
  }
  return groups;
}
