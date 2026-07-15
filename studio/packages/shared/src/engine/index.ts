// P2a — the pure `${}` parameter language (inert substitution + validateRefs).
// Lives in `shared` so both web and server import one engine; NO I/O anywhere.
export * from './types.js';
// #6 E1 — the expression grammar (parser + AST) the evaluator and the static
// checker both read. One grammar SSOT; E2-E8 build on this AST.
export * from './expr.js';
// #6 E4 — the closed function catalog. A NAMED re-export, deliberately not
// `export *`: the catalog itself (`FUNCTIONS`), the calling convention
// (`FnSpec`/`EvalIn`) and the arg-checking helpers are the evaluator's private
// seam — `params.ts` imports them directly from the module. Publishing them
// would make engine-internal machinery part of `@autonomy-studio/shared`'s API
// by accident, which is the same trap that kept `MissingValueError`
// private. Only the surface a CONSUMER needs is exported: the caps (for a UI to
// explain a limit) and the catalog's NAMES (for editor autocomplete at U-series).
export {
  MAX_ARRAY_ELEMENTS,
  MAX_ARRAY_ELEMENTS_TOTAL,
  MAX_PATH_DEPTH,
  listFunctions,
} from './functions.js';
export type { SigType } from './functions.js';
export * from './params.js';

// P2b — the pure event-sourced reducer + acyclic DAG walk.
export * from './reduce.js';
