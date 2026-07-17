import { z } from 'zod';

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

/** `file_read`: a single non-empty `path`. */
export const fileReadConfigSchema = z.object({ path: z.string().min(1) });

/** `file_write`: a `path` plus the UTF-8 text `content` to write. */
export const fileWriteConfigSchema = z.object({ path: z.string().min(1), content: z.string() });

/** `file_copy`: a `source` and a `dest`, both non-empty. */
export const fileCopyConfigSchema = z.object({
  source: z.string().min(1),
  dest: z.string().min(1),
});

/** `file_move`: a `source` and a `dest`, both non-empty. */
export const fileMoveConfigSchema = z.object({
  source: z.string().min(1),
  dest: z.string().min(1),
});

/** `file_delete`: a single `path`. */
export const fileDeleteConfigSchema = z.object({ path: z.string().min(1) });

/** `file_list`: a single directory `path`. */
export const fileListConfigSchema = z.object({ path: z.string().min(1) });
