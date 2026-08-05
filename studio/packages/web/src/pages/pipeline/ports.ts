import { declaredBranchesOf, EdgeOnSchema, type EdgeOn, type Node } from '@autonomy-studio/shared';
import type { EdgeCondition } from './edgeCondition';

/**
 * U6b/U19 — the canvas's PORTS: the identified points an edge attaches to, and
 * what an edge drawn from one MEANS.
 *
 * U6b gave the two anonymous handles ids, because React Flow otherwise resolves
 * every edge against "the first handle of that type" — which works for exactly
 * one source handle and silently mis-attaches for two. **U19 is the two.** The
 * single `out` port is replaced by ONE SOURCE PORT PER OUTCOME the source can
 * emit (the four operational outcomes, plus a control node's `true`/`false`/case
 * labels), so `sourceHandle` — not a dropdown chosen afterwards — is what says
 * which outcome an edge routes.
 *
 * Ports are DELIBERATELY not part of the domain `Edge`. The engine has no ports:
 * an edge routes by its `on`/`branch` condition, and `stableEdgeKey` (which
 * indexes bounce counters across saves) is keyed on that. A port is a VIEW
 * concept that the canvas maps to a condition on the way in and out — which is
 * why U19 could change that mapping without touching a persisted key.
 *
 * The codec below lives here, rather than beside the rest of the edge helpers,
 * because after U19 the port id and the property panel's `<option value>` are
 * ONE encoding. Two encodings of the same fact is how the port an edge names and
 * the option the panel offers would come to disagree. `edgeCondition.ts`
 * re-exports it for its existing callers; the dependency runs one way,
 * `edgeCondition → ports`, because a value import back the other way would be a
 * cycle.
 */

/** The single incoming port. One per node, in the engine's single-in model. */
export const TARGET_PORT_ID = 'in';

/**
 * The four OPERATIONAL outcomes, all of them authorable as of U6a.
 *
 * `skipped` was pinned out of the canvas by `AUTHORABLE_EDGE_ON` when #1 F1
 * added it to the engine: the reducer routes a skip (`edgeState` returns
 * `satisfied` for an `on:'skipped'` edge off a skipped source and `impossible`
 * for every other kind, so `completion` deliberately does NOT catch a skip),
 * `EdgeOnSchema` has always carried it and `validatePipelineDoc` has never
 * refused it — nothing could AUTHOR it.
 *
 * Every activity declares all four. There is no per-definition narrowing:
 * `ActivityDefinition` has no `outcomes` field, and inventing one would claim
 * knowledge the engine does not have — the reducer decides an outcome at run
 * time, from what the activity did.
 */
export const OPERATIONAL_CONDITIONS: readonly EdgeOn[] = EdgeOnSchema.options;

/**
 * The condition assumed when a refusal has to be EXPLAINED but the gesture's
 * port cannot be read.
 *
 * `success` because that is the outcome an operator means by wiring two
 * activities together, and because a control node (`if`/`switch`) terminates
 * `success` too, so it is never a guess about a branch label — U6a settled that
 * defaulting to `on: 'branch'` would author a made-up routing key.
 *
 * Since U19 this is used for the refusal MESSAGE only, never to author an edge:
 * `conditionFromConnection` returns `null` for a port it cannot decode and both
 * `isValidConnection` and `onConnect` refuse on it, so a gesture whose outcome
 * is unknown draws nothing rather than the wrong thing.
 */
export const DRAWN_EDGE_CONDITION: EdgeCondition = { on: 'success' };

/**
 * Tag separating the two arms of an encoded condition.
 *
 * A `switch` case label is an ARBITRARY string — `validateSwitchConfig`
 * reserves only `default` — so `cases: ['success']` is a legal, savable doc.
 * With raw values, the operational outcome and the business branch would encode
 * identically and nothing downstream could tell them apart: choosing one would
 * silently author the other.
 */
const OP_TAG = 'op:';
const BRANCH_TAG = 'branch:';

/**
 * The encoded condition — a port id, and the property panel's `<option value>`.
 * Injective across both arms.
 *
 * The branch label is PERCENT-ENCODED, and that is a safety property rather than
 * tidiness. React Flow builds a CSS selector out of the port id on every pointer
 * move of every connection drag —
 * `doc.querySelector('.react-flow__handle[data-id="${flowId}-${nodeId}-${id}-${type}"]')`
 * (`@xyflow/system` 0.0.79, index.js:2566). A case label is arbitrary, so a
 * label containing a quote would throw a `SyntaxError` out of that loop and
 * break connecting CANVAS-WIDE, not just on the node that carries it. The human
 * string is kept on `SourcePort.label`, which is what the operator reads.
 */
export function encodeCondition(c: EdgeCondition): string {
  return c.on === 'branch' ? `${BRANCH_TAG}${percentEncode(c.branch)}` : `${OP_TAG}${c.on}`;
}

/**
 * `encodeURIComponent`, plus the six punctuation marks it deliberately leaves
 * alone (`!'()*~` are unreserved in RFC 3986 and legal in a URI).
 *
 * `'` is the one that matters: React Flow quotes the selector with `"`, so a
 * single quote is harmless THERE — but the id is also a selector in the e2e
 * helper and in any future stylesheet, and "safe as long as everyone keeps
 * quoting it the same way" is a property that decays. Encoding to a strict
 * `[A-Za-z0-9-_.~%]` alphabet makes it safe under either quoting;
 * `decodeURIComponent` reverses all of it unchanged.
 */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*~]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Parse an encoded condition back; `null` if it is not one.
 *
 * Only the FIRST delimiter splits, so a case label containing `:` round-trips.
 * An unrecognised operational value is refused rather than cast — the value
 * comes from the DOM, and a cast would put an off-enum string straight into the
 * doc. `decodeURIComponent` THROWS on a malformed escape (`%zz`), which a
 * git-imported doc can reach, so it degrades to `null` rather than taking the
 * canvas down.
 */
export function decodeConditionValue(value: string): EdgeCondition | null {
  if (value.startsWith(BRANCH_TAG)) {
    const raw = value.slice(BRANCH_TAG.length);
    if (raw.length === 0) return null;
    let branch: string;
    try {
      branch = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return branch.length > 0 ? { on: 'branch', branch } : null;
  }
  if (value.startsWith(OP_TAG)) {
    const parsed = EdgeOnSchema.safeParse(value.slice(OP_TAG.length));
    return parsed.success ? { on: parsed.data } : null;
  }
  return null;
}

/**
 * A condition's ROUTING KEY — what an edge, and now a port, is labelled by.
 *
 * A branch condition is labelled by `branch`, NOT by `on`: `on` is the literal
 * string `"branch"` for every arm of every branching node, so labelling by it
 * renders a two-armed `if` as two identical ports and drops the one piece of
 * information (`true`/`false`/case) that says where each arm goes.
 */
export function conditionLabel(c: EdgeCondition): string {
  return c.on === 'branch' ? c.branch : c.on;
}

/**
 * The conditions a source OFFERS — the four operational outcomes plus whatever
 * business branches it declares.
 *
 * ONE predicate, read by both surfaces that answer "can this source route
 * that?": the source ports drawn on the node, and the property panel's option
 * list (whose `orphaned` disabled-option is the same question asked from the
 * other side). Two copies of it is how the port an edge attaches to and the
 * option the panel offers would come to disagree about the same node.
 *
 * `source` may legitimately be `undefined`: an edge endpoint can be a CONTAINER
 * id (top-level↔container edges are valid, `connectRules`), and a source node
 * can be deleted out from under a selected edge. Degrade to "no branches", never
 * throw — a container declares the operational outcomes and nothing else.
 */
export function declaredConditionsOf(source: Node | undefined): EdgeCondition[] {
  const operational: EdgeCondition[] = OPERATIONAL_CONDITIONS.map((on) => ({ on }));
  if (source === undefined) return operational;
  const declared = declaredBranchesOf(source);
  if (declared === undefined) return operational;
  return [
    ...operational,
    /* EMPTY labels are dropped. `declaredBranchesOf` filters `cases` on
       `typeof c === 'string'` only, while `validateSwitchConfig` additionally
       refuses `''` — so a git-imported `cases: ['']` would otherwise render a
       port with no visible text whose id (`branch:`) `decodeConditionValue`
       rejects: a handle that can be grabbed and authors nothing, on a doc the
       save gate refuses anyway. Offering only what a save accepts is this
       module's whole claim. */
    ...[...declared]
      .filter((branch) => branch.length > 0)
      .map((branch): EdgeCondition => ({ on: 'branch', branch })),
  ];
}

/** One outgoing port: the outcome it routes, and how it is drawn and named. */
export interface SourcePort {
  /** The encoded condition — what an edge names in `sourceHandle`. */
  id: string;
  condition: EdgeCondition;
  /** The routing key, as the operator reads it. */
  label: string;
  /**
   * An existing edge routes on this, but the source no longer declares it. The
   * port exists ANYWAY — see `sourcePortsOf`.
   */
  orphaned: boolean;
}

/**
 * The source ports of one node or container: everything it declares, plus a port
 * for anything its existing edges already route on.
 *
 * The orphan arm is the silent failure this function exists to stop.
 * `declaredBranchesOf` reads a `switch`'s `config.cases` LIVE, so renaming a
 * case in the node panel un-declares a branch an existing edge still uses (an
 * API- or git-imported doc reaches the same state). Without a port for it,
 * React Flow resolves that edge's `sourceHandle` to nothing and simply does not
 * draw the line — no error, no warning, no console message. The edge is still in
 * the doc and `validateCanvas` is already badging the doc unsavable; the canvas
 * must not be the one surface that hides it. It is the same fact the property
 * panel states as a disabled `<option>` (U6a), drawn from the same predicate.
 *
 * Orphans come LAST, so adding one never reorders the declared set under the
 * operator's pointer.
 */
export function sourcePortsOf(
  source: Node | undefined,
  used: readonly EdgeCondition[],
): SourcePort[] {
  const port = (condition: EdgeCondition, orphaned: boolean): SourcePort => ({
    id: encodeCondition(condition),
    condition,
    label: conditionLabel(condition),
    orphaned,
  });
  const ports = declaredConditionsOf(source).map((c) => port(c, false));
  const seen = new Set(ports.map((p) => p.id));
  for (const condition of used) {
    const id = encodeCondition(condition);
    if (seen.has(id)) continue;
    seen.add(id);
    ports.push(port(condition, true));
  }
  return ports;
}

/**
 * The vertical pitch between two sibling source ports, in flow units.
 *
 * It is a floor, not a taste: React Flow's `getClosestHandle` snaps a drag to
 * any handle within `connectionRadius` and skips only the EXACT handle the drag
 * started on (`@xyflow/system` 0.0.79, index.js:2332). Ports closer together
 * than that radius would make starting a drag on `success` snap to `failure` —
 * which then reads as a node connecting to itself and pops the self-connect
 * refusal for a mis-click — and would make a backwards drag onto the column
 * author whichever outcome happened to be nearest. Hence the pitch, the reduced
 * radius below, and the test that pins one under half the other.
 */
export const SOURCE_PORT_PITCH = 16;

/**
 * React Flow's snap radius, reduced from its default 20 for the reason above.
 * Stated here, next to the pitch it is constrained by, rather than inline on the
 * `<ReactFlow>` element where the constraint would be invisible.
 */
export const CONNECTION_RADIUS = 6;

/** Room for the node's own text once the ports have taken their column. */
const NODE_VERTICAL_PADDING = 16;

/** The height of a node with no ports at all — the pre-U19 box. */
const BASE_NODE_HEIGHT = 52;

/**
 * A source port's offset from the node's vertical CENTRE, in flow units.
 *
 * Centred fixed-pitch rather than spread-across-the-height, so ONE formula
 * serves both consumers in the same units: the rendered handle's inline
 * `top: calc(50% + Npx)`, and the STATED `y` of a derived container's handle
 * (`containerHandles`). A fraction would have had to be resolved against a
 * measured height in one place and a derived one in the other, which is exactly
 * where "stated and rendered cannot disagree" stops being true.
 */
export function sourcePortOffset(index: number, count: number): number {
  return (index - (count - 1) / 2) * SOURCE_PORT_PITCH;
}

/** The height a node needs for `portCount` ports at the pitch above. */
export function nodeBoxHeight(portCount: number): number {
  return Math.max(BASE_NODE_HEIGHT, portCount * SOURCE_PORT_PITCH + NODE_VERTICAL_PADDING);
}

/**
 * The condition a DRAWN connection carries — read off the port the drag started
 * from, which is the whole of U19.
 *
 * Pure, and separate from the canvas, because the gesture itself is not
 * unit-testable: jsdom measures every element as zero and React Flow culls
 * unmeasured nodes, so a `FlowCanvas` test that simulates a drag asserts on
 * nothing. The e2e spec covers the gesture; this covers the decision.
 *
 * React Flow normalises `Connection` before either callback sees it — `source`/
 * `sourceHandle` are the SOURCE end whichever end the drag began on
 * (`@xyflow/system` 0.0.79, index.js:2591) — so a backwards drag still names the
 * outcome port. `null` means REFUSE: `sourceHandle` is typed nullable and read
 * straight off a DOM attribute, so the arm is reachable rather than defensive,
 * and guessing an outcome here would author one the operator did not draw.
 */
export function conditionFromConnection(conn: {
  sourceHandle?: string | null;
}): EdgeCondition | null {
  return conn.sourceHandle == null ? null : decodeConditionValue(conn.sourceHandle);
}

/**
 * The SOURCE→TARGET ends of a connection gesture, whichever end it was started
 * from.
 *
 * A drag can begin on EITHER port: React Flow gives every handle both
 * `isConnectableStart` and `isConnectableEnd` by default, so grabbing a node's
 * `in` port and pulling it back to an upstream node's outcome port is a
 * supported way to draw the same edge. React Flow itself normalises this before
 * it decides validity — `isValidHandle` computes
 * `source: isTarget ? handleNodeId : fromNodeId` with
 * `isTarget = fromType === 'target'` (`@xyflow/system` 0.0.79, index.js:2563 and
 * 2591) — but `onConnectEnd` is handed the RAW gesture: `fromNode` is where the
 * pointer went DOWN and `toNode` is what it was over on release.
 *
 * Reading those two as (source, target) is wrong for exactly half of all
 * gestures, and it fails in the worst available way. On a graph `a → b`, drawing
 * the duplicate `a → b` backwards (from b's `in` to a's outcome port) is refused
 * for being a duplicate, while the un-normalised reason is computed for `b → a`
 * and explains a CYCLE instead. Worse, drawing a cycle-closer backwards is
 * refused and the un-normalised candidate is LEGAL, so the panel renders nothing
 * at all — the silent refusal this whole ticket exists to remove.
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
