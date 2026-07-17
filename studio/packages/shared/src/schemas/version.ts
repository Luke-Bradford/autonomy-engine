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
// 2 (item 7 / S4): `http_request` now declares a `secretHeaders` secret SINK, so
// an authored/exported version can carry a `{$secret}` marker that only a
// sink-declaring catalog resolves. A pre-S4 build lacks the sink and would drop
// the secret header SILENTLY at dispatch; stamping 2 makes it refuse the import
// (`portability/envelope.ts`) instead — fail-safe on secrets. See catalog/types.ts.
export const CATALOG_VERSION = 2;
export const SCHEMA_VERSION = 1;
