import { catalog, type ActivityCatalog, type ActivityCatalogEntry } from '@autonomy-studio/shared';

/**
 * #1480 — the save gate refuses a node `type` its catalog does not name,
 * because the executor would refuse it at dispatch. Run-mechanics fixtures use
 * UNCATALOGUED types on purpose: a type-agnostic stub (or an executor handed an
 * injected catalog) runs them, and an uncatalogued type keeps the node's output
 * contract `absent` (F13b only lowers a contract into KNOWN types). So those
 * fixtures save against the shared catalog plus these names — what the executor
 * they run under accepts. A bare entry declares no `dispatchConfigSchema`, so
 * the gate checks the type and leaves the stub's config alone.
 */
export const STUB_ACTIVITY_TYPES = [
  'test_activity',
  'test_builtin',
  'test_control',
  'test_copy',
  'test_lookup',
  'test_paired',
  'test_pg_store',
  'test_single',
] as const;

export const STUB_SAVE_CATALOG: ActivityCatalog = new Map([
  ...catalog,
  ...STUB_ACTIVITY_TYPES.map((type) => [type, { type } as ActivityCatalogEntry] as const),
]);
