import { z } from 'zod';
import { presented, singleLine } from '../schemas/field-presentation.js';
import { LOOKUP_OVER_LIMIT_OPTIONS, lookupOverLimitSchema } from './lookup-config.js';

// #1396 — the human labels the node panel shows. Built per field (each call
// returns a fresh instance), so no two activities share a tagged schema.
const filePath = (title: string, description: string) =>
  presented(singleLine(z.string()).min(1), { title, description });
const IN_ROOTS = "Must sit inside one of the connection's allowed folders.";

/**
 * #4 A11/A12 — the `fs` connector activities' input/config schemas. This is the
 * SINGLE SOURCE OF TRUTH for each `file_*` activity's shape, read by TWO
 * independent sites that previously each declared an inline `z.object` and could
 * silently drift (#578): the catalog entries (`registry.ts`, for the authoring
 * UI's palette `configSchema` metadata) and the server `fs` adapter
 * (`connectors/fs.ts`, for live request validation of the `${}`-substituted
 * input). Unifying them here is the same shared→server pattern `llm_call` uses
 * for `llmCallConfigSchema` and `http_request` for `httpSecretHeadersSchema`.
 *
 * These are byte-identical to the shapes they replaced — a pure consolidation, no
 * validation-behaviour change, so `CATALOG_VERSION` is deliberately NOT bumped.
 */

/**
 * `file_read`: a single non-empty `path`.
 *
 * #1600 OR41 C7c — and Lookup's *When over the limit*, for a file over the
 * connection's read limit (`maxBytes`). The default is Fail, which is what a
 * stored `file_read` has always done (catalogue §8) and what ADF's Lookup does
 * over its size limit. A whole file cut short is rarely usable, unlike a
 * bounded set of rows, so rows mode's Truncate default is not copied here.
 */
export const fileReadConfigSchema = z.object({
  path: filePath('File path', IN_ROOTS),
  overLimit: presented(lookupOverLimitSchema.default('fail'), {
    title: 'When over the limit',
    description:
      "A file larger than the connection's Largest file read. Fails unless set to Truncate and warn.",
    options: LOOKUP_OVER_LIMIT_OPTIONS,
  }),
});

/** `file_write`: a `path` plus the UTF-8 text `content` to write. */
export const fileWriteConfigSchema = z.object({
  path: filePath('File path', IN_ROOTS),
  content: presented(z.string(), {
    title: 'Content',
  }),
});

/** `file_copy`: a `source` and a `dest`, both non-empty. */
export const fileCopyConfigSchema = z.object({
  source: filePath('Source path', IN_ROOTS),
  dest: filePath('Destination path', IN_ROOTS),
});

/** `file_move`: a `source` and a `dest`, both non-empty. */
export const fileMoveConfigSchema = z.object({
  source: filePath('Source path', IN_ROOTS),
  dest: filePath('Destination path', IN_ROOTS),
});

/** `file_delete`: a single `path`. */
export const fileDeleteConfigSchema = z.object({ path: filePath('File path', IN_ROOTS) });

/** `file_list`: a single directory `path`. */
export const fileListConfigSchema = z.object({ path: filePath('Folder path', IN_ROOTS) });
