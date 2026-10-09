import {
  ACTIVITY_TAB_TITLES,
  type ContainerConfigField,
  type ContainerKind,
} from '@autonomy-studio/shared';

/** A container property tab: its label and the fields on it, in order. */
export interface ContainerTab<F extends string = string> {
  key: string;
  label: string;
  fields: readonly F[];
}

const SETTINGS: ContainerTab<ContainerConfigField> = {
  key: 'settings',
  label: ACTIVITY_TAB_TITLES.settings,
  fields: ['join'],
};

/**
 * #1477 OR29 — a container's properties as tabs, ADF's split for ForEach and
 * Until: what to iterate or when to stop first, then how many at once, then the
 * rarely-set rest. `join` is on Settings: it says when the box starts, which
 * ADF has no field for.
 */
const TABLE: Record<ContainerKind, readonly ContainerTab<ContainerConfigField>[]> = {
  foreach: [
    { key: 'items', label: 'Items', fields: ['items'] },
    {
      key: 'concurrency',
      label: 'Concurrency',
      fields: ['batchCount', 'allowNondeterministicVars'],
    },
    SETTINGS,
  ],
  loop: [
    { key: 'condition', label: 'Condition', fields: ['exitWhen', 'maxRounds', 'timeout'] },
    SETTINGS,
  ],
  stage: [SETTINGS],
};

/**
 * The tabs for `shown`, the fields this kind's form offers. A shown field the
 * table does not place goes on the LAST tab, so a field added to
 * `CONTAINER_CONFIG_FIELDS` without a row here is still editable rather than
 * silently missing. A tab with none of its fields shown is dropped.
 */
export function containerTabs(kind: ContainerKind, shown: readonly string[]): ContainerTab[] {
  const table = TABLE[kind];
  const placed = new Set<string>(table.flatMap((t) => t.fields));
  const unplaced = shown.filter((name) => !placed.has(name));
  return table
    .map((t, i) => ({
      key: t.key,
      label: t.label,
      fields: [
        ...t.fields.filter((name) => shown.includes(name)),
        ...(i === table.length - 1 ? unplaced : []),
      ],
    }))
    .filter((t) => t.fields.length > 0);
}
