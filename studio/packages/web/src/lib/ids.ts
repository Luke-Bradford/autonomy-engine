/**
 * Client-authored ids for canvas-authored nodes and edges. These ids live
 * INSIDE the immutable pipeline-version JSON blob (not as DB rows), so the
 * client mints them — unlike server entities (pipelines/connections/…), whose
 * ids the server assigns. `crypto.randomUUID()` is available in every target
 * browser and in jsdom, and is collision-free, which the engine relies on:
 * `validateDoc` keys `state.nodes`/`state.outputs`/`endpointOutcome` by a single
 * GLOBAL id namespace, so a duplicate id would silently corrupt run state.
 */
export function newLocalId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
