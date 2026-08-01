import { getActivity, type Node } from '@autonomy-studio/shared';

/**
 * What KIND of activity this is: its catalog title, keyed on `node.type`.
 *
 * This names a TYPE, not an instance — three `http_request` nodes all answer
 * "HTTP Request". To name a PARTICULAR one, use `activityLabels` below.
 *
 * It stays exported for exactly two uses, and neither is a surface: it is the
 * ingredient `activityLabels` is built from, and it is the total fallback at the
 * two map lookups that feed a canvas (`FlowCanvas`, `runFlow`). Those fallbacks
 * are unreachable by construction — each map is built from the very array being
 * mapped over — so they are there to keep the type total, not to run. No surface
 * names an activity with this any more.
 *
 * One function rather than the expression, because the canvas had grown three
 * hand-rolled copies of it — the node's own label (`FlowCanvas`), a connection
 * refusal's endpoint (`connectRules.endpointLabel`) and a validation issue's
 * identifiers (`containerRules.readableIssue`) — and a message that names an
 * activity differently from the box it points at is worse than one that does not
 * name it at all. Same argument `edgeEndpointIds` was exported under.
 *
 * A type the catalog does not know falls back to the raw type rather than
 * inventing a name: it is what the doc says, and an imported doc can carry one.
 */
export function activityLabel(node: Node): string {
  return getActivity(node.type)?.title ?? node.type;
}

/**
 * How ONE activity is named to the operator (#878): its kind plus a
 * within-kind, document-order ordinal — `HTTP Request 2`.
 *
 * The node-side counterpart to `containerRules.containerLabels`, and the same
 * argument. Until this existed a surface had to choose between a name that does
 * not identify (`activityLabel`, keyed on TYPE) and a raw id that is not
 * readable — `newLocalId` mints `n_7c44a16f-98f1-4958-…` for anything drawn on
 * the canvas, which is the exact unreadable-id defect `readableIssue` and
 * `endpointLabel` were both written against.
 *
 * Every AUTHORING surface reads this, and so do the run monitor's NAMING
 * surfaces — the graph since #878, the node table and the drill-in panel since
 * #882. #884 added the canvas validation badge list, which had never gone
 * through `readableIssue` at all.
 *
 * Two surfaces still show a raw id, for opposite reasons. The run's event feed
 * (`runs/format.ts::eventGloss`) does so BY DESIGN: it is the log's own join key,
 * and it is exactly what the id rendered beside a node's name exists to let an
 * operator match. The pre-edit routing confirmation names no activity at all
 * (#881), which is a gap rather than a decision.
 *
 * The run monitor's two halves resolve this map differently, and the difference
 * is the whole of #882: the graph walks the DOC, so every node it draws has a
 * name, while the table and panel walk the RUN's rows, which are not the same
 * list. A row this map does not name keeps its raw id. That happens when the
 * bound version will not resolve (U11), and — narrowly — when the instance-key
 * fold lands events on a key the doc has no node for; NOT on a rerun, which
 * reuses the run's own immutable version. `RunDetailPage` records the exact
 * case.
 *
 * THE ORDINAL IS DRAWN ON THE BOX, and since #883 the container ordinal is too —
 * so the rule is now uniform rather than an activity-only property with a
 * documented exception. That symmetry is the point, not a tidiness: a sighted
 * operator reading "HTTP Request 2" in a message must be able to match it to one
 * of two otherwise identical rectangles, and a message naming one end by a drawn
 * name and the other by a bare kind is only half readable.
 *
 * The ordinal is UNCONDITIONAL — a lone activity is "HTTP Request 1", exactly as
 * a lone container is "stage 1". Numbering only on collision was considered and
 * rejected: it renames an UNTOUCHED box the moment a second of its kind is added,
 * and the #788 advisory's partitioned arm lists activities and containers in one
 * sentence, where "HTTP Request, stage 1" reads as two different kinds of thing.
 *
 * TWO HONEST COSTS, both shared with `containerLabels`:
 *   - the ordinal is positional, so deleting or reordering an activity renumbers
 *     its siblings. It identifies a box on screen NOW; it is not a stable name to
 *     store, quote in an issue, or key anything on.
 *   - it is DOCUMENT order, not visual order: an imported doc is free to put
 *     "HTTP Request 3" leftmost on the canvas.
 * A stable operator-authored name is a `Node` schema change and is not this.
 *
 * Counted by the RENDERED NAME rather than by `type`, so the result is unique
 * even where two types would render the same word — an imported activity whose
 * raw type equals another's catalog title. That uniqueness is load-bearing: it is
 * what `useExpressionPicker`'s hand-rolled `(id)` suffix used to buy.
 *
 * Lives in `web`, not `shared`, on the authority of `RefSuggestion`'s docblock
 * (`packages/shared/src/engine/params.ts`): naming a node is the web layer's job,
 * and a label computed in `shared` would be a second, drifting answer.
 */
export function activityLabels(nodes: Node[]): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const node of nodes) {
    const kind = activityLabel(node);
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    out.set(node.id, `${kind} ${n}`);
  }
  return out;
}
