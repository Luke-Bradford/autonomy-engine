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

/**
 * #1392 — the short form of a server id, for a page that shows a NAME and wants
 * the id available without leading with it.
 *
 * Server ids are `${prefix}_${nanoid()}` (`server/src/repo/ids.ts`), whose doc
 * says callers must never parse the prefix. So this keeps the TAIL rather than
 * stripping a prefix: the last eight characters of a random id are as
 * distinguishing as any eight, and the rule holds for any id shape. An id no
 * longer than twelve characters is returned whole — cutting `run_e2e_u3` to
 * `n_e2e_u3` would be shorter and strictly less readable.
 */
export function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(-8);
}
