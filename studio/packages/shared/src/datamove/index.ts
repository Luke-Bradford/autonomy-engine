// #996 M5 — the data-movement layer: pure behaviour ABOUT a copy, as distinct
// from the catalog metadata that DECLARES one (`catalog/copy-config.ts`) and the
// store connectors that do the I/O (server).
//
// Mostly RUNTIME — what a copy performs on values — but not exclusively, and the
// charter said "RUNTIME" until M8 slice 2 (#1170) added `copy-automap.ts`, which
// is authoring-time. It lives here because it must match names by the SAME
// primitives the runtime gate uses (`schema-drift.ts`), which is the whole
// reason it cannot live in the web package.
export * from './address.js';
export * from './coerce.js';
export * from './copy-automap.js';
export * from './delimited.js';
export * from './mapping-agreement.js';
export * from './pump.js';
export * from './schema-drift.js';
