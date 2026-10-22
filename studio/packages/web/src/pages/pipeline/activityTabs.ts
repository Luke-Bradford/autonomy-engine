import {
  ACTIVITY_TAB_TITLES,
  applicableBindingSlots,
  type ActivityBindingSlot,
  type ActivityCatalogEntry,
  type ActivityTabKey,
} from '@autonomy-studio/shared';
import {
  emptyControlValue,
  sameControlValue,
  type ConfigField,
  type FieldInput,
} from './configForm';

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
 *  - a listed name the schema does not have, a binding the entry cannot
 *    have, and a second listing of either, are dropped;
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
  const slotted = new Set<ActivityBindingSlot>();
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
      bindings: (tab.bindings ?? []).filter((slot) => {
        if (!slots.includes(slot) || slotted.has(slot)) return false;
        slotted.add(slot);
        return true;
      }),
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

/**
 * #1686 — which of a tab's fields the dock draws, by the entry's `appliesWhen`.
 *
 * A field applies when any of its conditions holds on the CONTROL's value: the
 * draft's, or the schema default while the control is empty. A `${}` there is
 * decided at dispatch, so the field is drawn, as it is when the control has no
 * value at all (the shared suite pins every control to an enum or boolean field, so that
 * is a malformed rule rather than a state). A field that does not apply is
 * still drawn while it holds a value, stored or typed, so the author can see and
 * clear what the schema will refuse: nothing in the JSON is unreachable from the
 * form (UI STANDARD rule 3). `fields` is every field of the node, because a
 * control can sit on another tab.
 */
export function applicableFieldNames(
  entry: Pick<ActivityCatalogEntry, 'appliesWhen'> | undefined,
  names: readonly string[],
  fields: readonly ConfigField[],
  inputs: Readonly<Record<string, FieldInput>>,
  stored: Readonly<Record<string, unknown>>,
  // #1600 OR41 C8c — the bound connection's kind; `undefined` while unknown
  // (none bound, or a `${}`), when a kind condition applies, as an unknown
  // value does.
  connectionKind?: string,
): string[] {
  const rules = entry?.appliesWhen;
  if (rules === undefined) return [...names];
  const byName = new Map(fields.map((f) => [f.name, f]));
  const valueOf = (name: string): string | undefined => {
    const input = inputs[name];
    // A set with nothing ticked is known to hold none, not unknown.
    if (byName.get(name)?.kind === 'enumSet') return typeof input === 'string' ? input : undefined;
    // #1600 OR41 C9a — a checkbox holds a boolean, read as a condition's 'true'/'false'.
    if (typeof input === 'boolean') return String(input);
    if (typeof input === 'string' && input !== '') return input;
    return byName.get(name)?.defaultText;
  };
  const holds = (name: string): boolean => {
    if (stored[name] !== undefined) return true;
    const field = byName.get(name);
    const input = inputs[name];
    return (
      field !== undefined &&
      input !== undefined &&
      !sameControlValue(input, emptyControlValue(field))
    );
  };
  return names.filter((name) => {
    const conditions = rules[name];
    if (conditions === undefined || holds(name)) return true;
    return conditions.some((c) => {
      if ('connectionKind' in c) {
        return (
          connectionKind === undefined ||
          (c.connectionKind as readonly string[]).includes(connectionKind)
        );
      }
      // #1600 OR41 C3b — the control holds a value, stored or typed.
      if ('set' in c) return holds(c.field);
      const value = valueOf(c.field);
      // #1600 OR41 C8a — a set of choices holds its ticks one per line, and
      // applies when any is one of `in`; a single choice is the one-line case.
      return (
        value === undefined ||
        value.includes('${') ||
        value.split('\n').some((v) => c.in.includes(v))
      );
    });
  });
}

/**
 * #1600 OR41 C8c — the choices an enum or enum-set field offers on the bound
 * connection's kind (`ActivityCatalogEntry.fieldOptionsByConnectionKind`):
 * that kind's own, plus any already ticked, so a stored value is never hidden
 * (UI STANDARD rule 3) and a click never drops it. `undefined` means every choice: no rule, or the
 * kind is unknown.
 */
export function offeredFieldOptions(
  entry: Pick<ActivityCatalogEntry, 'fieldOptionsByConnectionKind'> | undefined,
  field: Pick<ConfigField, 'name' | 'enumOptions'>,
  connectionKind: string | undefined,
  input: FieldInput | undefined,
): readonly string[] | undefined {
  const byKind = entry?.fieldOptionsByConnectionKind?.[field.name];
  if (byKind === undefined || connectionKind === undefined) return undefined;
  const own: readonly string[] | undefined = (
    byKind as Readonly<Record<string, readonly string[] | undefined>>
  )[connectionKind];
  if (own === undefined) return undefined;
  const ticked = new Set(typeof input === 'string' ? input.split('\n') : []);
  return (field.enumOptions ?? []).filter((o) => own.includes(o) || ticked.has(o));
}

/**
 * #1600 OR41 C12b — the dock's schema pre-check, less the issue of a field the
 * panel does not draw: one that `appliesWhen` hides for the config's current
 * choices and that is absent. A Set variable's Variable is required, so a Set
 * marks it; a Pipeline return value has none, and is not refused for it. The
 * pre-check is never the gate — the save rules judge both.
 */
export function issuesOfShownFields<I extends { path: readonly PropertyKey[] }>(
  entry: Pick<ActivityCatalogEntry, 'appliesWhen'> | undefined,
  fields: readonly ConfigField[],
  candidate: Readonly<Record<string, unknown>>,
  issues: readonly I[],
): I[] {
  const inputs: Record<string, FieldInput> = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (typeof v === 'string' || typeof v === 'boolean') inputs[k] = v;
  }
  return issues.filter((issue) => {
    const [name] = issue.path;
    if (issue.path.length !== 1 || typeof name !== 'string' || candidate[name] !== undefined) {
      return true;
    }
    return applicableFieldNames(entry, [name], fields, inputs, candidate).length > 0;
  });
}

/**
 * #1600 OR41 C12b — the fields the panel does not draw for the current choices
 * (`applicableFieldNames` hides them, and they hold nothing). Apply leaves them
 * out of the config it writes: an empty control the author cannot see must not
 * become a value, as a hidden required text box would become `""` (a Pipeline
 * return value's Variable, which its save rules refuse).
 */
export function undrawnFieldNames(
  entry: Pick<ActivityCatalogEntry, 'appliesWhen'> | undefined,
  fields: readonly ConfigField[],
  inputs: Readonly<Record<string, FieldInput>>,
  stored: Readonly<Record<string, unknown>>,
  connectionKind?: string,
): string[] {
  const names = fields.map((f) => f.name);
  const shown = new Set(applicableFieldNames(entry, names, fields, inputs, stored, connectionKind));
  return names.filter((n) => !shown.has(n));
}
