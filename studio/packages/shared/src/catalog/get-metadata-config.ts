import { z } from 'zod';
import { optionTitles, presented, singleLine } from '../schemas/field-presentation.js';
import { instant, modifiedWindowIssue, wildcardIssue } from './file-selection.js';

/**
 * #1600 OR41 C8a — Get metadata's config (catalogue §4.3), the SINGLE SOURCE OF
 * TRUTH read by the catalog entry and the adapters' dispatch arms, as the
 * `file_*` shapes in `fs-activity-config.ts` are.
 *
 * The field names are ADF's
 * (https://learn.microsoft.com/azure/data-factory/control-flow-get-metadata-activity).
 * C8a is the file system half; C8c adds a database table's fields. Which fields
 * a node may tick depends on its connection's kind
 * ({@link GET_METADATA_FIELDS_BY_CONNECTION_KIND}), which the config alone
 * cannot see, so the adapters refuse the rest at dispatch
 * ({@link getMetadataKindIssue}) and the editor offers only the kind's own.
 */
export const GET_METADATA_FS_FIELDS = [
  'exists',
  'itemName',
  'itemType',
  'size',
  'created',
  'lastModified',
  'contentMD5',
  'childItems',
] as const;
/**
 * C8c — a database table's fields. Row count is a studio addition; ADF offers
 * Exists, Structure and Column count for a table.
 */
export const GET_METADATA_TABLE_FIELDS = [
  'exists',
  'structure',
  'columnCount',
  'rowCount',
] as const;
/** Every field, in the order the tick boxes are drawn and the array is written. */
export const GET_METADATA_FIELDS = [
  ...GET_METADATA_FS_FIELDS,
  'structure',
  'columnCount',
  'rowCount',
] as const;
export type GetMetadataField = (typeof GET_METADATA_FIELDS)[number];

/** The fields each connection kind can answer (the catalog's field options). */
export const GET_METADATA_FIELDS_BY_CONNECTION_KIND = {
  fs: GET_METADATA_FS_FIELDS,
  sqlite: GET_METADATA_TABLE_FIELDS,
  postgres: GET_METADATA_TABLE_FIELDS,
} as const satisfies Record<string, readonly GetMetadataField[]>;
type GetMetadataConnectionKind = keyof typeof GET_METADATA_FIELDS_BY_CONNECTION_KIND;

const fieldSchema = z.enum(GET_METADATA_FIELDS);
export const GET_METADATA_FIELD_TITLES = optionTitles(fieldSchema, {
  exists: 'Exists',
  itemName: 'Item name',
  itemType: 'Item type',
  size: 'Size',
  created: 'Created',
  lastModified: 'Last modified',
  contentMD5: 'Content MD5',
  childItems: 'Child items',
  structure: 'Structure',
  columnCount: 'Column count',
  rowCount: 'Row count',
});

const childTypeSchema = z.enum(['all', 'files', 'folders']);

export const getMetadataConfigSchema = z
  .object({
    // C8c — optional, because a database table is chosen on the Source tab (a
    // saved table dataset or an inline Table), never by a path: one way to name
    // a table (C1q). A file system connection still needs it, refused at
    // dispatch by `getMetadataKindIssue`.
    path: presented(singleLine(z.string()).min(1).optional(), {
      title: 'File or folder path',
      description: "Absolute, or relative to the connection's first allowed folder.",
    }),
    // An array of enum members, so a `${}` can never be one: the ticks decide
    // which outputs are filled, and stay literal as ADF's checkbox grid does.
    fieldList: presented(z.array(fieldSchema).min(1, 'tick at least one field'), {
      title: 'Field list',
      description:
        'Each ticked field fills the output of the same name; the rest are null. With Exists ticked, a missing path gives false instead of failing.',
      options: GET_METADATA_FIELD_TITLES,
    }),
    childFilter: presented(singleLine(z.string()).min(1).default('*'), {
      title: 'Filter',
      description: 'Child items whose name matches this wildcard (* and ?).',
    }),
    childType: presented(childTypeSchema.default('all'), {
      title: 'Child entries',
      description: 'Which entries Child items lists. All includes links and other entries too.',
      options: optionTitles(childTypeSchema, {
        all: 'All',
        files: 'Files only',
        folders: 'Folders only',
      }),
    }),
    // C8e. Off by default: the lowered `file_list` (C8b) never recursed.
    recursive: presented(z.boolean().default(false), {
      title: 'Include subfolders',
      description:
        "Also lists every subfolder's contents, each named by its path, e.g. 2026/a.csv.",
    }),
    modifiedStart: instant(
      'Modified from',
      'Only files last modified at or after this UTC time. Folders are left out when set.',
    ),
    modifiedEnd: instant(
      'Modified before',
      'Only files last modified before this UTC time. Folders are left out when set.',
    ),
  })
  .superRefine((cfg, ctx) => {
    // As in `copyFilesConfigSchema`: refuse a setting that would be ignored,
    // rather than quietly ignore it.
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });
    const seen = new Set<string>();
    for (const field of cfg.fieldList) {
      if (seen.has(field))
        issue('fieldList', `${GET_METADATA_FIELD_TITLES[field]} is ticked twice`);
      seen.add(field);
    }
    if (!seen.has('childItems')) {
      if (cfg.childFilter !== '*') issue('childFilter', 'only read when Child items is ticked');
      if (cfg.childType !== 'all') issue('childType', 'only read when Child items is ticked');
      if (cfg.recursive) issue('recursive', 'only read when Child items is ticked');
      if (cfg.modifiedStart !== undefined) {
        issue('modifiedStart', 'only read when Child items is ticked');
      }
      if (cfg.modifiedEnd !== undefined)
        issue('modifiedEnd', 'only read when Child items is ticked');
    }
    const separator = wildcardIssue(cfg.childFilter);
    if (separator !== undefined) issue('childFilter', separator);
    const window = modifiedWindowIssue(cfg.modifiedStart, cfg.modifiedEnd);
    if (window !== undefined) issue('modifiedEnd', window);
  });
export type GetMetadataConfig = z.infer<typeof getMetadataConfigSchema>;

/**
 * #1736 — the field outputs a Get metadata config leaves null: every field its
 * Field list does not tick. The output contract stays fixed (a contract derived
 * from the ticks would go stale when they change), so the validator warns on a
 * read of one of these instead. `undefined` when the field list is not a list,
 * which the config check already reports.
 */
export function untickedGetMetadataFields(
  config: unknown,
): ReadonlySet<GetMetadataField> | undefined {
  const list =
    typeof config === 'object' && config !== null
      ? (config as { fieldList?: unknown }).fieldList
      : undefined;
  if (!Array.isArray(list)) return undefined;
  return new Set(GET_METADATA_FIELDS.filter((f) => !list.includes(f)));
}

/**
 * #1600 OR41 C8c — what a Get metadata config asks that its connection's kind
 * cannot answer, or `undefined` when nothing. The adapters refuse it at
 * dispatch (`permanent`); the config schema cannot, because it does not see the
 * connection. One sentence per store, so the file system and the two databases
 * say the same thing about the same mistake.
 */
export function getMetadataKindIssue(
  config: GetMetadataConfig,
  connectionKind: GetMetadataConnectionKind,
): string | undefined {
  const allowed: readonly GetMetadataField[] =
    GET_METADATA_FIELDS_BY_CONNECTION_KIND[connectionKind];
  const foreign = config.fieldList.filter((f) => !allowed.includes(f));
  if (connectionKind === 'fs') {
    if (config.path === undefined)
      return 'File or folder path is required on a file system connection';
    if (foreign.length > 0) {
      return `${titles(foreign)} read a database table, not a file system path`;
    }
    return undefined;
  }
  if (config.path !== undefined) {
    return 'a table is chosen on the Source tab; clear File or folder path';
  }
  if (foreign.length > 0) return `${titles(foreign)} read a file system path, not a table`;
  return undefined;
}

const titles = (fields: readonly GetMetadataField[]): string =>
  fields.map((f) => GET_METADATA_FIELD_TITLES[f]).join(', ');
