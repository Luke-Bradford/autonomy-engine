import { z } from 'zod';
import { optionTitles, presented, singleLine } from '../schemas/field-presentation.js';
import { instant, modifiedWindowIssue, wildcardIssue } from './file-selection.js';

/**
 * #1600 OR41 C9a — Delete's config (catalogue §4.4), the SINGLE SOURCE OF TRUTH
 * read by the catalog entry and the `fs` adapter's dispatch arm.
 *
 * ADF's Delete (https://learn.microsoft.com/azure/data-factory/delete-activity)
 * names its files through a dataset; studio names them as Copy · Files as-is
 * names a source: a path, its type, and the folder-only wildcard and Include
 * subfolders. `recursive` and `maxConcurrentConnections` are ADF's names.
 */
const pathTypeSchema = z.enum(['file', 'folder']);
export type DeletePathType = z.infer<typeof pathTypeSchema>;

/** The most files one Delete removes at once. ADF sets no ceiling; 1 is its default. */
export const DELETE_MAX_CONCURRENT = 64;

const IN_ROOTS = "Absolute, or relative to the connection's first allowed folder.";

export const deleteConfigSchema = z
  .object({
    pathType: presented(pathTypeSchema.default('folder'), {
      title: 'Path type',
      description:
        'File deletes one file. Folder deletes the files in a folder that match the wildcard; the folder itself is kept.',
      options: optionTitles(pathTypeSchema, { file: 'File', folder: 'Folder' }),
    }),
    path: presented(singleLine(z.string()).min(1), {
      title: 'File or folder path',
      description: `The file to delete, or the folder to delete files from. ${IN_ROOTS}`,
    }),
    wildcard: presented(singleLine(z.string()).min(1).default('*'), {
      title: 'Wildcard',
      description:
        'Folder only. Deletes files whose name matches: * is any run of characters, ? is one character.',
    }),
    // Off by default, as ADF's `recursive`.
    recursive: presented(z.boolean().default(false), {
      title: 'Include subfolders',
      description:
        'Folder only. Also deletes matching files in every subfolder. The subfolders are kept unless Delete empty folders is on.',
    }),
    modifiedStart: instant(
      'Modified from',
      'Only files last modified at or after this UTC time, e.g. 2026-10-13T00:00:00Z.',
    ),
    modifiedEnd: instant('Modified before', 'Only files last modified before this UTC time.'),
    maxConcurrentConnections: presented(
      z.number().int().min(1).max(DELETE_MAX_CONCURRENT).default(1),
      {
        title: 'Max concurrent deletes',
        description: `How many files are deleted at once, 1 to ${DELETE_MAX_CONCURRENT}. ADF's Max concurrent connections, default 1.`,
      },
    ),
    failIfNothingMatched: presented(z.boolean().default(false), {
      title: 'Fail if nothing matched',
      description:
        'Fail, before deleting anything, when no file matches. A missing path matches nothing.',
    }),
    deleteEmptyFolders: presented(z.boolean().default(false), {
      title: 'Delete empty folders',
      description:
        'After the files, remove every subfolder left empty, ones empty already included. Never the folder at the path.',
    }),
  })
  .superRefine((cfg, ctx) => {
    // As in `copyFilesConfigSchema`: refuse a setting that would be ignored,
    // rather than quietly ignore it. A `${}` value is decided at dispatch.
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });
    const separator = wildcardIssue(cfg.wildcard);
    if (separator !== undefined) issue('wildcard', separator);
    if (cfg.pathType !== 'folder') {
      if (cfg.wildcard !== '*') issue('wildcard', 'only read when the path type is Folder');
      if (cfg.recursive) issue('recursive', 'only read when the path type is Folder');
    }
    if (cfg.deleteEmptyFolders && !cfg.recursive) {
      issue('deleteEmptyFolders', 'only read when Include subfolders is on');
    }
    const window = modifiedWindowIssue(cfg.modifiedStart, cfg.modifiedEnd);
    if (window !== undefined) issue('modifiedEnd', window);
  });

export type DeleteConfig = z.infer<typeof deleteConfigSchema>;
