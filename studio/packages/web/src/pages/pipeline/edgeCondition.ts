import type { Edge as FlowEdge } from '@xyflow/react';
import {
  conditionLabel,
  conditionOf,
  encodeCondition,
  OPERATIONAL_CONDITIONS,
  TARGET_PORT_ID,
} from './ports';
import {
  EdgeOnSchema,
  MaxBouncesSchema,
  stableEdgeKey,
  type Edge,
  type EdgeOn,
} from '@autonomy-studio/shared';

/**
 * The condition⇄port codec moved to `ports.ts` in U19: a port id and a
 * `<select>` option value are now ONE encoding, and it belongs beside the ports
 * that are its first consumer. Re-exported here so the callers that only ever
 * cared about conditions keep their import path.
 *
 * The dependency runs ONE WAY, `edgeCondition → ports`, and `conditionOf` is in
 * that list because of it. It read more naturally here — it is a fact about an
 * `Edge`, not about a port — but `usedConditionsBySource` calls it, so leaving
 * it here made `ports.ts → edgeCondition.ts` a VALUE import and closed a real
 * runtime cycle, while both files' docblocks asserted there wasn't one. (It
 * happened not to break, because both sides are used inside function bodies
 * rather than at module top level — which is luck, not design, and nothing in
 * `eslint.config.js` would have caught it changing.) What crosses back now is
 * the `EdgeCondition` TYPE alone, which TypeScript erases, so the one-way claim
 * is true of the emitted modules and not just of the intent.
 */
export {
  conditionLabel,
  conditionOf,
  decodeConditionValue,
  encodeCondition,
  OPERATIONAL_CONDITIONS,
} from './ports';

/**
 * An edge's CONDITION — the discriminated pair `EdgeSchema` is built on, minus
 * the endpoints. Kept as one value (rather than an `on` plus a loose `branch`)
 * so `branch` can never be set on an operational edge or dropped from a
 * business one: the two fields are one decision, made once.
 */
export type EdgeCondition = { on: EdgeOn } | { on: 'branch'; branch: string };

/**
 * The visible edge label — the routing key, whatever kind of key it is.
 *
 * A branch edge is labelled by `branch`, NOT by `on`: `on` is the literal
 * string `"branch"` for every arm of every branching node, so labelling by it
 * renders a two-armed `if` as two identical edges and drops the one piece of
 * information (`true`/`false`/case) that says where each arm goes.
 */
export function edgeLabel(e: Edge): string {
  const base = conditionLabel(conditionOf(e));
  // U6e — a back-edge is the one edge whose DIRECTION is not what the arrowhead
  // says: it points at a step that already ran. Marking it in the label rather
  // than with a colour is what keeps it composable with U19's five hues (a
  // back-edge carries an ordinary condition and gets its ordinary colour) and
  // off the one visual channel already spent — `skipped` owns the dash, and a
  // back-edge may legally BE `skipped`. It also puts the bounce cap on the
  // canvas without needing the edge selected, which is the number that decides
  // whether the loop terminates.
  return e.back === true ? `↺ ${base} ×${e.maxBounces ?? '?'}` : base;
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
 * Every value `on` can take, i.e. every edge VARIANT the canvas must have a hue
 * and an arrowhead for. `EdgeOnSchema.options` plus the `branch` discriminant,
 * which is not one of them (`EdgeOnSchema` is the four OPERATIONAL outcomes).
 *
 * One list, so the marker defs, the CSS hue rules and the palette guard cannot
 * disagree about how many variants exist — a fifth engine outcome then shows up
 * as a failing test rather than as an unstyled edge with no arrowhead.
 */
export const EDGE_VARIANTS: readonly Edge['on'][] = [...EdgeOnSchema.options, 'branch'];

/**
 * The `<marker>` id for an edge's arrowhead (U6b).
 *
 * Keyed on `on` exactly like `edgeVariantClass`, because the arrowhead carries
 * the same hue as the stroke it caps.
 *
 * A STRING marker id (rather than React Flow's `{ type: MarkerType.ArrowClosed }`
 * object form) is what makes this possible. Precisely: `getMarkerId` returns a
 * string marker's ID verbatim — RF still wraps it as `url('#<id>')` on the path —
 * and it generates a `<marker>` def only for the OBJECT form. So a string id
 * points at a marker the canvas must define itself (`EdgeMarkers`), and
 * `connect-validation.spec.ts` asserts the rendered `marker-end` attribute
 * because that wrapping is RF's behaviour, not ours to unit-test.
 *
 * The reason is NOT that RF's object form cannot carry a custom property. It was
 * written here as "a `fill="var(--success)"` presentation attribute does not
 * resolve", and that claim is FALSE — measured in Chromium, an attribute-form
 * `fill="var(--success)"` computes to `rgb(88, 214, 141)` exactly like the CSS
 * form. Recorded because a false reason invites the next author to "simplify"
 * this away on the strength of disproving it.
 *
 * The real reason is where the condition → hue MAPPING lives. RF generates one
 * def per literal `color` string it is handed, so the object form needs that
 * string in the edge derivation — i.e. a `color: 'var(--success)'` per condition
 * in TSX, beside the `.edge-variant-*` rules in CSS that already express the same
 * mapping and that `palette.test.ts` guards (including the light-mode
 * overrides). One mapping, in the stylesheet that owns the palette.
 */
export function edgeArrowMarkerId(e: Pick<Edge, 'on'>): string {
  return `edge-arrow-${e.on}`;
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
  const on = e.on === 'branch' ? `on branch '${e.branch}'` : `on ${e.on}`;
  // The `↺ … ×N` glyph in `edgeLabel` is not readable text, and the SVG <text>
  // label is not exposed under RF's own role anyway — so back-ness and the cap
  // have to be SPELLED here or they are colour-and-symbol only.
  if (e.back !== true) return `${where}, ${on}`;
  /* A MISSING cap is reported as missing, in the same words the visual label's
     `×?` stands for — not as `0`. Zero is a real and DIFFERENT value (an edge
     that never bounces), so defaulting to it would state a specific behaviour
     for a doc that declares none, and would state a different one to a screen
     reader than the canvas shows. Reachable only for an imported or API-authored
     doc — the canvas always sets a cap — and that doc is refused by the save
     gate, which is a fact worth being able to hear rather than one to paper over. */
  return e.maxBounces === undefined
    ? `${where}, back-edge ${on}, no bounce cap declared`
    : `${where}, back-edge ${on}, up to ${e.maxBounces} bounces`;
}

/**
 * The bounce cap a NEWLY drawn back-edge carries (U6e).
 *
 * A back-edge with no `maxBounces` is refused by the save gate — an unbounded
 * loop never terminates — so authoring one without a cap would mint an edge the
 * operator cannot save and, on an IMMUTABLE version, cannot repair later. Ten
 * is a working retry budget rather than a claim about the right number; the
 * `EdgePanel` field exists precisely because the right number is per-pipeline.
 *
 * Well under `fireBackEdges`' `DEFENSIVE_BOUNCE_CAP` (10 000), which silently
 * clamps anything above it.
 */
export const DEFAULT_MAX_BOUNCES = 10;

/**
 * Whether `n` is a value `maxBounces` can hold.
 *
 * Delegates to `MaxBouncesSchema` rather than restating its constraints, so a
 * tightening of the format propagates to this editor instead of leaving the
 * canvas accepting a value the write gate refuses — on an IMMUTABLE doc, where
 * that is unrepairable. Zero is legal, and an editor that refused it would be
 * an editor that cannot accept back a value the format persists.
 */
export function isMaxBounces(n: number): boolean {
  return MaxBouncesSchema.safeParse(n).success;
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
 * #1064 — which FORWARD pair an edge belongs to, for the overlap rule below.
 *
 * `null` for a back-edge, and that exemption is the rule's scope rather than a
 * gap in it. Forward edges from one predecessor are OR'd (`computeReadiness`
 * groups them by source), which is what makes `success` + `failure` the same
 * thing as `completion`. Back-edges are not grouped at all: `fireBackEdges`
 * bounces each one on its own counter (`stableEdgeKey` includes `on`) under its
 * own `maxBounces`, so a `success` back-edge capped at 3 beside a `failure` one
 * capped at 1 says something no single `completion` back-edge can.
 */
export function forwardPairKey(e: Pick<Edge, 'from' | 'to' | 'back'>): string | null {
  return e.back === true ? null : `${e.from}\x00${e.to}`;
}

/**
 * #1064 — the operational outcomes a forward pair ALREADY routes on that
 * `candidate` would overlap. Empty means no overlap.
 *
 * Operator intent (2026-08-13): *"a success and failure is a completion."* The
 * reducer agrees — see `forwardPairKey` — so between the same two activities:
 *
 * - a `success` or `failure` edge beside a `completion` one adds nothing, since
 *   `completion` already fires on both;
 * - a `completion` edge beside a `success` or `failure` one re-states it.
 *
 * `success` + `failure` together stays LEGAL: each is a narrower intent, and
 * the pair is only redundant once both are present — which is what the Edge
 * panel's "one completion edge" offer is for, rather than a refusal of whichever
 * was drawn second. `skipped` overlaps nothing (a skip is NOT a completion,
 * `EdgeOnSchema`), and neither does a business `branch`.
 *
 * NOT A CORRECTNESS RULE. The OR grouping means a redundant edge neither
 * double-activates its target nor deadlocks it. What it costs is legibility:
 * one intent with three spellings, carried into every export, diff and review
 * of the doc. So this judges CANDIDATES only — a stored doc that already holds
 * redundant edges loads, validates and runs unchanged.
 */
export function overlappingOutcomes(
  pairOutcomes: ReadonlySet<EdgeOn>,
  candidate: EdgeCondition,
): EdgeOn[] {
  if (candidate.on === 'completion') {
    return COVERED_BY_COMPLETION.filter((on) => pairOutcomes.has(on));
  }
  if (candidate.on === 'success' || candidate.on === 'failure') {
    return pairOutcomes.has('completion') ? ['completion'] : [];
  }
  return [];
}

/** The outcomes `completion` fires on — `EdgeOnSchema`'s own definition of it. */
const COVERED_BY_COMPLETION: readonly EdgeOn[] = ['success', 'failure'];

/**
 * Each forward pair's operational outcomes, keyed by `forwardPairKey`.
 *
 * One builder for both readers — the connect precheck and `takenConditions` —
 * so the gesture and the Edge panel cannot come to disagree about what a pair
 * already holds.
 */
export function outcomesByForwardPair(
  edges: readonly Edge[],
): ReadonlyMap<string, ReadonlySet<EdgeOn>> {
  const byPair = new Map<string, Set<EdgeOn>>();
  for (const e of edges) {
    const key = forwardPairKey(e);
    if (key === null || e.on === 'branch') continue;
    let held = byPair.get(key);
    if (held === undefined) {
      held = new Set();
      byPair.set(key, held);
    }
    held.add(e.on);
  }
  return byPair;
}

/**
 * The encoded conditions this edge CANNOT be retyped to, each with the reason —
 * the ones `canvasStore.rewireEdge` will refuse.
 *
 * Two reasons, both judged by the predicates `connectRejection` uses:
 * - another edge between the same two nodes already holds it (a retype would
 *   mint a duplicate — `authoringEdgeKey`);
 * - #1064, it overlaps an outcome the pair already routes on
 *   (`overlappingOutcomes`).
 *
 * Surfacing them lets the picker disable those options instead of accepting a
 * click and silently reverting: a refusal the operator cannot see is a control
 * that does nothing for no stated reason. The reason is TEXT inside the label,
 * so it is in the radio's accessible name rather than carried by disabled-ness
 * alone.
 *
 * The probe is the edge this one WOULD become — the same value the store builds
 * before consulting the key — so the picker and the store cannot disagree about
 * what collides.
 */
export function takenConditions(edges: readonly Edge[], edge: Edge): ReadonlyMap<string, string> {
  const others = edges.filter((other) => other.id !== edge.id);
  const otherKeys = new Set(others.map((other) => authoringEdgeKey(other)));
  const taken = new Map<string, string>();
  for (const other of others) {
    const condition = conditionOf(other);
    const probe = { ...edge, ...condition } as Edge;
    if (otherKeys.has(authoringEdgeKey(probe))) {
      taken.set(encodeCondition(condition), 'already used by another edge');
    }
  }
  const pair = forwardPairKey(edge);
  const held = pair === null ? undefined : outcomesByForwardPair(others).get(pair);
  if (held === undefined) return taken;
  for (const on of OPERATIONAL_CONDITIONS) {
    const value = encodeCondition({ on });
    if (taken.has(value)) continue;
    const overlap = overlappingOutcomes(held, { on });
    if (overlap.length > 0) taken.set(value, overlapReason(on, overlap));
  }
  return taken;
}

/** The Edge panel's short form of an overlap — the connect refusal says more. */
function overlapReason(on: EdgeOn, overlap: readonly EdgeOn[]): string {
  return on === 'completion'
    ? `would repeat the ${overlap.join(' and ')} ${overlap.length > 1 ? 'edges' : 'edge'}`
    : 'already covered by the completion edge';
}

/**
 * #1064 — the sibling a forward `success`/`failure` edge can be COLLAPSED with
 * into one `completion` edge, or `null`.
 *
 * `success` + `failure` between the same two activities IS `completion`
 * (`overlappingOutcomes`), so the panel offers the one-edge spelling as ONE act
 * (one undo step) instead of leaving the operator to find the order that works:
 * retyping either edge to `completion` first is refused, because it would sit
 * beside the other.
 */
export function completionSibling(edges: readonly Edge[], edge: Edge): Edge | null {
  if (edge.on !== 'success' && edge.on !== 'failure') return null;
  const pair = forwardPairKey(edge);
  if (pair === null) return null;
  /* A stored doc can hold all three (authored before the rule, imported, or a
     copy of either). Retyping onto `completion` there would mint a DUPLICATE
     of the completion edge already on the pair — the collapse is not the
     repair for that shape, deleting the two narrower edges is. */
  if (outcomesByForwardPair(edges).get(pair)?.has('completion') === true) return null;
  const want: EdgeOn = edge.on === 'success' ? 'failure' : 'success';
  return edges.find((e) => e.id !== edge.id && e.on === want && forwardPairKey(e) === pair) ?? null;
}

/**
 * One doc `Edge` → the React Flow edge both canvases draw.
 *
 * The author canvas and the run monitor render the SAME edges and must never
 * disagree about them. The leaf rules below (hue class, label, arrowhead def,
 * aria label) were already shared; the COMPOSITION was not — which ports an
 * edge names, and how U6e's additive `edge-back` class stacks on the condition's
 * own hue, existed as two copies. That is the part a future edge property would
 * be added to twice.
 *
 * Interaction is deliberately NOT set here: the author canvas spreads
 * `selected`, the monitor spreads `selectable: false`/`focusable: false`. Those
 * are the two views' own business; everything ABOUT THE EDGE is this function's.
 */
export function toFlowEdge(e: Edge): FlowEdge {
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    /* U19 — the edge names the port of its OWN outcome, which is now one of
       several on the source. Naming it explicitly was always required: React
       Flow's "first handle of this type" fallback is what silently mis-attaches
       every edge the moment a node has two source handles, and this is that
       moment. An edge whose condition has no matching port is drawn as NOTHING
       (no error, no warning) — `sourcePortsOf` keeps an orphan port for exactly
       that case, and `edgeCondition.test.ts` pins the two together. */
    sourceHandle: encodeCondition(conditionOf(e)),
    targetHandle: TARGET_PORT_ID,
    label: edgeLabel(e),
    /* U6e — `edge-back` is ADDITIVE, and deliberately carries no style of its
       own. A back-edge holds an ordinary condition, so it keeps that
       condition's hue; the two channels that could have encoded it are both
       spent or reserved — `skipped` owns the dash and a back-edge may legally
       BE `skipped`, and a sixth `edge-variant-*` would break `EDGE_VARIANTS`'
       typing, its marker defs and the exact-match palette guard. Back-ness is
       stated in the LABEL and the aria-label instead. This is a semantic hook:
       a stable selector for the e2e spec, and the seam U19 can style through
       without re-deriving the fact. */
    className: `${edgeVariantClass(e)}${e.back === true ? ' edge-back' : ''}`,
    // U6b — the arrowhead, so direction is on screen rather than inferred from
    // which side the endpoints happen to sit on. A STRING marker id references
    // one of `EdgeMarkers`' own defs (RF's object form would need a literal
    // colour, and these hues are custom properties).
    markerEnd: edgeArrowMarkerId(e),
    // RF renders an edge as role="img"/"group"; under either, the SVG <text>
    // label is NOT exposed, so without this the outcome is colour-only.
    ariaLabel: edgeAriaLabel(e),
  };
}
