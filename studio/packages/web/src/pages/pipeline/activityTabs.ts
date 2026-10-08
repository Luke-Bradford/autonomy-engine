import {
  ACTIVITY_TAB_TITLES,
  applicableBindingSlots,
  type ActivityBindingSlot,
  type ActivityCatalogEntry,
  type ActivityTabKey,
} from '@autonomy-studio/shared';
import type { ConfigField } from './configForm';

/** #1477 OR29 — one of a node's type tabs, resolved against what the node can show. */
export interface NodeTypeTab {
  readonly key: ActivityTabKey;
  readonly label: string;
  /** The tab's fields, in the declared order. */
  readonly fields: readonly ConfigField[];
  readonly bindings: readonly ActivityBindingSlot[];
}

/**
 * #1477 OR29 — the type tabs a node's panel draws, after "General".
 *
 * The catalog entry declares them (`ActivityCatalogEntry.tabs`), and the shared
 * suite pins that declaration to the schema. This is the DEFENSIVE reading of
 * it all the same, because a field the panel does not draw is a setting the
 * author cannot see or change:
 *  - a derived field no tab lists goes on the LAST tab, never nowhere, and a
 *    binding the entry has that no tab places goes on the FIRST;
 *  - a listed name the schema does not have, or a binding the entry cannot
 *    have, is dropped;
 *  - a tab left with nothing to show is dropped.
 * An entry that declares no tabs, or a type the catalog does not know, gets one
 * Settings tab holding everything.
 */
export function nodeTypeTabs(
  entry: ActivityCatalogEntry | undefined,
  fields: readonly ConfigField[],
): [NodeTypeTab, ...NodeTypeTab[]] {
  const slots = entry ? applicableBindingSlots(entry) : [];
  const declared = entry?.tabs;
  if (declared === undefined) {
    return [{ key: 'settings', label: ACTIVITY_TAB_TITLES.settings, fields, bindings: slots }];
  }
  const byName = new Map(fields.map((f) => [f.name, f]));
  const placed = new Set<string>();
  const tabs = declared.map((tab) => {
    const own = tab.fields.flatMap((name) => {
      const field = byName.get(name);
      if (field === undefined || placed.has(name)) return [];
      placed.add(name);
      return [field];
    });
    return {
      key: tab.key,
      label: ACTIVITY_TAB_TITLES[tab.key],
      fields: own,
      bindings: (tab.bindings ?? []).filter((slot) => slots.includes(slot)),
    };
  });
  const unplaced = fields.filter((f) => !placed.has(f.name));
  const last = tabs[tabs.length - 1];
  if (unplaced.length > 0 && last !== undefined) {
    tabs[tabs.length - 1] = { ...last, fields: [...last.fields, ...unplaced] };
  }
  const placedSlots = new Set(tabs.flatMap((t) => t.bindings));
  const unbound = slots.filter((slot) => !placedSlots.has(slot));
  const first = tabs[0];
  if (unbound.length > 0 && first !== undefined) {
    tabs[0] = { ...first, bindings: [...unbound, ...first.bindings] };
  }
  const shown = tabs.filter((t) => t.fields.length > 0 || t.bindings.length > 0);
  const [head, ...rest] = shown;
  return head === undefined
    ? [{ key: 'settings', label: ACTIVITY_TAB_TITLES.settings, fields: [], bindings: [] }]
    : [head, ...rest];
}
