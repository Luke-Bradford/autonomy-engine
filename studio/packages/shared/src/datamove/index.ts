// #996 M5 — the data-movement RUNTIME layer: pure behaviour a copy performs on
// values, as distinct from the catalog metadata that DECLARES a copy
// (`catalog/copy-config.ts`) and the store connectors that do the I/O (server).
export * from './coerce.js';
export * from './pump.js';
