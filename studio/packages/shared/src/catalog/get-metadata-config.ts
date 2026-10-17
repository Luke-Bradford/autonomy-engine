import { z } from 'zod';
import { optionTitles, presented, singleLine } from '../schemas/field-presentation.js';
import { instant, modifiedWindowIssue, wildcardIssue } from './file-selection.js';

/**
 * #1600 OR41 C8a — Get metadata's config (catalogue §4.3), the SINGLE SOURCE OF
 * TRUTH read by the catalog entry and the `fs` adapter's dispatch arm, as the
 * `file_*` shapes in `fs-activity-config.ts` are.
 *
 * C8a is the file system half. The field names are ADF's
 * (https://learn.microsoft.com/azure/data-factory/control-flow-get-metadata-activity).
 * C8c adds the table fields (structure, column count, row count) for database
 * connections, and the options then depend on the connection's kind, which is
 * why this list is named for the file system.
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
export type GetMetadataField = (typeof GET_METADATA_FS_FIELDS)[number];

const fieldSchema = z.enum(GET_METADATA_FS_FIELDS);
const FIELD_TITLES = optionTitles(fieldSchema, {
  exists: 'Exists',
  itemName: 'Item name',
  itemType: 'Item type',
  size: 'Size',
  created: 'Created',
  lastModified: 'Last modified',
  contentMD5: 'Content MD5',
  childItems: 'Child items',
});

const childTypeSchema = z.enum(['all', 'files', 'folders']);

export const getMetadataConfigSchema = z
  .object({
    path: presented(singleLine(z.string()).min(1), {
      title: 'File or folder path',
      description: "Absolute, or relative to the connection's first allowed folder.",
    }),
    // An array of enum members, so a `${}` can never be one: the ticks decide
    // which outputs are filled, and stay literal as ADF's checkbox grid does.
    fieldList: presented(z.array(fieldSchema).min(1, 'tick at least one field'), {
      title: 'Field list',
      description:
        'Each ticked field fills the output of the same name; the rest are null. With Exists ticked, a missing path gives false instead of failing.',
      options: FIELD_TITLES,
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
        'Also lists what every subfolder holds, each named by its path below this folder, e.g. 2026/a.csv.',
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
      if (seen.has(field)) issue('fieldList', `${FIELD_TITLES[field]} is ticked twice`);
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
