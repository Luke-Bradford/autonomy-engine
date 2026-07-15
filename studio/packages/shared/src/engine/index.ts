// P2a — the pure `${}` parameter language (inert substitution + validateRefs).
// Lives in `shared` so both web and server import one engine; NO I/O anywhere.
export * from './types.js';
// #6 E1 — the expression grammar (parser + AST) the evaluator and the static
// checker both read. One grammar SSOT; E2-E8 build on this AST.
export * from './expr.js';
// #6 E4 — the closed function catalog + the per-fn calling convention/signatures
// that the evaluator and the static checker both read.
export * from './functions.js';
export * from './params.js';

// P2b — the pure event-sourced reducer + acyclic DAG walk.
export * from './reduce.js';
