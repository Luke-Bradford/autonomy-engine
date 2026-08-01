import {
  implicitRouting,
  type Container,
  type Edge,
  type Node,
  type Param,
} from '@autonomy-studio/shared';
import { activityLabel } from './activityLabel';
import { validateCanvas } from './canvasDoc';

/**
 * U6d — what a CONTAINER-MEMBERSHIP edit does to the doc, decided before it is
 * applied.
 *
 * The sibling of `connectRules`: those are the rules a connection DRAG is
 * measured against, these are the consequences a membership change is measured
 * against. The difference in POSTURE is deliberate and is the design decision
 * worth reading twice — `connectRules` REFUSES, this only WARNS.
 *
 * A cross-boundary edge is exactly why. Take the commonest doc there is, `a → b`,
 * and ask for a loop around `b`: the edge now has one endpoint inside and one
 * outside, which `validateDoc` refuses. Refusing the membership edit for that
 * reason would make containerising anything already wired IMPOSSIBLE — the only
 * authorable order left would be "delete every edge, create the container, then
 * redraw", and nothing on screen would say so. That is a worse hole than the one
 * U6d exists to close.
 *
 * Warning is safe here in the way it would NOT be for a connection, because a
 * membership edit is REVERSIBLE BY THE SAME CONTROL: the `— none —` option puts
 * the node back, and `deleteContainer` (#748) removes the box while keeping its
 * children. So an edit that leaves the doc invalid is a state the operator can
 * always walk out of, which is what separates it from #748's one-way trap and
 * from #786's un-repairable dangling edge. The validation badge (#444) and
 * `canSave` still stop it reaching an immutable version; this text is what stops
 * the operator being SURPRISED by that.
 */

/** The doc a candidate container edit is measured against. */
export interface ContainerEditDoc {
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
  params: Param[];
}

/**
 * Where a doc's routing comes from. `authored` means real edges (or nothing to
 * route); the other two are `implicitRouting`'s inferred shapes (#788).
 */
export type RoutingSource = 'authored' | 'chain' | 'partitioned';

export interface ContainerEditConsequence {
  /**
   * Validation issues the edit ADDS — issues the doc does not already have.
   * Pre-existing ones are tolerated deliberately: an operator repairing a broken
   * doc must not be blocked by the breakage they are repairing.
   *
   * Matched by exact STRING, which over-reports in one case: an issue whose text
   * merely changes (a boundary error gaining `(child of 'stage 2')` on its far
   * end) reads as new. Kept anyway — the alternative is a coarser key, and a
   * coarser key can MASK a genuinely new issue about the same element, since
   * more than one rule can report the same edge. Over-warning on a doc that is
   * already broken is the safe polarity; silently withholding a warning is not.
   */
  newIssues: string[];
  /**
   * Non-null when the edit changes what the doc's routing is INFERRED from.
   *
   * No VALIDATOR reports this: on an edge-less doc `implicitRouting`
   * synthesises one success chain in add order, but `containers.length > 0`
   * makes it `partitioned` instead (`engine/params.ts`), and `validateDoc`
   * accepts both docs without complaint because the edges it iterates are
   * synthesised, not authored. Saving mints whichever one is current into an
   * immutable version.
   *
   * The canvas is not silent about it — #788's `canvas-advisory` panel
   * (`FlowCanvas`) is a STANDING description of an edge-less graph, and its text
   * changes the moment the first container lands. This is the PRE-HOC half: the
   * panel tells an operator what the graph has become, this tells them what a
   * click is about to do, while they can still decline.
   *
   * HOW FAR IT REACHES, stated rather than left to be discovered: only a change
   * of KIND. `implicitRouting` collapses every containered edge-less doc to a
   * detail-free `{kind:'partitioned'}`, so moving a node in or out of a container
   * that ALREADY exists changes which activities are roots without changing the
   * kind, and fires nothing. Nor does `deleteContainer` removing the last one
   * (that edit does not come through this module at all). Both are #840.
   */
  routingChange: { from: RoutingSource; to: RoutingSource } | null;
}

function routingSource(
  doc: Pick<ContainerEditDoc, 'nodes' | 'edges' | 'containers'>,
): RoutingSource {
  return implicitRouting(doc)?.kind ?? 'authored';
}

/**
 * What applying `nextContainers` to `doc` would cost.
 *
 * The issue half is deliberately NOT a hand-written rule set: it diffs
 * `validateCanvas` — the canvas's single call site into `validatePipelineDoc`,
 * the same SSOT the save badge and the server's write gate call (#444) — over
 * the current and candidate docs. So it cannot drift
 * from what a save would be refused for, and it covers, without restating any of
 * them, cross-boundary forward edges, a loop or foreach emptied below its
 * one-child rule, nested containers, id collisions and `exitWhen`/`items`
 * expression scope.
 *
 * What it does NOT cover is anything the zod layer refuses instead, because
 * `validatePipelineDoc` runs no schema parse and the server parses the body
 * FIRST. `buildContainer` is where that gap is closed, with `ContainerSchema`.
 */
export function containerEditConsequence(
  doc: ContainerEditDoc,
  nextContainers: Container[],
): ContainerEditConsequence {
  const known = new Set(validateCanvas(doc.nodes, doc.edges, doc.containers, doc.params));
  const after = validateCanvas(doc.nodes, doc.edges, nextContainers, doc.params);
  const from = routingSource(doc);
  const to = routingSource({ nodes: doc.nodes, edges: doc.edges, containers: nextContainers });
  return {
    newIssues: after.filter((issue) => !known.has(issue)),
    routingChange: from === to ? null : { from, to },
  };
}

/**
 * How each container is NAMED to the operator.
 *
 * `connectRules.endpointLabel` names a container by its KIND alone — the word
 * its box carries on the canvas — and accepts that two same-kinded containers
 * share a label, because that text is transient feedback about one gesture. A
 * PICKER cannot accept it: an operator choosing between two indistinguishable
 * `stage` options cannot tell which box they are about to join. So the kind
 * carries a document-order ordinal within its kind.
 *
 * The honest cost, stated rather than hidden: the ordinal is not DRAWN on the
 * box, so with two loops on screen "loop 2" identifies the option but not the
 * rectangle. Putting it on the box is a U6c render change, still deferred
 * (#839 part 3).
 *
 * U23 narrowed that cost without closing it. The ⚙ button's accessible name is
 * this label, so the ordinal is now addressable on the box to a screen reader
 * and to a spec, and the container being configured is outlined while its panel
 * is open — but a SIGHTED operator reading the picker still cannot match "loop
 * 2" to a rectangle without clicking one.
 */
export function containerLabels(containers: Container[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const c of containers) {
    const n = (seen.get(c.kind) ?? 0) + 1;
    seen.set(c.kind, n);
    out.set(c.id, `${c.kind} ${n}`);
  }
  return out;
}

/**
 * Rewrite a `validatePipelineDoc` message so a human can read it.
 *
 * The validator quotes raw ids, which `newLocalId` mints as
 * `n_7c44a16f-98f1-4958-…`. Surfacing one verbatim reproduces the exact defect
 * `connectRules.endpointLabel` was written for — literally true and unreadable —
 * in its container form. Only the IDENTIFIERS change; the sentence stays the
 * validator's, so this cannot quietly become a second, drifting set of messages.
 *
 * An edge has no name of its own, so it is named by its ENDS, which is how the
 * operator sees it. A quoted token that resolves to nothing (a kind, a word the
 * validator happened to quote) is left exactly as it was.
 */
export function readableIssue(
  issue: string,
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
): string {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const labels = containerLabels(containers);
  const label = (id: string): string | undefined => {
    const node = nodeById.get(id);
    return node !== undefined ? activityLabel(node) : labels.get(id);
  };
  // COUPLING: both passes below read the validator's MESSAGE FORMAT, not a
  // structured field, so a change to how `validateExitWhen`/`validateForeachItems`
  // (packages/shared/src/engine/params.ts) render a location silently degrades this
  // to raw uuids rather than breaking a type. The pass-1 regex keys on the
  // `container.<id>.` PREFIX only, so it covers both `.exitWhen` and `.items`
  // without naming either; `containerRules.test.ts` pins that prefix. If you change
  // the `where` string in either validator, change this with it.
  //
  // Pass 1 exists because those two build their location as
  // `container.<id>.exitWhen` — the id UNQUOTED, so the quoted-token pass below
  // cannot see it. Those two fields are the ONLY container config the New-container
  // form authors, which makes this the first error a beginner meets: without this
  // pass it arrives as a bare uuid, the exact defect the rest of this function
  // exists to prevent.
  const located = issue.replace(/\bcontainer\.([^.\s]+)\./g, (whole, id: string) => {
    const l = labels.get(id);
    return l === undefined ? whole : `container '${l}' `;
  });
  return located.replace(/'([^']+)'/g, (whole, id: string) => {
    const direct = label(id);
    if (direct !== undefined) return `'${direct}'`;
    const edge = edgeById.get(id);
    if (edge === undefined) return whole;
    return `'${label(edge.from) ?? edge.from} → ${label(edge.to) ?? edge.to}'`;
  });
}

/**
 * The confirmation an edit needs before it is applied, or `null` when it costs
 * nothing worth interrupting for.
 *
 * Composed fresh from live state at the moment of the click and handed straight
 * to `window.confirm`, so there is exactly ONE evaluation and no stored message
 * to go stale — the failure mode `FlowCanvas`'s refusal panel documents (a
 * frozen `role="alert"` naming an activity the operator has since deleted).
 *
 * `nextContainers`, not the current ones, label the issues: a brand-new
 * container appears only in the candidate doc, and an issue naming it would
 * otherwise fall back to its raw uuid.
 *
 * `recovery` is a PARAMETER because the way back out is not the same for both
 * edits, and one hard-coded sentence was actively wrong. "Set the activity back
 * to — none —" undoes a membership change, but following it after CREATING a
 * loop around a wired activity swaps one unsavable doc for a worse one: the loop
 * is left with no children (`makes no progress`) and its `exitWhen` now names a
 * node outside it. The way out of a create is deleting the container. A
 * confirmation that names a recovery which does not recover is worse than one
 * that names none.
 */
export function consequenceMessage(
  consequence: ContainerEditConsequence,
  nodes: Node[],
  edges: Edge[],
  nextContainers: Container[],
  recovery: string,
): string | null {
  const parts: string[] = [];
  const change = consequence.routingChange;
  if (change !== null && change.to === 'partitioned') {
    parts.push(
      'This pipeline has no authored edges, so its routing is inferred from the order ' +
        'activities were added. A container splits that single sequence into parallel roots — ' +
        'saving mints the split routing into the next version.',
    );
  }
  // No `to === 'chain'` arm: no caller SHRINKS the container array
  // (`assignContainerChild` and U23's config edit are length-preserving,
  // `containersWithNew` appends), so a doc can only gain its first container
  // here. Removing the LAST one is `deleteContainer`'s edit (#748), which does
  // not come through this module.

  if (consequence.newIssues.length > 0) {
    const lines = consequence.newIssues.map(
      (issue) => `• ${readableIssue(issue, nodes, edges, nextContainers)}`,
    );
    parts.push(
      'This edit leaves the pipeline unsavable until it is fixed:\n' +
        lines.join('\n') +
        `\n\n${recovery}`,
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join('\n\n')}\n\nApply it anyway?`;
}

/**
 * Measure a container edit's consequence, ask the operator, and report whether
 * to proceed. `true` = apply it.
 *
 * Hoisted out of `ContainerSection` (U6d) when U23 added the second call site.
 * A copy would have been the cheaper edit and the wrong one: this gate decides
 * whether an edit that makes the pipeline UNSAVABLE goes through, and two
 * copies of that decision can drift into disagreeing about what counts — the
 * one thing a pre-hoc warning must never do. One function, one behaviour, both
 * kinds of container edit.
 *
 * `deleteContainer`'s own confirmation (`FlowCanvas.confirmDeleteContainer`) is
 * NOT a caller and should not become one: it warns about what deleting destroys
 * — settings, edges, `${item}` references — which is not a diff of the
 * validator's issues, and folding the two would make each one vaguer.
 */
export function confirmContainerEdit(
  doc: ContainerEditDoc,
  nextContainers: Container[],
  recovery: string,
): boolean {
  const message = consequenceMessage(
    containerEditConsequence(doc, nextContainers),
    doc.nodes,
    doc.edges,
    nextContainers,
    recovery,
  );
  return message === null || window.confirm(message);
}
