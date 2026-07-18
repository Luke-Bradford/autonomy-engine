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
// 6 (#4 A8): the `filter` control activity is a NEW catalog TYPE, same rationale
// as `if`/`switch`/`fail`: a pre-A8 build does not route `filter` — it treats the
// node as an uncatalogued type (the executor fails it `UNKNOWN_ACTIVITY` rather
// than engine-evaluating its predicate into a `result` output), so a doc using
// `filter` must refuse to import there. Stamping 6 makes an older build reject it.
// 7 (#4 A5+A6): the `wait` control activity is a NEW catalog TYPE, same rationale
// as `if`/`switch`/`fail`/`filter`: a pre-A6 build does not route `wait` — it
// treats the node as an uncatalogued type (the executor fails it `UNKNOWN_ACTIVITY`
// rather than parking it on a durable timer), so a doc using `wait` must refuse to
// import there. Stamping 7 makes an older build reject it.
// (no bump for #4 A9): `execute_pipeline` is a new catalogued TYPE, yet it is the
// EXCEPTION to the "a new TYPE bumps" rule the five above obey. Those route BY
// TYPE, so a pre-X build lacks the branch and mis-runs them (`UNKNOWN_ACTIVITY` /
// inert branches). `execute_pipeline` instead SURFACES the pre-existing structural
// `call_pipeline` (P2c): the reducer routes a call node by the presence of
// `Node.call`, NEVER by the type string, and that routing predates every catalogued
// control type — so an older build (lacking the entry) still routes an
// `{type:'execute_pipeline', call}` node IDENTICALLY. No export carries an artifact
// an older build mis-runs (the bump rule's load-bearing test, catalog/types.ts), so
// bumping would only make an older build wrongly REFUSE a doc it can run. Stays 7.
// 8 (#4 A11): `file_read`/`file_write` are NEW runnable EXECUTION types on a NEW
// `fs` connection kind — the bump-rule's normal case, NOT the `execute_pipeline`
// exception. They route BY TYPE at the executor (an older build lacks the catalog
// entry → `UNKNOWN_ACTIVITY`, `executor.ts`), and their `fs` connection kind is
// not even parseable by an older `ConnectionKindSchema` — so an export using them
// carries artifacts an older build mis-runs and must refuse to import. Stamping 8
// enforces that (`portability/envelope.ts`), the rule catalog/types.ts states.
// 9 (#4 A12): `file_copy`/`file_move`/`file_delete`/`file_list` are NEW runnable
// EXECUTION types on the EXISTING `fs` connection kind — the A11 bump-rule case,
// NOT the `execute_pipeline` exception. They route BY TYPE at the executor (an
// older build lacks the catalog entry → `UNKNOWN_ACTIVITY`, `executor.ts`), so an
// export using any of them carries an artifact an older build mis-runs and must
// refuse to import. Stamping 9 enforces that (`portability/envelope.ts`), the
// rule catalog/types.ts states. (No new connection kind this time — `fs` already
// parses at 8 — so no migration; only the new activity types force the bump.)
// 10 (#4 A13): `webhook` is a NEW control TYPE the reducer routes BY TYPE (its own
// dispatch-prep branch + `externalWait.*` folds an older build lacks) — the normal
// bump-rule case the control types obey, NOT the `execute_pipeline` structural
// exception (which routes by `Node.call`, not the type string). An export using a
// `webhook` node carries an artifact an older build mis-runs (`UNKNOWN_ACTIVITY` /
// an inert unrouted control node), so it must refuse to import. Stamping 10
// enforces that (`portability/envelope.ts`), the rule catalog/types.ts states.
// 12 (#2 L4a): `llm_call` STRUCTURED output. A `structured` node declares an
// `outputSchema` (a restricted subset) that LOWERS at save into `config.outputs`,
// so a downstream `${nodes.x.output.category}` binds to a typed field. A pre-L4a
// build ignores `outputMode`/`outputSchema` entirely and runs the node in TEXT
// mode — producing `{text, stopReason}` — so the reducer's `validateOutputs`
// (`engine/outputs.ts`) then FAILS the node on `missing declared output
// 'category'` against the persisted `config.outputs`. That is an ACTIVE
// node-failure mis-run (not merely an empty output), the same bump-rule shape as
// A16, so it bumps 11→12: a pre-12 build must refuse an L4a export at import
// (`portability/envelope.ts`) rather than fail the structured node at run time.
// 11 (#4 A16): `webhook` typed OUTPUT. No new TYPE and no new catalog-entry field
// (webhook outputs are author-declared via the generic F13 `config.outputs`, like
// `execute_pipeline`'s child-projected outputs) — but this is NOT the A9 structural
// exception. An A16 export authors a webhook whose declared `config.outputs` a
// downstream `${nodes.w.output.decision}` depends on; a pre-A16 build (which parks
// + completes the webhook but NEVER populates its outputs — the inbound body was
// OPAQUE in A13) leaves that ref unresolved and mis-runs the export. That is the
// bump-rule's load-bearing test (an older build mis-runs the artifact), met exactly
// as A11/A13's `UNKNOWN_ACTIVITY` mis-run was — so it bumps, unlike A9 (whose
// exports were IDENTICALLY runnable on older builds). Stamping 11 makes a 10-build
// refuse an A16 export at import (`portability/envelope.ts`) rather than silently
// leaving the typed output empty at run time.
export const CATALOG_VERSION = 12;
export const SCHEMA_VERSION = 1;
