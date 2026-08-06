import {
  declaredBranchesOf,
  EdgeOnSchema,
  type Edge,
  type EdgeOn,
  type Node,
} from '@autonomy-studio/shared';
/* TYPE-ONLY, and it has to stay that way: `edgeCondition.ts` imports values from
   THIS module (the codec below), so anything but an erased type import here
   would close a runtime cycle between the two. */
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
 *
 * `conditionOf` is here for exactly that reason and not for any other — see its
 * own note. Nothing in this module may import a VALUE from `edgeCondition.ts`.
 */

/** The single incoming port. One per node, in the engine's single-in model. */
export const TARGET_PORT_ID = 'in';

/**
 * The condition carried by an existing edge.
 *
 * A fact about an `Edge`, so it reads as an `edgeCondition.ts` helper and lived
 * there until U19 — where `usedConditionsBySource` (below) became its caller and
 * turned that file into a value dependency of this one, closing a runtime cycle
 * with the codec's re-export going the other way. It is re-exported from
 * `edgeCondition.ts`, so every existing caller's import path is unchanged; only
 * the module the definition sits in moved.
 */
export function conditionOf(e: Edge): EdgeCondition {
  return e.on === 'branch' ? { on: 'branch', branch: e.branch } : { on: e.on };
}

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
 * Injective across both arms, and TOTAL: it never throws.
 *
 * The branch label is escaped, and that is a safety property rather than
 * tidiness. React Flow builds a CSS selector out of the port id on every pointer
 * move of every connection drag —
 * `doc.querySelector('.react-flow__handle[data-id="${flowId}-${nodeId}-${id}-${type}"]')`
 * (`@xyflow/system` 0.0.79, index.js:2566). A `switch` case label is arbitrary
 * (`validateSwitchConfig` reserves only `default`), so a label containing a
 * quote would throw a `SyntaxError` out of that loop and break connecting
 * CANVAS-WIDE, not just on the node that carries it. The human string is kept on
 * `SourcePort.label`, which is what the operator reads.
 */
export function encodeCondition(c: EdgeCondition): string {
  return c.on === 'branch' ? `${BRANCH_TAG}${escapeLabel(c.branch)}` : `${OP_TAG}${c.on}`;
}

/** The characters a port id may carry literally — a selector-safe alphabet. */
const PORT_ID_SAFE = /[A-Za-z0-9\-_.]/;

/** How many hex digits one escaped UTF-16 code unit takes. */
const ESCAPE_WIDTH = 4;

/**
 * Escape a branch label to `[A-Za-z0-9-_.%]`, one UTF-16 CODE UNIT at a time.
 *
 * `encodeURIComponent` was the obvious tool and is the wrong one: it THROWS a
 * `URIError` on a lone surrogate, and a lone surrogate is a legally savable case
 * label — `configSchema` is `z.array(z.string())` and `validateSwitchConfig`
 * refuses only `''` and the reserved `default`, so nothing between the API and
 * here rejects one. An encoder that throws does not fail on that node, it fails
 * the whole render: `portsBySource` is a `useMemo` over every node,
 * `runFlowNodes` builds the monitor the same way, and `EdgePanel` builds its
 * option list from it. One malformed string in one imported doc would blank the
 * canvas.
 *
 * Escaping code units instead is total in both directions and loses nothing: a
 * surrogate, paired or not, round-trips through `String.fromCharCode`. It also
 * leaves the labels that actually occur — `true`, `false`, `default`, ordinary
 * case names — completely literal, so a port id stays readable in the DOM.
 */
function escapeLabel(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    out += PORT_ID_SAFE.test(ch)
      ? ch
      : `%${value.charCodeAt(i).toString(16).toUpperCase().padStart(ESCAPE_WIDTH, '0')}`;
  }
  return out;
}

/**
 * Reverse `escapeLabel`; `null` if the input is not something it produced.
 *
 * Refusing a malformed escape rather than passing it through is the same rule
 * the operational arm follows: the value arrives from a DOM attribute, and a
 * port id that decoded to a DIFFERENT label than the one that produced it would
 * attach an edge to the wrong outcome, which is worse than not attaching it.
 */
function unescapeLabel(value: string): string | null {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== '%') {
      out += value[i];
      continue;
    }
    const hex = value.slice(i + 1, i + 1 + ESCAPE_WIDTH);
    if (!/^[0-9A-F]{4}$/.test(hex)) return null;
    out += String.fromCharCode(parseInt(hex, 16));
    i += ESCAPE_WIDTH;
  }
  return out;
}

/**
 * Parse an encoded condition back; `null` if it is not one.
 *
 * Only the FIRST delimiter splits, so a case label containing `:` round-trips.
 * An unrecognised operational value is refused rather than cast — the value
 * comes from the DOM, and a cast would put an off-enum string straight into the
 * doc. A malformed escape (`%zz`) is refused for the same reason rather than
 * decoded loosely: a port id that came back as a DIFFERENT label than the one
 * that produced it would attach an edge to the wrong outcome.
 */
export function decodeConditionValue(value: string): EdgeCondition | null {
  if (value.startsWith(BRANCH_TAG)) {
    const raw = value.slice(BRANCH_TAG.length);
    if (raw.length === 0) return null;
    const branch = unescapeLabel(raw);
    return branch !== null && branch.length > 0 ? { on: 'branch', branch } : null;
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
export function declaredConditionsOf(
  source: Node | undefined,
  /**
   * The source's branches, if the caller has already asked for them.
   *
   * A seam for the ONE caller that needs both halves — the property panel shows
   * a branch `<optgroup>` (which needs the tri-state) and an option list (which
   * needs the whole set), and without this it would ask the source to declare
   * itself twice per render. Every other caller omits it and gets the same
   * single call it always made.
   */
  branches: EdgeCondition[] | null = branchConditionsOf(source),
): EdgeCondition[] {
  const operational: EdgeCondition[] = OPERATIONAL_CONDITIONS.map((on) => ({ on }));
  return [...operational, ...(branches ?? [])];
}

/**
 * Just the BUSINESS branches, as a TRI-STATE: `null` when the source can never
 * emit one at all, distinct from `[]` ("it branches, and offers nothing").
 *
 * The distinction is the property panel's, not the canvas's — `EdgePanel` must
 * HIDE its branch `<optgroup>` for a source that cannot branch, and show an
 * empty one for a `switch` with no cases yet, which a plain list cannot express.
 * It lives here anyway, beside the ports rather than beside that caller, so
 * `declaredBranchesOf` is consulted exactly ONCE per question and the panel's
 * option list and the node's ports are one derivation by construction instead of
 * two that happen to agree.
 */
export function branchConditionsOf(source: Node | undefined): EdgeCondition[] | null {
  if (source === undefined) return null;
  const declared = declaredBranchesOf(source);
  if (declared === undefined) return null;
  /* EMPTY labels are dropped. `declaredBranchesOf` filters `cases` on
     `typeof c === 'string'` only, while `validateSwitchConfig` additionally
     refuses `''` — so a git-imported `cases: ['']` would otherwise render a
     port with no visible text whose id (`branch:`) `decodeConditionValue`
     rejects: a handle that can be grabbed and authors nothing, on a doc the
     save gate refuses anyway. Offering only what a save accepts is this
     module's whole claim. */
  return [...declared]
    .filter((branch) => branch.length > 0)
    .map((branch): EdgeCondition => ({ on: 'branch', branch }));
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
 * The separator joining a node's port ids into ONE primitive.
 *
 * The run monitor's `mergeRunNodes` compares node `data` with a shallow
 * `Object.is` over its keys, and returns the PREVIOUS object when nothing
 * rendered has changed — which is what stops every edge on a live run blinking
 * once per event (`runFlow.ts` records the mechanism). A `SourcePort[]` in that
 * data would be a fresh array on every event and would defeat it for every node.
 * So the run canvas carries the ids as one string and rebuilds the ports from
 * it; a space is safe because `encodeCondition` escapes every character outside
 * `[A-Za-z0-9-_.]`, whitespace included.
 */
const PORT_ID_SEPARATOR = ' ';

/** A node's ports as ONE primitive — see `PORT_ID_SEPARATOR`. */
export function portIdsOf(ports: readonly SourcePort[]): string {
  return ports.map((p) => p.id).join(PORT_ID_SEPARATOR);
}

/**
 * Rebuild the ports a `portIdsOf` string describes.
 *
 * `orphaned` comes back `false` for every port, and that is a deliberate loss
 * rather than an oversight: the flag says "you have authored an edge on an
 * outcome this source no longer offers", which is an AUTHORING fact. The run
 * monitor is read-only and shows an immutable version — there is nothing there
 * to re-offer, and the doc it draws cannot be edited into or out of that state.
 * An id that does not decode is DROPPED rather than drawn as a port routing
 * nothing.
 */
export function portsFromIds(ids: string): SourcePort[] {
  const ports: SourcePort[] = [];
  for (const id of ids.split(PORT_ID_SEPARATOR)) {
    const condition = decodeConditionValue(id);
    if (condition === null) continue;
    ports.push({ id, condition, label: conditionLabel(condition), orphaned: false });
  }
  return ports;
}

/**
 * Which conditions each source's OUTGOING edges already route on.
 *
 * The input to `sourcePortsOf`'s orphan arm, and one helper rather than two
 * because both canvases need exactly this and would otherwise accumulate it
 * identically — the author canvas over the store's working edges, the run
 * monitor over the bound version's. Two copies of a derivation this module
 * exists to keep single is the drift the rest of the file argues against.
 */
export function usedConditionsBySource(
  edges: readonly Edge[],
): ReadonlyMap<string, EdgeCondition[]> {
  const used = new Map<string, EdgeCondition[]>();
  for (const e of edges) {
    const condition = conditionOf(e);
    const list = used.get(e.from);
    if (list === undefined) used.set(e.from, [condition]);
    else list.push(condition);
  }
  return used;
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
export const SOURCE_PORT_PITCH = 14;

/**
 * React Flow's snap radius, reduced from its default 20 for the reason above.
 * Stated here, next to the pitch it is constrained by, rather than inline on the
 * `<ReactFlow>` element where the constraint would be invisible.
 */
export const CONNECTION_RADIUS = 6;

/** The height of a node with no ports at all — the pre-U19 box. */
const BASE_NODE_HEIGHT = 52;

/**
 * React Flow's own handle size, in flow units — its stylesheet draws a 6px dot
 * centred on the node's border.
 *
 * Exported because two things must agree about it: `containerHandles` states a
 * derived box's port bounds in these units, and `nodeBoxHeight` has to leave
 * room for the OUTERMOST dot rather than for its centre.
 */
export const HANDLE_SIZE = 6;

/**
 * U19 slice 2 — the radius of the invisible circle that grabs an edge's END to
 * rewire it (`<ReactFlow reconnectRadius>`, default 10).
 *
 * The geometry is not what it reads like, and getting it wrong in either
 * direction breaks a gesture:
 *
 * The circle is NOT centred on the port. `EdgeUpdateAnchors` places it at
 * `shiftX(centerX, radius, position)` (`@xyflow/react` 12.11.2,
 * index.mjs:2834-2852), i.e. TANGENT to the handle and displaced outward by
 * exactly this radius. So it spans `[edge, edge + 2r]` horizontally while the
 * handle spans `[edge - HANDLE_SIZE/2, edge + HANDLE_SIZE/2]`. Nodes paint above
 * edges, so the handle wins the overlap and what remains grabbable is the
 * crescent beyond it — which is why the LOWER bound matters: at
 * `r <= HANDLE_SIZE / 2` there is no crescent and the edge end cannot be picked
 * up at all, which would look exactly like the feature not working.
 *
 * The UPPER bound is the sibling port. The circle also spans `±r` VERTICALLY
 * about the port's centre, so a radius at or beyond half the pitch would let one
 * edge's grab area reach the next outcome's port and make "start a new edge from
 * `failure`" and "grab the `success` edge" the same pixel.
 *
 * `HANDLE_SIZE / 2 < RECONNECT_RADIUS < SOURCE_PORT_PITCH / 2` — pinned by a
 * test, because both bounds are invisible at the call site.
 */
export const RECONNECT_RADIUS = 6;

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

/**
 * The height a node needs for `portCount` ports at the pitch above.
 *
 * A floor, not a target: four ports at 14px span 42px and already fit the
 * pre-U19 52px box, so an ordinary activity is drawn exactly the size it always
 * was. Only a node that declares MORE than the four operational outcomes — an
 * `if`, a `switch` with cases — grows, and it grows by what its own
 * configuration asked for.
 *
 * Keeping the ordinary node its old size is not cosmetic. `addNode` staggers a
 * freshly-added node by 40px diagonally, so growing every box pushed each new
 * node into the previous one's port column, and thirteen e2e specs that draw a
 * connection between two toolbox-added activities started failing on
 * intercepted pointer events. Node placement is U21/U23's to revisit; U19 must
 * not silently make it worse.
 */
export function nodeBoxHeight(portCount: number): number {
  /* The SPAN of n ports is (n-1) pitches between their centres, plus half a dot
     at each end — not n pitches. Writing it the other way overshot by one pitch
     per node, which is invisible (it is never too SMALL) but made the claim
     above false: four ports would have forced 56px onto a box that fits them
     at 52. */
  const span = portCount === 0 ? 0 : (portCount - 1) * SOURCE_PORT_PITCH + HANDLE_SIZE;
  return Math.max(BASE_NODE_HEIGHT, span);
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
