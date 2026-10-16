import {
  COPY_ACTIVITY_TYPE,
  COPY_FILES_ACTIVITY_TYPE,
  FILE_READ_ACTIVITY_TYPE,
  LOOKUP_ACTIVITY_TYPE,
  activityModeGroup,
} from '@autonomy-studio/shared';

/**
 * #1600 OR41 C7b — the dock's mode select for a palette item that stands for
 * several types (`ACTIVITY_MODE_GROUPS`): its label, its `?` note and each
 * type's option name, keyed by the group's first type. Copy's *Copy mode*
 * (C1a) and Lookup's *Read as* are one control, so they cannot drift.
 */
export interface ActivityModeSelect {
  label: string;
  note: string;
  options: Readonly<Record<string, string>>;
}

const SELECTS: Readonly<Record<string, ActivityModeSelect>> = {
  [COPY_ACTIVITY_TYPE]: {
    label: 'Copy mode',
    note: "Rows reads the data, maps its columns and converts their types. Files as-is copies files byte for byte, without reading them. Switching starts the other mode's settings fresh; Undo brings these back.",
    options: { [COPY_ACTIVITY_TYPE]: 'Rows', [COPY_FILES_ACTIVITY_TYPE]: 'Files as-is' },
  },
  [LOOKUP_ACTIVITY_TYPE]: {
    label: 'Read as',
    note: "Rows reads a dataset, table or query. Whole file as text reads one file on a file system connection into content. Switching starts the other mode's settings as a new Lookup has them; Undo brings these back.",
    options: { [LOOKUP_ACTIVITY_TYPE]: 'Rows', [FILE_READ_ACTIVITY_TYPE]: 'Whole file as text' },
  },
};

/** The mode select for `type`, with its group in option order, or `undefined` for a one-mode type. */
export function activityModeSelect(
  type: string,
): (ActivityModeSelect & { types: readonly string[] }) | undefined {
  const types = activityModeGroup(type);
  if (types === undefined) return undefined;
  const select = SELECTS[types[0]!];
  return select === undefined ? undefined : { ...select, types };
}

/**
 * An activity's name with its mode, where the type is not its palette item's
 * first mode: `Lookup (whole file as text)`. A message that names the activity
 * (a connection the slot refuses) then names the mode that refuses it, since a
 * Lookup in Rows mode takes the same connection.
 */
export function activityModeTitle(type: string, title: string): string {
  const select = activityModeSelect(type);
  if (select === undefined || select.types[0] === type) return title;
  const option = select.options[type];
  return option === undefined ? title : `${title} (${option.toLowerCase()})`;
}
