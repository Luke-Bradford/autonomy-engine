import {
  getActivity,
  implicitRouting,
  validatePipelineDoc,
  type Container,
  type Edge,
  type Node,
  type Param,
} from '@autonomy-studio/shared';

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
   */
  newIssues: string[];
  /**
   * Non-null when the edit changes what the doc's routing is INFERRED from.
   *
   * This is the consequence no validator reports and no badge shows. On an
   * edge-less doc `implicitRouting` synthesises one success chain in add order —
   * but `containers.length > 0` makes it `partitioned` instead
   * (`engine/params.ts`), so creating the FIRST container silently replaces the
   * sequence the operator was relying on with parallel roots. `validateDoc`
   * accepts both docs and says nothing, because the edges it iterates are
   * synthesised, not authored. Saving mints whichever one is current into an
   * immutable version.
   */
  routingChange: { from: RoutingSource; to: RoutingSource } | null;
}

function routingSource(doc: Pick<ContainerEditDoc, 'nodes' | 'edges' | 'containers'>): RoutingSource {
  return implicitRouting(doc)?.kind ?? 'authored';
}

/**
 * What applying `nextContainers` to `doc` would cost.
 *
 * The issue half is deliberately NOT a hand-written rule set: it diffs
 * `validatePipelineDoc` — the same SSOT the save badge and the server's write
 * gate call (#444) — over the current and candidate docs. So it cannot drift
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
  const before = validatePipelineDoc({
    params: doc.params,
    nodes: doc.nodes,
    edges: doc.edges,
    containers: doc.containers,
  });
  const known = new Set(before);
  const after = validatePipelineDoc({
    params: doc.params,
    nodes: doc.nodes,
    edges: doc.edges,
    containers: nextContainers,
  });
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
 * The honest cost, stated rather than hidden: the ordinal is not drawn on the
 * box, so with two loops on screen "loop 2" identifies the option but not the
 * rectangle. Putting it on the box is a U6c render change; filed as a follow-up
 * rather than smuggled in here.
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
    if (node !== undefined) return getActivity(node.type)?.title ?? node.type;
    return labels.get(id);
  };
  return issue.replace(/'([^']+)'/g, (whole, id: string) => {
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
 */
export function consequenceMessage(
  consequence: ContainerEditConsequence,
  nodes: Node[],
  edges: Edge[],
  nextContainers: Container[],
): string | null {
  const parts: string[] = [];
  const change = consequence.routingChange;
  if (change !== null && change.to === 'partitioned') {
    parts.push(
      'This pipeline has no authored edges, so its routing is inferred from the order ' +
        'activities were added. A container splits that single sequence into parallel roots — ' +
        'saving mints the split routing into the next version.',
    );
  } else if (change !== null && change.to === 'chain') {
    parts.push(
      'This pipeline has no authored edges and no containers left, so its routing falls back ' +
        'to one inferred sequence in the order activities were added — saving mints that into ' +
        'the next version.',
    );
  }
  if (consequence.newIssues.length > 0) {
    const lines = consequence.newIssues.map(
      (issue) => `• ${readableIssue(issue, nodes, edges, nextContainers)}`,
    );
    parts.push(
      'This edit leaves the pipeline unsavable until it is fixed:\n' +
        lines.join('\n') +
        '\n\nYou can undo it by setting the activity back to — none —.',
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join('\n\n')}\n\nApply it anyway?`;
}
