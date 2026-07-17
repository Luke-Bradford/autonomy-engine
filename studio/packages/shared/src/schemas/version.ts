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
// 3 (#4 A1): the `if` control activity is a NEW catalog TYPE. A pre-A1 build does
// not route `if` — it treats an `if`'s branch edges as inert and SILENTLY strands
// everything downstream — so a doc using `if` must refuse to import there.
// Stamping 3 makes an older build reject it, the rule catalog/types.ts states for
// adding a type. (Adding metadata FIELDS to existing entries does not bump; adding
// a runnable TYPE does.)
// 4 (#4 A2): the `switch` control activity is a NEW catalog TYPE, same rationale
// as `if` (3): a pre-A2 build does not route `switch`, treats its named-case
// branch edges as inert, and SILENTLY strands everything downstream — so a doc
// using `switch` must refuse to import there.
// 5 (#4 A7): the `fail` control activity is a NEW catalog TYPE, same rationale as
// `if`/`switch`: a pre-A7 build does not route `fail` — it treats the fail node as
// an uncatalogued type (the executor fails it `UNKNOWN_ACTIVITY` rather than
// force-failing with the authored message), so a doc using `fail` must refuse to
// import there. Stamping 5 makes an older build reject it.
export const CATALOG_VERSION = 5;
export const SCHEMA_VERSION = 1;
