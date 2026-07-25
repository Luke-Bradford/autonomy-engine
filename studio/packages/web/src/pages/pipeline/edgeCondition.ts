import {
  declaredBranchesOf,
  EdgeOnSchema,
  stableEdgeKey,
  type Edge,
  type EdgeOn,
  type Node,
} from '@autonomy-studio/shared';

/**
 * An edge's CONDITION — the discriminated pair `EdgeSchema` is built on, minus
 * the endpoints. Kept as one value (rather than an `on` plus a loose `branch`)
 * so `branch` can never be set on an operational edge or dropped from a
 * business one: the two fields are one decision, made once.
 */
export type EdgeCondition = { on: EdgeOn } | { on: 'branch'; branch: string };

/**
 * The four OPERATIONAL outcomes, all of them authorable as of U6a.
 *
 * `skipped` was pinned out of the canvas by `AUTHORABLE_EDGE_ON` when #1 F1
 * added it to the engine: the reducer routes a skip (`edgeState` returns
 * `satisfied` for an `on:'skipped'` edge off a skipped source and `impossible`
 * for every other kind, so `completion` deliberately does NOT catch a skip),
 * `EdgeOnSchema` has always carried it and `validatePipelineDoc` has never
 * refused it — nothing could AUTHOR it. That pin was explicitly deferred to
 * this ticket, with a browser check.
 */
export const OPERATIONAL_CONDITIONS: readonly EdgeOn[] = EdgeOnSchema.options;

/** The condition carried by an existing edge. */
export function conditionOf(e: Edge): EdgeCondition {
  return e.on === 'branch' ? { on: 'branch', branch: e.branch } : { on: e.on };
}

/**
 * The visible edge label — the routing key, whatever kind of key it is.
 *
 * A branch edge is labelled by `branch`, NOT by `on`: `on` is the literal
 * string `"branch"` for every arm of every branching node, so labelling by it
 * renders a two-armed `if` as two identical edges and drops the one piece of
 * information (`true`/`false`/case) that says where each arm goes.
 */
export function edgeLabel(e: Edge): string {
  return e.on === 'branch' ? e.branch : e.on;
}

/**
 * The variant class, set on React Flow's edge `<g>`.
 *
 * Keyed on `on` alone, so all arms of one branching node share ONE hue and the
 * LABEL is what distinguishes them — a per-arm colour would need an unbounded
 * palette (a `switch`'s cases are arbitrary strings) and would collide with the
 * operational colours it has to stay distinguishable from.
 */
export function edgeVariantClass(e: Edge): string {
  return `edge-variant-${e.on}`;
}

/**
 * The accessible name for an edge.
 *
 * React Flow renders each edge as `role="img"` (or `role="group"` when
 * focusable) with `aria-label` defaulting to `Edge from X to Y`. Under EITHER
 * role the SVG `<text>` label is not exposed to assistive technology — so
 * without this, the outcome is carried by colour alone, which is exactly what
 * the epic's "non-color status labels" criterion rules out. The visible label
 * and this string are derived from the same `edgeLabel` decision.
 */
export function edgeAriaLabel(e: Edge): string {
  const where = `Edge from ${e.from} to ${e.to}`;
  return e.on === 'branch' ? `${where}, on branch '${e.branch}'` : `${where}, on ${e.on}`;
}

/**
 * The business branch labels the edge's SOURCE declares, or `null` if it
 * declares none.
 *
 * `null` means "this source can never emit a branch" and must HIDE the branch
 * group — distinct from an empty list, which would read as "it branches but
 * offers nothing". `declaredBranchesOf` is the same SSOT `validatePipelineDoc`
 * reads, so every label this offers is one a save accepts, by construction.
 *
 * `source` may legitimately be `undefined`: an edge endpoint can be a CONTAINER
 * id (top-level↔container edges are valid), and a source node can be deleted
 * out from under a selected edge. Degrade to "no branches", never throw.
 */
export function branchOptionsFor(source: Node | undefined): string[] | null {
  if (source === undefined) return null;
  const declared = declaredBranchesOf(source);
  if (declared === undefined) return null;
  // EMPTY labels are dropped. `declaredBranchesOf` filters `cases` on
  // `typeof c === 'string'` only, while `validateSwitchConfig` additionally
  // refuses `''` — so a git-imported `cases: ['']` would otherwise render an
  // option with no visible text whose value (`branch:`) `decodeConditionValue`
  // rejects: a click that silently does nothing, on a doc the save gate refuses
  // anyway. Offering only what a save accepts is this module's whole claim.
  return [...declared].filter((label) => label.length > 0);
}

/**
 * When two edges are THE SAME EDGE for authoring purposes.
 *
 * This is the engine's own `stableEdgeKey` — `(from, to, on, branch)` — plus
 * `back`, and the difference is deliberate rather than an oversight in either
 * place. The engine excludes `back` safely because it only ever keys BACK edges
 * by it: `partitionReadiness` filters on `e.back`, `backBodyByKey` is built only
 * over back-edges, and `bounces[key]` is written only by `fireBackEdges` — so a
 * forward edge and a back edge sharing `(from, to, on, branch)` never meet
 * there. They ARE two distinct, unambiguously runnable edges in a doc, so
 * refusing to author them would refuse something legal.
 *
 * Keeping the widening HERE, rather than in `stableEdgeKey`, is the point:
 * that key is persistence-critical (it indexes `bounces[...]` across saves and
 * reorders, CP1), so an authoring rule must never be a reason to change it.
 * One definition per concern, and this one delegates.
 */
export function authoringEdgeKey(e: Edge): string {
  return `${stableEdgeKey(e)}\x00${e.back === true ? 'back' : 'fwd'}`;
}

/**
 * The encoded conditions ALREADY held by another edge between the same two
 * nodes — the ones `canvasStore.updateEdgeCondition` will refuse, because
 * retyping onto one would mint a duplicate edge.
 *
 * Surfacing them lets the picker disable those options instead of accepting a
 * click and silently reverting: a refusal the operator cannot see is a control
 * that does nothing for no stated reason.
 *
 * The probe is the edge this one WOULD become — the same value the store builds
 * before consulting the key — so the picker and the store cannot disagree about
 * what collides.
 */
export function takenConditions(edges: readonly Edge[], edge: Edge): ReadonlySet<string> {
  const otherKeys = new Set(
    edges.filter((other) => other.id !== edge.id).map((other) => authoringEdgeKey(other)),
  );
  const taken = new Set<string>();
  for (const other of edges) {
    if (other.id === edge.id) continue;
    const condition = conditionOf(other);
    const probe = { ...edge, ...condition } as Edge;
    if (otherKeys.has(authoringEdgeKey(probe))) taken.add(encodeCondition(condition));
  }
  return taken;
}

/** True when retyping `edge` to `condition` would duplicate another edge. */
export function retypeCollides(edges: readonly Edge[], edge: Edge, retyped: Edge): boolean {
  const key = authoringEdgeKey(retyped);
  return edges.some((other) => other.id !== edge.id && authoringEdgeKey(other) === key);
}

/**
 * Tag separating the two arms in a `<select>` option value.
 *
 * A `switch` case label is an ARBITRARY string — `validateSwitchConfig`
 * reserves only `default` — so `cases: ['success']` is a legal, savable doc.
 * With raw values the select would emit two `<option value="success">`, one per
 * arm, and `e.target.value` could not tell them apart: choosing the business
 * branch would silently author the operational outcome instead.
 */
const OP_TAG = 'op:';
const BRANCH_TAG = 'branch:';

/** The `<option value>` for a condition. Injective across both arms. */
export function encodeCondition(c: EdgeCondition): string {
  return c.on === 'branch' ? `${BRANCH_TAG}${c.branch}` : `${OP_TAG}${c.on}`;
}

/**
 * Parse an `<option value>` back to a condition; `null` if it is not one.
 *
 * Only the FIRST delimiter splits, so a case label containing `:` round-trips.
 * An unrecognised operational value is refused rather than cast — the select's
 * value comes from the DOM, and a cast would put an off-enum string straight
 * into the doc.
 */
export function decodeConditionValue(value: string): EdgeCondition | null {
  if (value.startsWith(BRANCH_TAG)) {
    const branch = value.slice(BRANCH_TAG.length);
    return branch.length > 0 ? { on: 'branch', branch } : null;
  }
  if (value.startsWith(OP_TAG)) {
    const parsed = EdgeOnSchema.safeParse(value.slice(OP_TAG.length));
    return parsed.success ? { on: parsed.data } : null;
  }
  return null;
}
