/**
 * Version stamps embedded in every exported config object's JSON (per the
 * target architecture: "Every config object exports as version-stamped
 * JSON — a pipeline authored on an older activity-catalog still loads").
 *
 * `CATALOG_VERSION` — the Activity Catalog version a `PipelineVersion`'s
 * `nodes[]` were authored against (see `pipeline.ts`). `SCHEMA_VERSION` — the
 * shape of these Zod schemas themselves. Both start at 1; bump (and add an
 * upgrade path) when either changes in a way that breaks an older export.
 */
export const CATALOG_VERSION = 1;
export const SCHEMA_VERSION = 1;
