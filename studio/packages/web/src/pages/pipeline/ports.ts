import type { EdgeCondition } from './edgeCondition';

/**
 * U6b — the canvas's PORTS: the identified points an edge attaches to, and what
 * an edge drawn from one MEANS.
 *
 * Until now the two `<Handle>`s were anonymous, and React Flow resolved every
 * edge against "the first handle of that type". That works for exactly one
 * source handle and silently mis-attaches for two, so the ids below are the seam
 * **U19** widens: it replaces the single source port with one per outcome the
 * node's `ActivityDefinition` can emit (success/failure/completion/skipped, or a
 * control node's `true`/`false`/case), at which point `sourceHandle` — not a
 * dropdown chosen afterwards — is what says which outcome an edge routes.
 *
 * They are DELIBERATELY not part of the domain `Edge`. The engine has no ports:
 * an edge routes by its `on`/`branch` condition, and `stableEdgeKey` (which
 * indexes bounce counters across saves) is keyed on that. A port is a VIEW
 * concept that the canvas maps to a condition on the way in and out, so U19 can
 * change the mapping without touching a persisted key.
 */

/** The single incoming port. One per node, in the engine's single-in model. */
export const TARGET_PORT_ID = 'in';

/** The single outgoing port. U19 splits this into one port per outcome. */
export const SOURCE_PORT_ID = 'out';

/**
 * The condition a DRAWN edge carries.
 *
 * `success` because that is the outcome an operator means by wiring two
 * activities together, and because a control node (`if`/`switch`) terminates
 * `success` too, so it is never a guess about a branch label — U6a settled that
 * defaulting to `on: 'branch'` would author a made-up routing key.
 *
 * Exported as ONE constant because two callers must agree exactly: the
 * connect-time validity check (which decides whether the gesture is allowed) and
 * `onConnect` (which authors the edge). If the check tested `success` while the
 * store authored `failure`, a refused duplicate would become an authored one.
 */
export const DRAWN_EDGE_CONDITION: EdgeCondition = { on: 'success' };

/**
 * The SOURCE→TARGET ends of a connection gesture, whichever end it was started
 * from.
 *
 * A drag can begin on EITHER port: React Flow gives every handle both
 * `isConnectableStart` and `isConnectableEnd` by default, so grabbing a node's
 * `in` port and pulling it back to an upstream node's `out` port is a supported
 * way to draw the same edge. React Flow itself normalises this before it decides
 * validity — `isValidHandle` computes
 * `source: isTarget ? handleNodeId : fromNodeId` with
 * `isTarget = fromType === 'target'` (`@xyflow/system` 0.0.79, index.js:2563 and
 * 2591) — but `onConnectEnd` is handed the RAW gesture: `fromNode` is where the
 * pointer went DOWN and `toNode` is what it was over on release.
 *
 * Reading those two as (source, target) is wrong for exactly half of all
 * gestures, and it fails in the worst available way. On a graph `a → b`, drawing
 * the duplicate `a → b` backwards (from b's `in` to a's `out`) is refused for
 * being a duplicate, while the un-normalised reason is computed for `b → a` and
 * explains a CYCLE instead. Worse, drawing a cycle-closer backwards is refused
 * and the un-normalised candidate is LEGAL, so the panel renders nothing at all —
 * the silent refusal this whole ticket exists to remove.
 */
export function orientDrawnEnds(
  fromNodeId: string,
  toNodeId: string,
  fromHandleType: 'source' | 'target' | undefined,
): { from: string; to: string } {
  return fromHandleType === 'target'
    ? { from: toNodeId, to: fromNodeId }
    : { from: fromNodeId, to: toNodeId };
}
