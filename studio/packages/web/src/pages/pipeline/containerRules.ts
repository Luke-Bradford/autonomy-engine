import {
  implicitRouting,
  type Container,
  type Edge,
  type ImplicitRouting,
  type Node,
  type Param,
  type RoutingPartition,
} from '@autonomy-studio/shared';
import { activityLabels } from './activityLabel';
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
 * What a doc's routing was, and what the edit makes it. `null` on either side
 * means routing is AUTHORED — the doc has its own edges, so nothing is inferred
 * (or it has too few nodes to have a sequence at all).
 */
export interface RoutingChange {
  from: ImplicitRouting | null;
  to: ImplicitRouting | null;
}

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
   * HOW FAR IT REACHES, stated rather than left to be discovered: any change to
   * the inferred WALK, not merely to its kind. #840 widened it — the kind-only
   * comparison this replaced was blind to a membership edit on a doc that already
   * had a container, because `implicitRouting` collapsed every such doc to a
   * detail-free `{kind:'partitioned'}` and both sides read the same.
   *
   * A doc with AUTHORED edges still compares as `null` on both sides and reports
   * nothing — not because such an edit is harmless, but because nothing is being
   * inferred for it, so there is no inferred routing to change. A membership move
   * on an authored doc CAN still change readiness without raising an issue
   * (moving an edge-less node into a container gates it on the container). That
   * is a real and separate hole, filed as #877 rather than silently folded in.
   */
  routingChange: RoutingChange | null;
}

function sameFollows(a: RoutingPartition, b: RoutingPartition): boolean {
  if (a.follows.length !== b.follows.length) return false;
  return a.follows.every((f, i) => {
    const g = b.follows[i]!;
    return f.from === g.from && f.to === g.to && f.scope === g.scope;
  });
}

/**
 * Compile-time backstop for the cost named above: adding a field to
 * `RoutingPartition` without comparing it here would silently WITHHOLD a warning,
 * which is the failure mode this whole ticket exists to end. This map has to gain
 * the key before the type checks, which turns a silent omission into a build
 * error at the one place that must not miss one.
 */
const COMPARED_PARTITION_FIELDS: Record<keyof RoutingPartition, true> = {
  roots: true,
  containerRoots: true,
  follows: true,
};

function samePartition(a: RoutingPartition, b: RoutingPartition): boolean {
  void COMPARED_PARTITION_FIELDS;
  const sameChildren =
    a.containerRoots.length === b.containerRoots.length &&
    a.containerRoots.every((c, i) => {
      const d = b.containerRoots[i]!;
      return (
        c.containerId === d.containerId &&
        c.children.length === d.children.length &&
        c.children.every((id, j) => id === d.children[j])
      );
    });
  return (
    a.roots.length === b.roots.length &&
    a.roots.every((id, i) => id === b.roots[i]) &&
    sameChildren &&
    sameFollows(a, b)
  );
}

/**
 * Field-wise rather than `JSON.stringify(a) === JSON.stringify(b)`, and that is
 * this directory's settled position rather than a preference: `sameContainerConfig`
 * (`canvasStore.ts`) REPLACED exactly that comparison, because it made a "did
 * anything change?" question depend on the key order an unrelated module happened
 * to construct its objects in. The same objection applies here — both operands
 * come from `routingPartition` today, but nothing in the type says they must.
 *
 * (An ordering argument would NOT justify this: stringify is just as
 * order-sensitive over arrays as a field-wise walk. The array ordering is a
 * property of `routingPartition`, pinned by its own tests, not of this function.)
 *
 * There is also no shared deep-equal to reach for — `deepEquals` is module-private
 * to the expression functions. The cost of hand-rolling is stated plainly: a new
 * field on `RoutingPartition` is IGNORED here until someone adds it, which would
 * silently withhold a warning. `samePartition` is the one place to change.
 */
function sameRouting(a: ImplicitRouting | null, b: ImplicitRouting | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'chain' && b.kind === 'chain') {
    return a.order.length === b.order.length && a.order.every((id, i) => id === b.order[i]);
  }
  if (a.kind === 'partitioned' && b.kind === 'partitioned') {
    return samePartition(a.partition, b.partition);
  }
  return false;
}

/**
 * The routing half of a container edit's consequence, on its own.
 *
 * Separate from `containerEditConsequence` because `deleteContainer` needs it and
 * cannot use that function: a delete cascades the container's incident EDGES as
 * well, which a `nextContainers`-only signature cannot express, and #840 warns
 * that feeding it the naive `containers.filter(...)` produces a WRONG warning.
 * Exporting the half it can compose with keeps `confirmDeleteContainer`'s own
 * destruction warning specific, which is the separation this module's tail
 * comment argues for.
 *
 * Deliberately NOT short-circuited on `before.edges.length > 0`. That reads like
 * a free optimisation and would silently kill the case this exists for: a delete
 * whose cascade removes the doc's last authored edge flips routing from authored
 * to an inferred chain.
 */
export function routingChangeBetween(
  before: Pick<ContainerEditDoc, 'nodes' | 'edges' | 'containers'>,
  after: Pick<ContainerEditDoc, 'nodes' | 'edges' | 'containers'>,
): RoutingChange | null {
  const from = implicitRouting(before);
  const to = implicitRouting(after);
  return sameRouting(from, to) ? null : { from, to };
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
  return {
    newIssues: after.filter((issue) => !known.has(issue)),
    routingChange: routingChangeBetween(doc, { ...doc, containers: nextContainers }),
  };
}

/**
 * How each container is NAMED to the operator.
 *
 * The kind carries a document-order ordinal within its kind, because the kind
 * alone cannot answer the question every surface here is asking. A PICKER makes
 * that plainest: an operator choosing between two indistinguishable `stage`
 * options cannot tell which box they are about to join. `connectRules` used to
 * accept the bare kind on the grounds that a refusal is transient feedback about
 * one gesture; #883 ended that split — see below.
 *
 * #883 CLOSED the cost this docblock used to state. The ordinal was not DRAWN on
 * the box, so with two loops on screen "loop 2" identified the option but not the
 * rectangle — U23 narrowed that (the ⚙ button's accessible name carries it, so it
 * was addressable to a screen reader and to a spec) without closing it for a
 * SIGHTED operator. `ContainerNode` now renders this label, so the ordinal names
 * the same rectangle in the picker, on the box, and in every refusal.
 *
 * That makes this the single answer to "which container is this", and every
 * surface naming one is expected to read it: `connectRules.endpointLabel`, the
 * membership picker, `readableIssue`, the ⚙ and ✕ buttons, and the delete
 * confirmation. A surface that falls back to the bare kind is not a smaller
 * version of the name — it is a DIFFERENT name for the same box, which is the
 * defect #883 was filed for.
 *
 * The RUN graph reads it too, since #886 — box and announcement together, which
 * is why it was one change and not two. So no surface that names a container
 * falls back to the bare kind any more, and a new one that did would be showing
 * a DIFFERENT name for the same box rather than a smaller version of this one.
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
 *
 * The validator writes an id in FOUR shapes, and each needs its own pass because
 * only one of them is quoted: a leading `container.<id>.` location, a leading
 * `node.<id>`/`nodes.<id>.` one, a brace-wrapped comma list mid-sentence, and a
 * quoted token anywhere. #884 is what a missing pass costs — this function was
 * written against the quoted shape alone, so wiring it into the badge list
 * unchanged would have left the two commonest canvas errors still printing a raw
 * uuid, while looking from the outside like the defect had been fixed.
 *
 * DISPLAY ONLY, and it must stay at the render site. TWO callers read these
 * strings STRUCTURALLY: `ContainerPanel` filters them by matching
 * `container '<id>'` as a raw substring (`ContainerPanel.tsx:143`), and the
 * expression-insert probe takes a set difference against a baseline
 * (`PipelineCanvas.tsx:1144`, `!baseline.includes(issue)`) — in the very file that
 * now calls this function. Both call `validateCanvas` DIRECTLY rather than reading
 * the mapped list, which is what keeps them correct; moving this rewrite inside
 * `validateCanvas` would silently break both.
 */
export function readableIssue(
  issue: string,
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
): string {
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const labels = containerLabels(containers);
  const nodeLabels = activityLabels(nodes);
  const label = (id: string): string | undefined => nodeLabels.get(id) ?? labels.get(id);
  // COUPLING: every pass below reads the validator's MESSAGE FORMAT, not a
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
  // Pass 2 — the NODE half of pass 1, and the reason #884 could not be closed by
  // wiring this function into the badge list unchanged. Every node location in
  // `params.ts` carries the id UNQUOTED too, in two shapes: `node.<id>.<field>`
  // (`:2335` condition, `:2411` message, `:2433`, `:2475`) and a bare `node.<id>`
  // with no field (`:2005`, `:2010`, `:2501`, `:2530`, `:2547`, `:2588`-`:2649`),
  // plus a PLURAL `nodes.<id>.config.…` (`:2676`, `:2770`). Together those are the
  // commonest issue a canvas author meets — a bad ref in a config field — so
  // without this pass the badge list would still have shown a raw uuid.
  //
  // ANCHORED at index 0, and that is load-bearing rather than an optimisation:
  // `${nodes.<id>.output.<name>}` appears in the BODY of those same messages
  // (`:3846`, `:3875`) and is the operator's own expression text — the literal
  // string they must go and edit. Rewriting it would hand them a sentence telling
  // them to fix an expression that does not appear in their config. Every message
  // is built `${where}: …` with `where` first, so the location is always at 0.
  //
  // The trailing dot is captured rather than required because the two shapes
  // punctuate differently: consuming `node.<id>.` leaves `config.url: …` needing a
  // separating space, while consuming a bare `node.<id>` leaves `: …`, which must
  // NOT gain one.
  const nodeLocated = located.replace(
    /^nodes?\.([^.\s:]+)(\.?)/,
    (whole, id: string, dot: string) => {
      const l = nodeLabels.get(id);
      return l === undefined ? whole : `node '${l}'${dot === '' ? '' : ' '}`;
    },
  );
  // Pass 3 — `forwardCycleErrors` (`params.ts:2930`, message at `:2964`) is the one that names
  // ids in NEITHER of the other two shapes: a brace-wrapped comma list, unquoted
  // and mid-sentence (`forward cycle detected involving {n_7c…, n_9c…}`). It is
  // also among the most reachable authoring errors, so leaving it would have
  // falsified this ticket's acceptance on the very doc it was written for.
  //
  // It is NOT the only `{…}` in the message space, and the safety here is stated
  // precisely rather than claimed as structural. A `${…}` expression body matches
  // too, as does prose like `params.ts:2704`'s `an array of {role, content} turns`.
  // Neither is rewritten because no comma-split token in them EQUALS an id — and
  // when nothing resolves, the branch below returns the original substring, so the
  // result is byte-identical rather than merely equivalent. That is data-dependent
  // (a container literally named `role` would be rewritten in that prose), and it
  // is unreachable for canvas-minted ids, which are always `n_`/`c_` uuids.
  const listed = nodeLocated.replace(/\{([^{}]*)\}/g, (whole, body: string) => {
    const parts = body.split(', ');
    const named = parts.map((id) => label(id) ?? id);
    return named.some((name, i) => name !== parts[i]) ? `{${named.join(', ')}}` : whole;
  });
  // Pass 4 — the quoted shape, and the ONLY pass that is global and unanchored.
  // That is deliberate but asymmetric with pass 2, so it is written down: a quoted
  // id appears mid-sentence in real messages (`child '<id>'`, `edge '<id>'`), so it
  // cannot be anchored. The cost is that a quoted token that happens to EQUAL an
  // id is rewritten wherever it sits, including inside an expression body. Not
  // reachable on canvas-minted ids for the same reason as pass 3.
  return listed.replace(/'([^']+)'/g, (whole, id: string) => {
    const direct = label(id);
    if (direct !== undefined) return `'${direct}'`;
    const edge = edgeById.get(id);
    if (edge === undefined) return whole;
    return `'${label(edge.from) ?? edge.from} → ${label(edge.to) ?? edge.to}'`;
  });
}

/**
 * How a routing change is put to the operator, or `null` when there is none.
 *
 * Every arm is QUALITATIVE — it names no activity — and since #878 that is a
 * SCOPE decision rather than the constraint it used to be. The blocker was that
 * `activityLabel` names a TYPE, so "these now start in parallel: HTTP Request,
 * HTTP Request" was a confident claim the operator could not act on;
 * `activityLabels` now mints an identifying name, and `RoutingChange` already
 * carries the ids (`chain.order`, `partition.roots`/`follows`) — so enumerating
 * is a wording change with its own test surface, not a data change. Deferred to
 * #881, deliberately and not for want of the name. Describing the CHANGE stays
 * honest meanwhile; the canvas advisory panel is where the per-activity detail
 * is today.
 *
 * Every arm also ends on what SAVING does, because that is the real cost: the
 * inferred routing is minted into the next version, and a version is immutable.
 */
export function routingSentence(change: RoutingChange | null): string | null {
  if (change === null) return null;
  const { from, to } = change;
  // DEFENSIVE, and reachable from no caller today: `to === null` needs the
  // candidate doc to author edges, which `containerEditConsequence` never adds
  // and `cascadeDeleteContainer` only removes — so every real call with a
  // non-null `from` also has a non-null `to`. Kept because this function is
  // EXPORTED and a future caller (an undo, an import-into-canvas) could produce
  // it, and returning nothing there would be the silent withholding this whole
  // ticket is about. Pinned by a direct unit test rather than left unexercised.
  if (to === null) {
    return (
      'This pipeline now authors its own edges, so its routing is no longer inferred from the ' +
      'order activities were added. Saving mints the authored routing into the next version.'
    );
  }
  if (to.kind === 'chain') {
    return (
      'This pipeline has no authored edges, so its routing is inferred: the activities ' +
      'run as one sequence, in the order they were added. Saving mints that as the next ' +
      "version's routing."
    );
  }
  if (from?.kind === 'partitioned') {
    return (
      'This pipeline has no authored edges, so its routing is inferred from the order activities ' +
      'were added, and its containers split that into parallel roots. This edit changes that ' +
      'inferred routing — which activities start in parallel, and what runs inside each ' +
      'container. Saving mints the changed routing into the next version.'
    );
  }
  return (
    'This pipeline has no authored edges, so its routing is inferred from the order ' +
    'activities were added. A container splits that single sequence into parallel roots — ' +
    'saving mints the split routing into the next version.'
  );
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
  const routing = routingSentence(consequence.routingChange);
  if (routing !== null) parts.push(routing);

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
