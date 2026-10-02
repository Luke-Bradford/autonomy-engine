/**
 * Bounds how deep any walk may descend the node-`config` TREE (nested
 * objects/arrays) before it refuses. `config` is `z.record(z.string(),
 * z.unknown())` — opaque to Zod, so a stored/run-now config can nest
 * arbitrarily deep. Every recursor over the tree — `substitute` (RUN),
 * `scan` (the `${}` SAVE walk) and `walkConfigForMarkers`/`walkMarkerRegion`
 * (the `{$secret}` SAVE gate + DISPATCH resolver) — checks this cap at entry, so
 * a pathological config fails with a CLEAN error/throw instead of overflowing
 * the stack (`RangeError`). This is the config-TREE axis; it is ORTHOGONAL to
 * `MAX_EXPR_DEPTH` (expression AST nesting, `expr.ts`) and `MAX_PATH_DEPTH` (ref
 * path segments, `functions.ts`) — neither of those bounds the tree walk. It is
 * the SAME axis as server-side `MAX_REDACT_DEPTH` (`connectors/redact.ts`, which
 * caps the resolved-config redaction walk at 100); the two compose safely — a
 * config within this 64 cap is comfortably within redaction's 100 ceiling. The
 * config-tree analogue of #453, which bounded expression nesting for the same
 * class of raw-`RangeError` bug. 64 is reasoned by analogy to the sibling caps,
 * not a measured overflow point: a native stack blows in the low thousands of
 * frames (#453 measured ~2000 for the expression walk), and real config is a
 * handful of levels deep, so 64 is a wide safe band the cap only ever bites a
 * pathological input against.
 */
export const MAX_CONFIG_DEPTH = 64;
