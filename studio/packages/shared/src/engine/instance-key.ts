// ---------------------------------------------------------------------------
// #566 slice 2 / #4 A4b — per-item INSTANCE KEYS for the parallel foreach.
//
// When a foreach runs in parallel mode (`batchCount >= 2`), each in-flight item
// i's body-node state lives under the key `<docNodeId>@<i>` in `state.nodes`,
// `state.outputs` and `state.branches`, and events carry that key in their
// existing `nodeId` field — NO event-schema change. An attemptId is minted by
// the existing `${id}#${attempts}` rule over the instance key, so it reads
// `<docNodeId>@<i>#<n>`.
//
// These helpers are the ONE grammar for that key, shared by the reducer (which
// namespaces state), the server (doc-node lookups keyed by an event/command
// nodeId: executor, external-wait callback resolution, retry policy reads) and
// the web run view (folding instance events onto the canvas node's row). A
// second hand-rolled parse at any of those sites is exactly the drift this
// module exists to prevent.
//
// The parse is deliberately conservative: only `<non-empty id>@<digits>` is an
// instance key, and the doc-id capture is GREEDY so `a@2@5` parses as
// `{docId: 'a@2', itemIndex: 5}` — the LAST `@<digits>` run is the suffix.
// A literal doc id shaped like `x@2` is therefore ambiguous with an instance
// key, which is why `validateDoc` refuses `batchCount >= 2` on any doc whose
// entity ids contain `@` (and the reducer re-checks at parallel enter for
// legacy rows). Sequential docs may keep such ids: every consumer that resolves
// a doc node from an id tries the EXACT id first and only then falls back to
// `docNodeIdOf`, so a legacy literal `x@2` node keeps resolving to itself.
// ---------------------------------------------------------------------------

const INSTANCE_KEY_RE = /^(.+)@(\d+)$/;

/** The instance key for doc node `docId`'s item-`itemIndex` body instance. */
export function instanceKey(docId: string, itemIndex: number): string {
  return `${docId}@${itemIndex}`;
}

/** Parse an instance key, or `null` when `id` is a bare doc id. */
export function parseInstanceKey(id: string): { docId: string; itemIndex: number } | null {
  const m = INSTANCE_KEY_RE.exec(id);
  if (m === null) return null;
  return { docId: m[1]!, itemIndex: Number(m[2]) };
}

/** The doc-node id behind an event/command nodeId: strips an instance suffix. */
export function docNodeIdOf(id: string): string {
  return parseInstanceKey(id)?.docId ?? id;
}

/**
 * Resolve the doc node behind an event/command/row nodeId over a node LIST:
 * EXACT id first (a legacy sequential doc's literal `x@2` node resolves to
 * itself), then the instance-suffix strip for a parallel-body instance key.
 * The ONE resolution policy for every server-side `nodes.find` site (executor,
 * external-wait callback, retry-policy read) — a hand-rolled pair of `find`s at
 * a new site is exactly the drift this module's header warns about. (The
 * reducer's `docNodeFor` applies the same policy over its prebuilt Map.)
 */
export function resolveDocNode<T extends { id: string }>(
  nodes: readonly T[],
  id: string,
): T | undefined {
  return nodes.find((n) => n.id === id) ?? nodes.find((n) => n.id === docNodeIdOf(id));
}
