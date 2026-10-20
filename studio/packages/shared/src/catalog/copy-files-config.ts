import { z } from 'zod';
import { optionTitles, presented, singleLine } from '../schemas/field-presentation.js';
import { instant, modifiedWindowIssue, wildcardIssue } from './file-selection.js';
import { sessionLogConfigFields } from './session-log.js';

/**
 * #1600 OR41 C1a — the config of Copy in **Files as-is** mode (activity
 * catalogue §4.1): bytes copied from one `fs` connection to another, no
 * parsing, no mapping. ADF's equivalent is a Copy over a Binary dataset.
 *
 * It is its own catalog type (`copy_files`) under the ONE Copy palette item,
 * and the dock's *Copy* toggle switches a node between the two. Two types
 * rather than one type with a mode field, because everything that decides how
 * a node binds (its connection kinds, whether it addresses datasets, its tabs
 * and its output contract) is read from the catalog BY TYPE in a dozen places,
 * and a mode field would have had to be threaded into every one of them. The
 * node's `type` in the JSON is what the toggle sets, so the form still sets
 * nothing the JSON does not show.
 *
 * Flat fields, not nested `source`/`sink` objects, so the dock draws each as a
 * labelled control on its tab. Paths follow `file_copy`'s rule: absolute, or
 * relative to the connection's first allowed folder.
 */

const pathTypeSchema = z.enum(['file', 'folder', 'list']);
const afterCopySchema = z.enum(['keep', 'delete', 'move']);
const copyBehaviorSchema = z.enum(['preserve', 'flatten', 'merge']);
const ifExistsSchema = z.enum(['overwrite', 'skip', 'fail']);

export type CopyFilesPathType = z.infer<typeof pathTypeSchema>;
export type CopyFilesAfterCopy = z.infer<typeof afterCopySchema>;
export type CopyFilesBehavior = z.infer<typeof copyBehaviorSchema>;
export type CopyFilesIfExists = z.infer<typeof ifExistsSchema>;

const IN_ROOTS = "Absolute, or relative to the connection's first allowed folder.";

const path = (title: string, description: string) =>
  presented(singleLine(z.string()).min(1), { title, description });

export const copyFilesConfigSchema = z
  .object({
    pathType: presented(pathTypeSchema.default('folder'), {
      title: 'Path type',
      description:
        'File copies one file. Folder copies the files in a folder that match the wildcard. File list copies the files named in a text file.',
      options: optionTitles(pathTypeSchema, {
        file: 'File',
        folder: 'Folder',
        list: 'File list',
      }),
    }),
    sourcePath: path(
      'Source path',
      `The file, or the folder to copy from. With a file list, the folder its paths are relative to. ${IN_ROOTS}`,
    ),
    wildcard: presented(singleLine(z.string()).min(1).default('*'), {
      title: 'Wildcard',
      description:
        'Folder only. Matches file names: * is any run of characters, ? is one character.',
    }),
    fileListPath: presented(singleLine(z.string()).min(1).optional(), {
      title: 'File list path',
      description: `File list only. A text file with one path per line, relative to the source path. ${IN_ROOTS}`,
    }),
    recursive: presented(z.boolean().default(true), {
      title: 'Include subfolders',
      description: 'Folder only. Also copies matching files in every subfolder.',
    }),
    modifiedStart: instant(
      'Modified from',
      'Only files last modified at or after this UTC time, e.g. 2026-10-13T00:00:00Z.',
    ),
    modifiedEnd: instant('Modified before', 'Only files last modified before this UTC time.'),
    afterCopy: presented(afterCopySchema.default('keep'), {
      title: 'After copy',
      description:
        'What happens to each source file once it is copied. Delete and Move need writes allowed on the source connection.',
      options: optionTitles(afterCopySchema, {
        keep: 'Keep source',
        delete: 'Delete source',
        move: 'Move source to',
      }),
    }),
    moveTo: presented(singleLine(z.string()).min(1).optional(), {
      title: 'Move to',
      description: `Move only. The folder each source file moves to, keeping its subfolders. ${IN_ROOTS}`,
    }),
    sinkFolder: presented(singleLine(z.string()).min(1).optional(), {
      title: 'Sink folder',
      description: `The folder files are written to. Empty means the connection's first allowed folder. ${IN_ROOTS}`,
    }),
    sinkFileName: presented(singleLine(z.string()).min(1).optional(), {
      title: 'File name',
      description:
        'For one file or a merge: the name to write, which may include subfolders. Empty keeps the source name.',
    }),
    copyBehavior: presented(copyBehaviorSchema.default('preserve'), {
      title: 'Copy behaviour',
      description:
        'Preserve keeps the source subfolders, Flatten writes every file into the folder, Merge joins every file into one.',
      options: optionTitles(copyBehaviorSchema, {
        preserve: 'Preserve hierarchy',
        flatten: 'Flatten',
        merge: 'Merge into one file',
      }),
    }),
    ifExists: presented(ifExistsSchema.default('overwrite'), {
      title: 'If file exists',
      options: optionTitles(ifExistsSchema, {
        overwrite: 'Overwrite',
        skip: 'Skip',
        fail: 'Fail',
      }),
    }),
    // #1600 OR41 C6b — the Settings tab's Session log, a rows Copy's field (C6a).
    // Only the level: the run log is the one destination until C6c.
    logLevel: sessionLogConfigFields.logLevel,
  })
  .superRefine((cfg, ctx) => {
    // Every rule here refuses a config that would do something other than what
    // it says, or nothing at all, rather than quietly ignoring a field. (Fields
    // with a default, like Include subfolders, cannot tell "set" from "left".)
    // A `${}` value is decided at dispatch, so a rule reading one skips it.
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [field], message });
    const separator = wildcardIssue(cfg.wildcard);
    if (separator !== undefined) issue('wildcard', separator);
    if (cfg.pathType !== 'folder' && cfg.wildcard !== '*') {
      issue('wildcard', 'a wildcard is only read when the path type is Folder');
    }
    const window = modifiedWindowIssue(cfg.modifiedStart, cfg.modifiedEnd);
    if (window !== undefined) issue('modifiedEnd', window);
    if (cfg.pathType === 'list' && cfg.fileListPath === undefined) {
      issue('fileListPath', 'a file list needs a file list path');
    }
    if (cfg.pathType !== 'list' && cfg.fileListPath !== undefined) {
      issue('fileListPath', 'a file list path is only read when the path type is File list');
    }
    if (cfg.afterCopy === 'move' && cfg.moveTo === undefined) {
      issue('moveTo', 'moving the source needs a folder to move it to');
    }
    if (cfg.afterCopy !== 'move' && cfg.moveTo !== undefined) {
      issue('moveTo', 'a move-to folder is only used when After copy is Move source to');
    }
    if (cfg.copyBehavior === 'merge') {
      if (cfg.pathType === 'file') {
        issue(
          'copyBehavior',
          'merging needs a folder or a file list; one file has nothing to merge',
        );
      }
      if (cfg.sinkFileName === undefined) {
        issue('sinkFileName', 'merging into one file needs its file name');
      }
    } else if (cfg.pathType !== 'file' && cfg.sinkFileName !== undefined) {
      issue(
        'sinkFileName',
        'a file name is only used for one file or a merge; each copied file keeps its own name',
      );
    }
  });

export type CopyFilesConfig = z.infer<typeof copyFilesConfigSchema>;
