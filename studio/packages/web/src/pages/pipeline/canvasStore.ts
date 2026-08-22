import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  ContainerSchema,
  formatZodIssues,
  getActivity,
  authorsCallBlob,
  lowerPipelineNodes,
  remapNodeRefs,
  type CallConfig,
  type Container,
  type ContainerKind,
  type Edge,
  type Node,
  type Output,
  type Param,
  type PipelineVersion,
  type Position,
} from '@autonomy-studio/shared';
import { newLocalId } from '../../lib/ids';
import {
  conditionOf,
  DEFAULT_MAX_BOUNCES,
  encodeCondition,
  isMaxBounces,
  type EdgeCondition,
} from './edgeCondition';
import { connectRejection, edgeEndpointIds, precomputeConnect } from './connectRules';
import { blankOutput, blankParam } from './paramRules';
import { readClipboard, writeClipboard } from './clipboard';

/** How a connection differs from an ordinary forward edge (U6e). */
export interface ConnectOptions {
  /**
   * Author a BACK-EDGE: a loop traversal edge that is not part of the forward
   * graph. Set only by the canvas's back-edge OFFER — never by a drag, which
   * always proposes a forward edge.
   */
  back?: boolean;
}

/**
 * What the property panel is currently editing.
 *
 * `container` is NOT driven by React Flow. A container node is deliberately
 * `selectable: false` — RF writes `pointer-events: all` on a selectable node's
 * wrapper, and a container's wrapper spans a REGION of the canvas, so the box
 * would swallow every pane click aimed between its children (mutation-proved by
 * `e2e/container-rendering.spec.ts`). A container is selected only by the
 * explicit button on its box, and cleared only by an UNMODIFIED pane click or
 * by its own deletion — never by `nextSelection`, which speaks for RF.
 *
 * #949 added the "unmodified" qualifier: a pane click carrying a multi-select
 * modifier is a no-op for every kind, so it does not clear a container either.
 * See `FlowCanvas`'s `pendingPaneClear` for why that needed more than a branch.
 */
export interface Selection {
  kind: 'node' | 'edge' | 'container';
  id: string;
}

/** Do two selections name the same element? `null` equals only `null`. */
export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.id === b.id;
}

/**
 * Do two selections hold the same MEMBERS? Order-insensitive, because order
 * carries no meaning — React Flow reports a marquee's members in its own
 * internal order, and a reordered report of the same set must not count as a
 * change (see `setSelection`, which guards the write with this).
 */
export function sameSelectionSet(a: Selection[], b: Selection[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x) => b.some((y) => sameSelection(x, y)));
}

/**
 * The ONE selected element, or `null` when zero or many are.
 *
 * "Many" is deliberately null rather than the first member: the property panel
 * edits ONE subject, and picking a winner out of a marquee would silently point
 * the editor at an arbitrary node. Two selected is its own state, and the panel
 * says so (U21).
 */
export function singleSelection(selected: Selection[]): Selection | null {
  return selected.length === 1 ? selected[0]! : null;
}

/**
 * #737/U21 — the next selection SET after React Flow reports that `target`
 * became (or stopped being) selected.
 *
 * The canvas mirrors RF's selection into the store one `select` CHANGE at a
 * time, so this is decided per element and folded across the batch. RF emits a
 * select and the matching deselects together and across BOTH element kinds:
 * `addSelectedNodes` calls `triggerNodeChanges` and then
 * `triggerEdgeChanges(getSelectionChanges(edgeLookup, …))`, so selecting node A
 * arrives as `{A, selected:true}` followed by a `selected:false` for every other
 * node AND every edge.
 *
 * #737 needed a DESELECT guard for that, because a single slot could not tell
 * "clear me" from "clear one of the others" — clearing on any deselect undid the
 * selection microseconds after making it. A set does not need the guard: a
 * deselect removes exactly its own member and the rest stand. That is also what
 * makes a marquee work, where the batch is N selects with no deselect at all.
 *
 * Returns the CURRENT array by reference when nothing changed. That identity is
 * load-bearing, not an optimisation — see `setSelection`.
 */
export function nextSelection(
  current: Selection[],
  target: Selection,
  selected: boolean,
): Selection[] {
  if (!selected) {
    const rest = current.filter((s) => !sameSelection(s, target));
    return rest.length === current.length ? current : rest;
  }
  if (current.some((s) => sameSelection(s, target))) return current;
  return [...current, target];
}

/**
 * Enforce the one structural rule of a selection SET: a `container` is
 * EXCLUSIVE — it never shares the set with a node or an edge.
 *
 * A container is not a React Flow selection at all (see the `Selection`
 * docblock above), so a mixed set would carry a member that group-move cannot
 * move, that RF can never deselect, and that the delete path has to
 * special-case. Non-containers WIN, because the only way to reach a mixed set
 * is to select a node while a container was selected — RF's gesture is the new
 * intent, and the container was merely still standing.
 *
 * Lives HERE, applied by `setSelection`, rather than in `nextSelection`: the
 * setter owns the state, so the invariant holds for EVERY writer instead of
 * only for the one caller that remembered it. `nextSelection` folds React Flow
 * changes, and RF never reports a container (the change seam filters container
 * ids out before it), so it has no business deciding this.
 */
export function containerExclusive(next: Selection[]): Selection[] {
  const others = next.filter((s) => s.kind !== 'container');
  if (others.length === next.length) return next;
  if (others.length === 0) return next.slice(0, 1);
  return others;
}

/**
 * Retype an edge to a new condition, operational or business.
 *
 * Both directions rewrite the `branch` key rather than merging it: an
 * operational edge routes by `on` alone, so a leftover `branch` would strand a
 * key the edge no longer routes by (and fail `EdgeSchema` — the union has no
 * operational member carrying one); a branch edge REQUIRES the key. Narrowing
 * on the `on` discriminant first is what makes `branch` destructurable without
 * a cast; the rest-spread (rather than an explicit field list) carries
 * `back`/`maxBounces` and any future `edgeBase` field through untouched.
 */
function retypeEdge(e: Edge, condition: EdgeCondition): Edge {
  let base: Omit<Edge, 'on' | 'branch'>;
  if (e.on === 'branch') {
    const { branch, on, ...rest } = e;
    void branch; // discard: lint has no ignoreRestSiblings/varsIgnorePattern here
    void on;
    base = rest;
  } else {
    const { on, ...rest } = e;
    void on;
    base = rest;
  }
  return { ...base, ...condition };
}

/**
 * Remove `nodeId` from every container's `children` (#746).
 *
 * Lives HERE rather than in `canvasDoc.ts` (where it was first written) because
 * this module owns graph mutation, and `canvasDoc` imports the API layer for
 * `PipelineVersionWrite` — importing it from the store inverted the layering,
 * dragging zod schemas and `apiFetch` into the domain store for a function that
 * is pure `Container[] -> Container[]`. Exported for its own tests and for U6d
 * (`containersWithNew` builds on it),
 * the same reason `sameSelection`/`nextSelection` are.
 *
 * Copy-on-write at both levels — a container that does not list the id comes
 * back BY REFERENCE, and so does the whole array when no container listed it.
 * Stated honestly, because the first version of this comment named two
 * consumers that turned out not to depend on it: NOTHING relies on this today.
 * `FlowCanvas` memoises the boxes on `[containers, flowNodes, …]`, and a delete
 * always rebuilds `flowNodes` into a fresh array, so the boxes re-derive either
 * way; `PipelineCanvas`'s save-race check tests `nodes` first, which a delete
 * always changes too. It is the reducer's own idiom (`reduce.ts`'s children
 * filter, which neutralizes both non-node children and duplicate-owner ones),
 * it is free, and it means a future consumer CAN rely on identity — but no
 * present behaviour turns on it.
 *
 * Prunes ONE id, deliberately, rather than "every child that is not a node". A
 * general normalise would also silently repair LEGACY phantoms in a doc the
 * operator never touched, hiding `container 'X': child 'Y' is not a node in this
 * pipeline` — a real defect report about a doc that arrived broken.
 */
export function pruneContainerChild(containers: Container[], nodeId: string): Container[] {
  let changed = false;
  const next = containers.map((c) => {
    const kept = c.children.filter((ch) => ch !== nodeId);
    if (kept.length === c.children.length) return c;
    changed = true;
    return { ...c, children: kept };
  });
  return changed ? next : containers;
}

/**
 * U6d — move `nodeId` into `containerId`, or out of every container when it is
 * `null`.
 *
 * The sibling of `pruneContainerChild`, and here for the same layering reason:
 * this module owns graph mutation. Written as ONE pass over every container
 * rather than "remove from the old, add to the new" so DISJOINTNESS is a
 * property of the function rather than of its caller — `containerMembership`
 * resolves a doubly-listed child FIRST-wins (#492) and `validateDoc` refuses the
 * doc, so a partial move is a defect that renders as a coherent picture.
 *
 * Returns the SAME array when nothing changed, so the caller can skip a
 * `dirty`-setting write for an edit that is a no-op (re-picking the container a
 * node is already in).
 */
export function assignContainerChild(
  containers: Container[],
  nodeId: string,
  containerId: string | null,
): Container[] {
  let changed = false;
  const next = containers.map((c) => {
    const shouldHold = c.id === containerId;
    const holds = c.children.includes(nodeId);
    if (shouldHold === holds) return c;
    changed = true;
    return shouldHold
      ? { ...c, children: [...c.children, nodeId] }
      : { ...c, children: c.children.filter((ch) => ch !== nodeId) };
  });
  return changed ? next : containers;
}

/**
 * Are these two containers the same, field for field?
 *
 * Order-INSENSITIVE, unlike the `JSON.stringify(a) === JSON.stringify(b)` this
 * replaces. That comparison was correct for every path that can reach it today
 * — `assembleConfig` builds from `{ ...original }` and assigns in place, so key
 * order is preserved by construction — but it made a "did anything change?"
 * question depend on a property of an unrelated module's object construction.
 * The failure it invited is quiet: a no-op Apply marks the canvas dirty, and an
 * unchanged graph that reports itself as edited is how an unsaved-changes prompt
 * loses the operator's trust.
 *
 * Per-key `Object.is` first, and that is the case that actually fires: every key
 * no form field owns is copied by REFERENCE from the original, so untouched
 * values — `children`, and any key a git-imported container carries that this
 * schema version does not know about — are reference-identical. The
 * `JSON.stringify` fallback is only reached for a key whose value the form
 * rewrote, which is a primitive.
 */
function sameContainerConfig(a: Container, b: Container): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  return keys.every(
    (k) => (k in rb && Object.is(ra[k], rb[k])) || JSON.stringify(ra[k]) === JSON.stringify(rb[k]),
  );
}

/**
 * The containers array a doc would have once `container`'s config is applied.
 *
 * The third member of the family `assignContainerChild`/`containersWithNew`
 * belong to, and exported for the same reason they are: the panel measures an
 * edit's consequence against the array this returns, and the store COMMITS the
 * same array. One function, so the doc the operator was warned about and the
 * doc that lands cannot come to disagree.
 *
 * Length-preserving, unlike its two siblings — which is why
 * `consequenceMessage` can still assume no caller shrinks the array.
 * Copy-on-write: an array holding no container of that id comes back by
 * reference.
 */
export function containersWithUpdated(containers: Container[], container: Container): Container[] {
  if (!containers.some((c) => c.id === container.id)) return containers;
  return containers.map((c) => (c.id === container.id ? container : c));
}

/**
 * The containers and edges a `deleteContainer` would leave behind.
 *
 * Exported so the CONFIRMATION and the ACTION read one rule (#847's anti-pattern
 * is a second reader of a rule like this). The delete cascades incident edges as
 * well as removing the box, and #840 records what a second reader costs here
 * specifically: a confirmation computing its candidate doc as the naive
 * `containers.filter(...)` would keep the cascaded edges and describe routing the
 * delete does not produce — a WRONG warning, which is worse than none.
 *
 * The children are deliberately absent from the cascade; `deleteContainer`'s own
 * docblock argues why they survive. Selection repair and the `dirty` flag stay in
 * the action: they are store bookkeeping, not part of the doc this describes.
 */
export function cascadeDeleteContainer(
  doc: { containers: Container[]; edges: Edge[] },
  id: string,
): { containers: Container[]; edges: Edge[] } {
  return {
    containers: doc.containers.filter((c) => c.id !== id),
    edges: doc.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

/** The containers array a doc would have once `container` is added to it. */
export function containersWithNew(containers: Container[], container: Container): Container[] {
  let next = containers;
  // A new container's children leave whatever container held them — same
  // disjointness invariant `assignContainerChild` keeps, applied at birth.
  for (const child of container.children) next = pruneContainerChild(next, child);
  return [...next, container];
}

/**
 * Build the container a "New container" form describes, or say why it cannot.
 *
 * The zod parse is the load-bearing half, and it is NOT redundant with the
 * canvas's validation badge. `validatePipelineDoc` runs no schema parse, and the
 * server parses the request body BEFORE reaching that gate — so a `maxRounds` of
 * `0` or `1.5` (or a cleared numeric input, which `Number('')` reads as `0`)
 * passes every canvas check, enables Save, and comes back as a raw zod `400`
 * with no badge naming the cause. Refusing it here is the same shape as
 * `NodePanel.apply` validating an edited config blob against the activity's
 * `configSchema` before it can reach the store.
 *
 * Only the fields a VALID doc requires are accepted (`exitWhen` for a loop,
 * `items` for a foreach) plus `maxRounds`, which caps an otherwise unbounded
 * loop. The rest of `ContainerSchema` — `timeout`, `join`, `batchCount`, and
 * editing any of them after creation — is U23's container-config form.
 */
export function buildContainer(
  kind: ContainerKind,
  firstChildId: string,
  config: { exitWhen?: string; maxRounds?: number; items?: string },
): { container: Container } | { error: string } {
  const candidate = {
    id: newLocalId(kind),
    kind,
    children: [firstChildId],
    ...(config.exitWhen !== undefined && config.exitWhen !== ''
      ? { exitWhen: config.exitWhen }
      : {}),
    ...(config.maxRounds !== undefined ? { maxRounds: config.maxRounds } : {}),
    ...(config.items !== undefined && config.items !== '' ? { items: config.items } : {}),
  };
  const parsed = ContainerSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: formatZodIssues(parsed.error.issues, kind),
    };
  }
  return { container: parsed.data };
}

/** The doc a clone is grafted onto — the live graph, plus its stagger counter. */
interface CloneTarget {
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
  addCount: number;
}

/** What a clone produced: the WHOLE new lists, plus the ids that are new. */
interface CloneResult {
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
  newIds: string[];
}

/**
 * U21 — graft a COPY of `sources` (plus the edges between them) onto `target`.
 *
 * The ONE cloning path: `duplicateNode`, duplicate-selection and paste all go
 * through here so they cannot drift on the four rules that make a copy a legal
 * doc rather than a plausible-looking one.
 *
 * 1. **References follow the copies.** `remapNodeRefs` rewrites every
 *    `${nodes.<id>}` naming a member of the copied set to that member's copy.
 *    A ref naming a node OUTSIDE the set is left alone — it still resolves, and
 *    pointing at the same upstream is what "another one of these" means. This is
 *    also the single deep clone: `remapNodeRefs` returns a fresh structure, so
 *    `config` (an arbitrarily nested `z.record`) is never shared with the source.
 *
 * 2. **Internal edges are copied VERBATIM, not re-offered to `connectRejection`.**
 *    An edge between two copies with identical container membership is not new
 *    authoring — it is a structural copy of a decision the doc already records,
 *    so the gate's answer is the one already on file. Re-offering it would drop
 *    it SILENTLY where it disagrees (a container-boundary edge is legal today
 *    because U6d WARNS rather than refuses on a membership edit), and the copy's
 *    freshly-remapped ref would then have no upstream and refuse to save — a
 *    paste that reported success producing an unsavable doc. Copying it verbatim
 *    can at worst carry a defect the save gate and the validation badge report
 *    LOUDLY, which is the direction this repo errs in everywhere else.
 *
 * 3. **External in-edges are re-derived from the LIVE graph** and DO go through
 *    the gate, because their target genuinely is a new node. Without them a copy
 *    whose config references an un-copied upstream has no upstream in scope and
 *    `validateRefs` refuses the save. Re-deriving (rather than carrying them on
 *    the clipboard) is what makes ⌘V and ⌘D agree, and it drops an edge whose
 *    source has since been deleted instead of resurrecting it.
 *
 * 4. **Container membership is re-derived from the LIVE containers** by SOURCE
 *    id, for the same reason: a clipboard written before the container was
 *    deleted must not put its copies back into a container that is gone.
 *
 * The stagger is computed ONCE per gesture, not per node, so a copied subgraph
 * keeps its internal layout — the one thing a group paste has to preserve.
 */
function cloneNodesInto(target: CloneTarget, sources: Node[], internalEdges: Edge[]): CloneResult {
  const idMap = new Map(sources.map((n) => [n.id, newLocalId('n')]));
  const offset = 40 + (target.addCount % 5) * 40;

  const copies: Node[] = sources.map((source) => ({
    ...remapNodeRefs(source, idMap),
    id: idMap.get(source.id) as string,
    position: { x: source.position.x + offset, y: source.position.y + offset },
  }));

  let containers = target.containers;
  for (const source of sources) {
    const owner = containers.find((c) => c.children.includes(source.id))?.id ?? null;
    containers = assignContainerChild(containers, idMap.get(source.id) as string, owner);
  }

  const edges = [...target.edges];
  for (const e of internalEdges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (from === undefined || to === undefined) continue;
    edges.push({ ...e, id: newLocalId('e'), from, to });
  }

  const nodes = [...target.nodes, ...copies];
  for (const e of target.edges) {
    const to = idMap.get(e.to);
    if (to === undefined || idMap.has(e.from)) continue;
    const candidate = { from: e.from, to, condition: conditionOf(e), back: e.back === true };
    // Judged against the graph INCLUDING the edges accepted before it, for the
    // same reason `connect` judges against the live graph: an accepted edge
    // changes the answer for the next one.
    if (connectRejection(precomputeConnect({ nodes, edges, containers }), candidate) !== null) {
      continue;
    }
    edges.push({ ...e, id: newLocalId('e'), to });
  }

  return { nodes, edges, containers, newIds: [...idMap.values()] };
}

/**
 * U17 — how many undo steps the canvas keeps.
 *
 * A cap, not a budget: a snapshot is six references (see `snapshotOf`), so the
 * cost of a deep stack is negligible and this number is about not growing
 * without bound over a long authoring session. When the cap is reached the
 * OLDEST entry is dropped, which means a session with more than this many edits
 * can no longer undo all the way back to the state it opened on — the newest
 * steps, which are the ones an operator reaches for, always survive.
 */
export const HISTORY_LIMIT = 50;

/**
 * U17 — one point in the canvas's edit history.
 *
 * DELIBERATELY NOT A COPY. It takes the five doc arrays by reference, because
 * every store action is copy-on-write at both levels (`map`/`filter` mint a new
 * array, `{ ...n }` a new element), so nothing reachable from a snapshot is ever
 * mutated in place. The deep copies in `loadVersion` exist for a different
 * reason entirely — to stop the store writing THROUGH into the server's
 * `PipelineVersion`, which it does not own — and a snapshot never touches that
 * object.
 *
 * Cloning here would be actively wrong, not merely wasteful: `docUnchanged`
 * (`versionHistory.ts`) decides the save race by REFERENCE equality, on the
 * documented rule that a fresh array means a store action minted one. A
 * `structuredClone` per keystroke would mint fresh arrays for edits that changed
 * nothing else, and break that check.
 *
 * `dirty` and `loadedId` ride along because undo has to restore the SAVED-ness
 * of the doc, not just its shape — see `restoreFrom`.
 *
 * `addCount` is deliberately NOT here, the one piece of canvas state besides the
 * selection that a snapshot excludes. It is a monotonic placement counter for
 * UNPOSITIONED adds, not part of the doc: rolling it back would land the next
 * clicked add on the coordinates a previous one used, and carrying it forward
 * costs nothing but a stagger slot. Neither answer can affect what is saved.
 */
interface CanvasDocSnapshot {
  nodes: Node[];
  edges: Edge[];
  containers: Container[];
  params: Param[];
  outputs: Output[];
  dirty: boolean;
  /** The id of the version this doc was last reconciled against, or `null`. */
  loadedId: string | null;
}

function snapshotOf(s: CanvasState): CanvasDocSnapshot {
  return {
    nodes: s.nodes,
    edges: s.edges,
    containers: s.containers,
    params: s.params,
    outputs: s.outputs,
    dirty: s.dirty,
    loadedId: s.loaded?.id ?? null,
  };
}

/**
 * U17 — the coalescing key for a row edit, or `undefined` for one that must not
 * coalesce.
 *
 * Per FIELD, not per row. A row's Name, Type, Required and Description all reach
 * the store through ONE action, so a key of `param:0` folded a checkbox flip
 * into the typing burst that preceded it — two deliberate acts, one undo. The
 * key names the single field that changed (`param:0:name`), so a burst breaks
 * the moment the operator moves to another control.
 *
 * Several fields changing at once yields `undefined`, which coalesces with
 * nothing: a multi-field write is not a keystroke burst, and the conservative
 * answer (its own undo step) is the one that can only cost an extra press.
 * `default` is `z.unknown()` and may hold an object, so an equal-but-new value
 * reads as changed — again, an extra step rather than a swallowed one.
 */
function rowCoalesceKey(
  kind: 'param' | 'output',
  index: number,
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): string | undefined {
  const fields = new Set([...Object.keys(current), ...Object.keys(next)]);
  const changed = [...fields].filter((k) => current[k] !== next[k]);
  return changed.length === 1 ? `${kind}:${index}:${changed[0]!}` : undefined;
}

/** A row index an action can actually address — see the U17 note on no-op edits. */
function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

/**
 * The patch that puts `snap` back on screen.
 *
 * Two things it does beyond replacing the five arrays:
 *
 * `dirty` is the snapshot's OR "the basis moved". Restoring the recorded flag
 * alone would lie across a `rebaseLoaded`: save v1, keep editing, the save
 * lands and re-points `loaded` at v2 — now a snapshot taken before the save
 * records `dirty: false` against v1, and undoing to it would report a canvas
 * that matches the server when it does not. `dirty` gates the restore-version
 * discard warning and the unsaved-changes hint, so under-reporting it is the
 * unsafe direction; comparing `loadedId` can only ever over-report.
 *
 * The selection is PRUNED, not restored. Undoing an add removes the node the
 * operator may have selected, and a selection pointing at a node that is no
 * longer in the doc is the stale-selection trap #737 documents. Restoring the
 * selection the snapshot was taken under is the other option and is deliberately
 * not taken — a selection is not an edit, so undo moving it would be a second,
 * unasked-for effect.
 */
function restoreFrom(snap: CanvasDocSnapshot, s: CanvasState): Partial<CanvasState> {
  const survives = (sel: Selection): boolean =>
    sel.kind === 'node'
      ? snap.nodes.some((n) => n.id === sel.id)
      : sel.kind === 'edge'
        ? snap.edges.some((e) => e.id === sel.id)
        : snap.containers.some((c) => c.id === sel.id);
  const kept = s.selected.filter(survives);
  return {
    nodes: snap.nodes,
    edges: snap.edges,
    containers: snap.containers,
    params: snap.params,
    outputs: snap.outputs,
    dirty: snap.dirty || snap.loadedId !== (s.loaded?.id ?? null),
    // Pruned member-wise: undoing an add removes one node of a marquee'd set and
    // leaves the others genuinely selected, so dropping the whole set would be a
    // second, unasked-for effect on top of the one edit being undone.
    selected: kept.length === s.selected.length ? s.selected : kept,
  };
}

/** One node's half-picked pair ends, per binding kind (#1139). */
export interface PendingBindings {
  connections?: { source?: string; sink?: string };
  datasets?: { source?: string; sink?: string };
}

/** Which of a node's two paired bindings a picker is writing (#1139). */
export type BindingKind = 'connections' | 'datasets';

export interface CanvasState {
  /**
   * The immutable version the canvas was opened on (`null` = a brand-new
   * pipeline with no versions). Kept as the rebase basis for "Save", and as the
   * un-lowered record of what the server actually stored.
   *
   * It is no longer the carry-forward source for `params`/`outputs` (U16): those
   * are working state below, for the same reason containers stopped being read
   * off `loaded` in #746 — once a UI can edit a field, reading it from the
   * version the canvas was OPENED on silently discards the edit.
   */
  loaded: PipelineVersion | null;
  /** The working graph — the store owns its own copy (never the loaded arrays). */
  nodes: Node[];
  /**
   * #996 M5 slice 4c (#1139) — HALF-PICKED paired bindings, held here and
   * deliberately OUTSIDE the doc.
   *
   * `NodeSchema.connectionIds` requires BOTH ends (`schemas/pipeline.ts`, whose
   * docblock forbids `.partial()` by name), but an author picks source and sink
   * in two separate clicks. Something has to hold the first pick.
   *
   * M12 slice 1 (#1220) — `.datasetIds` no longer requires both: its `sink` is
   * optional, so a SOURCE-ONLY dataset binding is a valid doc. That does not
   * change this store yet, and `complete` below still demands a whole pair —
   * which is correct for every activity that exists today and wrong for the
   * first source-only one, whose entry lands in slice 2 (#1221) along with the
   * catalog-driven predicate that replaces it. Until then no authoring surface
   * can produce the shape, which is the fact that slice's `CATALOG_VERSION`
   * no-bump rests on (`schemas/version.ts`).
   *
   * It cannot be the node. `api/pipelines.ts` runs `PipelineVersionWriteSchema.parse`
   * on the body before every POST, so a `{source:'x'}` or an empty-string
   * sentinel on a node would throw a raw ZodError at the call site — and the
   * "Save anyway" conflict button does not consult the `issues` gate, so that
   * path is reachable. Keeping the doc always `NodeSchema`-valid is what makes
   * that unreachable BY CONSTRUCTION rather than by a gate somebody has to
   * remember.
   *
   * It cannot be the panel either: `NodePanel` remounts when the author selects
   * another node and comes back, so a panel-local draft would silently discard
   * the first pick.
   *
   * NOT part of `CanvasDocSnapshot`, and not written through `edit()`. Undo is
   * document history, and a half-picked binding is not in the document — it is
   * selection state. So picking one end does not dirty the doc or push a history
   * entry; the pair landing on the node does, as one undoable step. Masked by a
   * complete pair on the node (the read prefers the node), and cleared on node
   * delete and version load so it cannot outlive what it refers to.
   */
  pendingBindings: Record<string, PendingBindings>;
  edges: Edge[];
  /**
   * The doc's containers — WORKING state as of #746, not a view of `loaded`.
   *
   * Fully authored as of U6d: seeded on load, drawn by `FlowCanvas`, fed to the
   * connect rules, CREATED and re-parented by the property panel, written back
   * on save. Membership was never read-only even before that, because deleting
   * a node changes it — and that is what forced the move. While these were read
   * off `loaded`,
   * `deleteNode` had nothing to prune, so the deleted id stayed listed as a
   * child and every later save was refused (`child '<id>' is not a node in this
   * pipeline`) with no canvas affordance to repair it.
   */
  containers: Container[];
  /**
   * The pipeline's typed input contract — WORKING state as of U16.
   *
   * Authored from the property panel's nothing-selected slot. Before U16 there
   * was no UI at all, so a pipeline built on the canvas could never declare a
   * param: `${params.x}` had nothing to resolve and a trigger had nothing typed
   * to bind to.
   */
  params: Param[];
  /** The pipeline's declared output contract — WORKING state as of U16. */
  outputs: Output[];
  /**
   * U21 — what is selected, as a SET. Empty is "nothing selected".
   *
   * An array rather than a `Set<string>` keyed `kind:id`: `Selection` is the
   * type every reader already speaks, and a string key would mint a second
   * encoding of a fact that already has one.
   */
  selected: Selection[];
  /** True once the working graph diverges from `loaded`; reset on load/save. */
  dirty: boolean;
  /**
   * Monotonic counter so successive UNPOSITIONED adds don't stack at one point.
   *
   * Advanced only when the stagger is actually used — a drop (U5) supplies its
   * own position and stacks nothing, so counting it would shift the next clicked
   * add for a reason the operator cannot see.
   */
  addCount: number;
  /**
   * U17 — the edit history, oldest first. `past[past.length - 1]` is the doc as
   * it stood BEFORE the most recent edit, so one undo is one pop.
   *
   * Read `past.length > 0` / `future.length > 0` for the button states rather
   * than storing a `canUndo` flag — two facts that can disagree are worse than
   * one array anybody can count.
   */
  past: CanvasDocSnapshot[];
  /** Undone snapshots, oldest first; cleared by any new edit. */
  future: CanvasDocSnapshot[];

  loadVersion(v: PipelineVersion | null): void;
  /**
   * Point `loaded` at a new version WITHOUT touching the working graph or the
   * dirty flag — used after a save when the operator kept editing during the
   * in-flight request, so their edits are not clobbered by the just-saved graph.
   */
  rebaseLoaded(v: PipelineVersion): void;
  /**
   * Append a node of `type`. `position` is the FLOW-coordinate placement for a
   * node dropped from the toolbox (U5); omit it and the node takes the next
   * staggered default, as a clicked add does.
   */
  addNode(type: string, position?: Position): void;
  /**
   * U21 — append a copy of the node `id`: same type, same config, offset beside
   * it, and selected so the copy is what the panel edits next.
   *
   * The copy carries the source's INCOMING edges and not its outgoing ones, and
   * that asymmetry is the whole design:
   *
   * - Copying the OUT-edges would give every downstream node a second producer,
   *   which changes what the existing graph computes. A duplicate must not edit
   *   the pipeline it was duplicated from.
   * - Copying NO edges leaves the copy a root (`reduce.ts`: no incoming edge ⇒
   *   ready), so it would fire unconditionally at run start — and worse, its
   *   config's `${nodes.<id>.output.…}` refs would be REFUSED, because
   *   `validateRefs` scopes a ref to the node's upstream set and an unconnected
   *   node has none. Duplicating a node that reads its predecessor — the
   *   commonest case there is — would mint a doc that cannot be saved until it
   *   is wired.
   *
   * So the in-edges come along, each judged by `connectRejection`: the copy
   * keeps exactly the edges the canvas would have let the operator draw. That
   * reuse is what makes a back-edge drop out on its own (its ancestry rule needs
   * the target to forward-reach the source, and a fresh copy reaches nothing)
   * rather than being special-cased here and drifting from the rules later.
   *
   * A doc with NO edges at all is untouched by any of that: `effectiveEdges`
   * synthesizes a success chain over node order there, so the copy extends the
   * implicit chain exactly as `addNode` does. Same rule, no new one.
   *
   * Silent no-op for an id that names no current node — the store's standing
   * refusal shape, returning before `edit` so a refused press consumes no undo
   * slot.
   */
  duplicateNode(id: string): void;
  //  ^ sugar over `duplicateNodes([id])`. It carries that action's documented
  //    BEHAVIOUR CHANGE for the single-node case: a config referencing the
  //    node's OWN status now follows the copy. See `duplicateNodes` below.
  /**
   * U21 — duplicate a SET of nodes in one gesture, one undo entry.
   *
   * `duplicateNode` is the singular sugar over this, so the two cannot drift.
   * BEHAVIOUR CHANGE it carries for the singular case, deliberately: a config
   * that references the node's OWN status (`${nodes.a.status}` inside `a`) now
   * follows the copy, where before it kept reading the source. A self-reference
   * is about "this node", so the copy asking about itself is the correct
   * reading; the previous answer was an accident of not remapping at all.
   *
   * Returns how many nodes were copied — 0 when no id names a current node,
   * which returns before `edit` so a refused press consumes no undo slot.
   */
  duplicateNodes(ids: string[]): number;
  /**
   * U21 — put the selected nodes (and every edge BETWEEN them) on the canvas
   * clipboard. Returns how many nodes were copied; 0 means nothing was selected.
   *
   * NOT a doc edit, so it records no undo entry — there is nothing to undo, and
   * an entry here would make ⌘Z after a copy silently revert the edit before it.
   *
   * `pipelineId` is a parameter rather than store state on purpose: it is a
   * `PipelineCanvas` prop, and deriving it from `loaded` would read `null` for a
   * never-saved pipeline, so two unsaved pipelines would compare EQUAL and the
   * cross-pipeline refusal — the guard standing in for the deferred slice —
   * would fail open into exactly the dangling-ref doc it exists to prevent.
   */
  copySelection(pipelineId: string): number;
  /**
   * U21 — duplicate the selected ACTIVITIES, in ONE undo entry. Returns how many.
   *
   * Reads `selected` itself rather than taking ids, so every caller (the button
   * and ⌘D) asks the same question of the same authority. A view that computed
   * the ids from its own props could disagree with the store about what is
   * selected, which is precisely the split #737 settled by making the store the
   * single authority.
   */
  duplicateSelection(): number;
  /**
   * U21 — paste the canvas clipboard into this pipeline, in ONE undo entry.
   *
   * Refuses (without touching the doc) an empty clipboard, or one copied from
   * another pipeline — see `CanvasClipboard` for why cross-pipeline paste is a
   * later slice rather than a matter of copying more state.
   */
  pasteClipboard(pipelineId: string): { ok: true; count: number } | { ok: false; reason: string };
  /**
   * U21 — move nodes, in ONE undo entry.
   *
   * Plural with no singular companion, because React Flow reports a drag as one
   * BATCH of `position` changes whether it moved one node or five, and the
   * batch is the gesture: recording an entry per node would make undo restore a
   * group half-moved, a state the operator never authored. Ids naming no
   * current node are skipped, and a batch in which nothing actually moved
   * records nothing — a drag that lands back where it started is not an edit,
   * and a no-op that consumes an undo slot is a dead undo press.
   */
  moveNodes(moves: { id: string; position: Position }[]): void;
  deleteNode(id: string): void;
  /**
   * U21 — delete everything selected (nodes and edges) in ONE undo entry.
   *
   * The canvas OWNS this rather than leaving it to React Flow's `deleteKeyCode`,
   * because RF's `deleteElements` fires the edge removals and the node removals
   * as two separate callbacks. Through the change seam that is two `edit()`
   * calls and so two undo entries — one press would restore a deleted node and
   * leave its cascaded edge gone. That split predates multi-select; a group
   * delete would have multiplied it.
   *
   * A selected CONTAINER is never deleted here. Removing one is a structure
   * write that also destroys its config, so it keeps the confirm-gated
   * affordance (#748) as its only path.
   */
  deleteSelection(): void;
  /**
   * The SINGLE cascade: remove these nodes and these edges, plus every edge
   * incident to a removed node, plus their container membership, plus the
   * selection members that no longer name anything — in one undo entry.
   *
   * `deleteNode` and `deleteSelection` both funnel here rather than each
   * cascading for itself, for the reason `undo()`'s docblock gives for taking a
   * snapshot instead of an inverse command: a second place the cascade rules are
   * written is the first place they can come to disagree.
   */
  deleteNodesAndEdges(nodeIds: string[], edgeIds: string[]): void;
  /**
   * Remove a container, cascading the edges incident to it — and KEEPING its
   * children, which are un-grouped rather than deleted (#748).
   *
   * The affordance `deleteNode`'s "keep the container" choice depends on: a
   * container that reaches `children: []` is otherwise permanent, either
   * blocking every save (`loop`/`foreach`) or minting itself into an immutable
   * version forever (`stage`).
   */
  deleteContainer(id: string): void;
  /**
   * U6d — add `container` to the doc, taking its children out of whatever
   * container held them.
   *
   * Takes a whole `Container` rather than a kind plus fields for the same reason
   * `connect` takes a whole `EdgeCondition`: the caller has already built and
   * schema-checked one (`buildContainer`), and re-deriving it here would mint a
   * SECOND id, so the container the panel measured its consequences against
   * would not be the container the store created.
   *
   * Refuses (silent no-op) a container the schema rejects, one whose id collides
   * with an existing node or container — they share one namespace — one with no
   * children at all, and one naming a child that is not a current node. Silent
   * for the same reason `connect` is: the canvas is where a refusal is explained,
   * because it is where the operator is.
   */
  createContainer(container: Container): void;
  /**
   * U6d — move a node into `containerId`, or out of every container when it is
   * `null`.
   *
   * Deliberately does NOT refuse an edit that leaves the doc invalid — see
   * `containerRules`. The badge (#444) blocks the save, and the same control
   * reverses the edit.
   */
  setNodeContainer(nodeId: string, containerId: string | null): void;
  /**
   * U23 — replace the container `id` with `next`, its config edited.
   *
   * Takes the WHOLE container rather than a patch, the `updateNodeConfig`
   * precedent: the merge belongs in the panel, where `assembleConfig` already
   * carries the proven "preserve every key no field owns" rule, not restated
   * here as a second merge that could disagree with it.
   *
   * Refuses (silent no-op) an unknown id, a container the schema rejects, and
   * any change to `id`, `kind` or `children` — the three STRUCTURAL fields,
   * which this action does not own. (Three, matching `validate-doc.test.ts`'s
   * `STRUCTURAL` list; an earlier version of this note said two and omitted
   * `kind`, which the guard then omitted too.)
   *
   * A rename would strand the id's three other readers (an edge endpoint, a
   * `containerMembership` key, the selection's own handle). `kind` decides which
   * config fields are legal AND how the reducer runs the box, so reclassifying a
   * loop as a stage through a CONFIG action would silently leave `exitWhen`
   * behind on a kind that refuses it. A membership write belongs to
   * `setNodeContainer`, which alone takes the child out of whatever container
   * held it, and to `deleteNode`, which prunes (#746); routing membership
   * through here would bypass both and could author the duplicate-child doc
   * `validateDoc` refuses — or the empty container `createContainer` is careful
   * never to mint (#748).
   *
   * None of the three is reachable from `ContainerPanel`, which filters all
   * three out of its form and lets `assembleConfig` pass them through from the
   * original. They are guarded because this action re-checks what the panel has
   * already checked — it is the defence-in-depth seam, so it should not have
   * holes the layer above happens to cover.
   *
   * Silent for the reason `createContainer` is: the canvas explains refusals,
   * because it is where the operator is.
   *
   * Stores the INPUT, never `parsed.data`. `ContainerSchema` is a plain
   * `z.object`, so it strips unknown keys; storing the parse result would drop
   * whatever a git-imported container carries that this schema version does not
   * know about — the same silent-loss shape `assembleConfig` exists to prevent.
   *
   * Deliberately does NOT refuse an edit that leaves the DOC invalid (a blanked
   * `exitWhen`, say). That is `setNodeContainer`'s posture and it is deliberate:
   * the badge (#444) blocks the save and the same panel reverses the edit,
   * whereas refusing here would make a half-finished edit unrepresentable.
   */
  updateContainer(id: string, next: Container): void;
  /**
   * Append an edge from `from` to `to` carrying `condition`. Refuses (no-op) a
   * candidate `connectRejection` rejects — a self-loop, an endpoint that is not
   * a current node/container, a duplicate, or an edge that would close a forward
   * cycle.
   *
   * Takes a whole `EdgeCondition` rather than an `EdgeOn`: `on: 'branch'` is only
   * half an edge (the label is the routing key), so the looser signature could
   * author an edge `EdgeSchema` does not accept.
   */
  connect(from: string, to: string, condition: EdgeCondition, options?: ConnectOptions): void;
  deleteEdge(id: string): void;
  /**
   * U6e — set a back-edge's bounce cap.
   *
   * Refuses (no-op) a value `EdgeSchema` would reject and an edge that is not a
   * back-edge: `maxBounces` on a forward edge is a field the reducer never
   * reads, so writing one would persist a lie about how the edge behaves.
   */
  updateEdgeBounces(id: string, maxBounces: number): void;
  /**
   * U19 slice 2 — move an existing edge to new endpoints and/or a new condition,
   * preserving its id, its back-ness and its cap.
   *
   * Refuses (no-op) anything `connectRejection` refuses, judged against the
   * graph WITHOUT this edge — see the implementation for why that exclusion is
   * the load-bearing part.
   */
  rewireEdge(id: string, target: { from: string; to: string; condition: EdgeCondition }): void;
  updateNodeConfig(id: string, config: Record<string, unknown>): void;
  /**
   * #425 — set (or clear) a call node's `Node.call` blob.
   *
   * The `node.call` counterpart of `updateNodeConfig`, and separate from it for
   * the reason the two fields are separate on `NodeSchema`: a call node's
   * settings are STRUCTURAL (the engine routes on `Node.call`'s presence), not
   * activity config, so folding them into the config record would make the
   * generic config form able to author a dispatch mechanism.
   *
   * Takes the WHOLE blob, not a patch — `wait` is an absent-or-present key, and
   * a patch signature cannot express "remove it" without a JSON-hostile
   * sentinel (the `updateParam`/`createContainer` precedent).
   *
   * REFUSES a node whose type is not a structural-call activity: `Node.call` on
   * any other type is a field the reducer would act on while the node's own
   * catalog entry knows nothing about it. This is the same rail as
   * `updateEdgeBounces` refusing a forward edge — never persist a lie about how
   * a graph element behaves. (`undefined` clears it, which is the state a
   * freshly added call node starts in and the state the save gate reports as
   * "needs a call config".)
   */
  updateNodeCall(id: string, call: CallConfig | undefined): void;
  setNodeConnection(id: string, connectionId: string | undefined): void;
  /**
   * #1139 — set ONE END of a paired binding (`connectionIds` / `datasetIds`).
   *
   * Whole-value at the doc layer, which is this store's stated house rule: the
   * node's pair key is written only when BOTH ends are known and deleted the
   * moment either is cleared, so no field-patch signature and no
   * "JSON-hostile sentinel" is needed to express removal. The partial lives in
   * `pendingBindings` until it becomes a pair. See that field for why.
   */
  setNodeBindingEnd(
    id: string,
    kind: BindingKind,
    side: 'source' | 'sink',
    value: string | undefined,
  ): void;
  /**
   * U16 — the pipeline's typed contract. Each takes a WHOLE replacement row
   * rather than a field patch, for the same reason `createContainer` takes a
   * whole `Container`: `default` is an absent-or-present key (not a nullable
   * one), and a field-patch signature cannot express "remove this key" without
   * a sentinel that JSON cannot carry.
   *
   * Addressed by INDEX, not by name: a name is what the operator is editing, so
   * it is unusable as the identity of the row being edited — a rename would
   * address a row that no longer exists, and two rows may legitimately share a
   * name mid-edit (that is precisely the state the save gate reports).
   */
  addParam(): void;
  updateParam(index: number, next: Param): void;
  removeParam(index: number): void;
  addOutput(): void;
  updateOutput(index: number, next: Output): void;
  removeOutput(index: number): void;
  /** Select exactly one element, or nothing. Sugar over `setSelection`. */
  select(sel: Selection | null): void;
  /**
   * U21 — replace the whole selection set (what the React Flow seam folds to).
   *
   * The SINGLE writer of `selected`, and therefore where the set's one
   * structural rule is enforced: `containerExclusive` normalises the argument,
   * so no caller can install a container alongside a node.
   */
  setSelection(next: Selection[]): void;
  /**
   * U17 — step back one edit. A no-op when there is nothing to undo.
   *
   * Snapshot-per-edit, NOT the spec row's literal "reversible-command store".
   * An inverse command for `deleteNode` would have to re-derive the cascade it
   * performed (incident edges, container membership, the selection) and
   * `deleteContainer` its own different one — a third place the cascade rules
   * are written, and the first place they could come to disagree with the two
   * that already exist. A snapshot is six references and cannot disagree with
   * anything.
   */
  undo(): void;
  /** U17 — step forward one undone edit. A no-op when there is nothing to redo. */
  redo(): void;
}

/**
 * A vanilla (framework-free) zustand store holding the canvas working graph.
 * Vanilla — not a React hook — so every mutation is unit-testable without a DOM
 * (`store.getState().addNode(...)`); the React canvas subscribes via
 * `useStore(store, selector)`. Actions are the SINGLE place the graph mutates,
 * which is what keeps the engine's global-id / no-dangling-edge invariants
 * intact: `deleteNode` and `deleteContainer` (#748) both cascade to incident
 * edges, `connect` refuses a self-loop or an endpoint that is not a current node
 * OR container, and `loadVersion` drops an edge arriving from the server with an
 * endpoint that resolves to neither (#786).
 */
export function createCanvasStore(): StoreApi<CanvasState> {
  return createStore<CanvasState>((set, get) => {
    /**
     * U17 — the key of the burst currently being coalesced, or `null`.
     *
     * A closure variable rather than store state because nothing renders it and
     * it is not part of the doc. Reset by `loadVersion`, `undo` and `redo`, so a
     * burst can never span one of those.
     */
    let coalescing: string | null = null;

    /**
     * The ONE place the working doc changes, and therefore the one place history
     * is recorded. Every mutating action ends here; every refusal returns before
     * it, which is what keeps a refused action from consuming an undo slot (a
     * dead undo press is the commonest way an undo feature loses trust).
     *
     * `coalesceKey` folds a BURST of writes into one undo step. It is not an
     * optimisation — without it undo is unusable. A param name field writes
     * straight through to the store on every keystroke (`PipelineCanvas`, the
     * `default` field is the only control that does not), so typing one
     * identifier would push a dozen entries and two of them would evict every
     * structural edit from a 50-deep stack. While the key is unchanged the push
     * is SKIPPED rather than replaced: the entry already on top of `past` is the
     * doc as it stood before the burst began, which is exactly where one undo
     * should land.
     *
     * The key is per FIELD (`param:0:name` — see `rowCoalesceKey`), so moving to
     * another control on the same row starts a new step, as does moving to
     * another row. Nothing coalesces across an edit of a different kind.
     */
    const edit = (
      updater: (s: CanvasState) => Partial<CanvasState>,
      coalesceKey?: string,
    ): void => {
      const key = coalesceKey ?? null;
      const continues = key !== null && key === coalescing;
      coalescing = key;
      set((s) => ({
        ...updater(s),
        dirty: true,
        // Drop the OLDEST when the cap is reached — see `HISTORY_LIMIT`.
        past: continues ? s.past : [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
        // Any new edit forks the history: what was undone is no longer reachable.
        future: [],
      }));
    };

    return {
      loaded: null,
      nodes: [],
      pendingBindings: {},
      edges: [],
      containers: [],
      params: [],
      outputs: [],
      selected: [],
      dirty: false,
      addCount: 0,
      past: [],
      future: [],

      loadVersion(v) {
        // U17 — opening a document is not an edit of the one that was open, so
        // the history does not survive it. (`rebaseLoaded` deliberately does keep
        // it: that re-points the basis WITHOUT touching the working graph, so
        // every recorded step is still a step of the doc on screen.)
        coalescing = null;
        // Built ONCE rather than per edge, and from `connectRules`' own helper so
        // the set the load filter trusts is the SAME set `connect` refuses an
        // unknown endpoint against — see `edgeEndpointIds` for why containers
        // belong in it.
        const endpointIds = v ? edgeEndpointIds(v.nodes, v.containers) : new Set<string>();
        set({
          // #526 — `loaded` keeps the SERVER's doc, un-lowered. It is the rebase
          // basis and the carry-forward source for the parts of the doc this slice
          // has no UI for; only the WORKING graph below is lowered.
          loaded: v,
          // #526 (F13b follow-up) — LOWER on load, with the same composition the
          // server applies on write. A version created BEFORE F13b persisted its
          // known-type nodes with `config.outputs` ABSENT, and versions are
          // immutable, so that row can never be repaired in place. Loading it raw
          // showed the author an empty contract: `validateRefs` name-checked
          // nothing and the badges/output pills disagreed with what the server
          // WILL store the moment they save. Lowering here makes the canvas show
          // the contract that save will mint. It deliberately does NOT set
          // `dirty` — this is a display fix, not an author edit, and marking every
          // legacy pipeline dirty on open would prompt a save nobody made.
          //
          // Deep-ish copy: fresh arrays with fresh node/edge objects so editing
          // the working graph never mutates the loaded version in place. Still
          // load-bearing after the lowering — `lowerPipelineNodes` is
          // copy-on-write and hands back an unchanged node BY REFERENCE.
          nodes: v ? lowerPipelineNodes(v.nodes).map((n) => ({ ...n })) : [],
          // #1139 — a half-picked binding names a node in the doc being REPLACED,
          // so it cannot outlive it. Cleared here rather than left to be masked,
          // because "masked" and "gone" look identical right up until a new doc
          // reuses a node id.
          pendingBindings: {},
          // #786 — DROP an edge whose endpoint resolves to nothing, for the same
          // reason as the lowering above: the row is immutable, so it can never be
          // repaired in place, and loading it raw makes the canvas disagree with
          // what Save mints. Sharper here than a display mismatch, though — the
          // #786 write-gate rule now REFUSES such a doc, and React Flow silently
          // drops an edge whose endpoint is missing from its lookup, so an author
          // opening a version minted before that rule would meet a red badge and a
          // dead Save over an edge they can neither see, select nor delete: exactly
          // the one-way trap #748 closed, re-created by the rule that closes the
          // hole. Not authorable from here (`connect` refuses an unknown endpoint
          // and both delete paths cascade), and the API and git-import routes are
          // now closed by that same rule — so the ONLY remaining source is a row
          // minted BEFORE it. A closed set that shrinks to nothing over time.
          //
          // This is deliberately the OPPOSITE call to `pruneContainerChild`'s (see
          // its docblock: a general normalise would hide `child 'Y' is not a node
          // in this pipeline`, a real defect report about a doc that arrived
          // broken). The asymmetry is the AFFORDANCE, not the principle: a dangling
          // child's error names a container the author can see and — since #748 —
          // delete, so surfacing it leads somewhere. A dangling edge is invisible
          // and unselectable, so surfacing it leads nowhere and only blocks Save.
          // Repair silently where the operator has no move; report where they do.
          //
          // The resolvable set is nodes UNION containers: a container id is a legal
          // edge endpoint. Node ids alone would strip every container edge on load,
          // and `toVersionBody` reads `edges` from the WORKING graph, so the next
          // Save would mint that loss. Like the lowering, this deliberately does
          // NOT set `dirty` — a reconciliation, not an author edit — and `loaded`
          // keeps the server's doc verbatim as the record of what was stored.
          edges: v
            ? v.edges
                .filter((e) => endpointIds.has(e.from) && endpointIds.has(e.to))
                .map((e) => ({ ...e }))
            : [],
          // #746 — containers are seeded as WORKING state, and the copy goes one
          // level deeper than the spread: `{...c}` alone would ALIAS `c.children`
          // into the SERVER's version object, which this store does not own and
          // must never write through. (`children` is the only array or object
          // field on `ContainerSchema`, so one level is the whole copy.) The prune
          // below is copy-on-write, so the alias would be harmless today and a
          // live hazard the moment anything edits membership IN PLACE — U6d does
          // not (`assignContainerChild` is copy-on-write), so this stays a standing
          // invariant rather than a bug waiting on U23 — latent sharing
          // that is free to rule out here.
          containers: v ? v.containers.map((c) => ({ ...c, children: [...c.children] })) : [],
          // U16 — seeded as working state, and the copy is DEEPER than the
          // containers copy above rather than a spread. `children` is a flat array
          // of strings, so one level covers it; a param's `default` is
          // `z.unknown()` and a `json` param's can nest arbitrarily, so `{ ...p }`
          // would alias a live sub-object into the SERVER's version object, which
          // this store does not own and must never write through.
          //
          // `structuredClone` is safe here specifically because the value arrived
          // as parsed JSON over the wire — there is no function or class instance
          // it could choke on.
          params: v ? v.params.map((p) => structuredClone(p)) : [],
          outputs: v ? v.outputs.map((o) => ({ ...o })) : [],
          selected: [],
          dirty: false,
          addCount: 0,
          past: [],
          future: [],
        });
      },

      rebaseLoaded(v) {
        set({ loaded: v });
      },

      addNode(type, position) {
        if (!getActivity(type)) return; // unknown catalog type — ignore rather than author garbage
        // #425 — a structural-call activity (`execute_pipeline`) is now authorable.
        // It is added with NO `call` blob: there is no honest default target, and
        // `CallConfigSchema.pipelineVersionId` is `.min(1)`, so seeding a blank one
        // would author a node that fails a raw Zod parse instead of the readable
        // "an execute_pipeline needs a call config" the doc validator already emits.
        // The save gate therefore holds the node until `CallPanel` sets a target,
        // and `lowerPipelineNodes` skips it by TYPE in the meantime (#425 in
        // `catalog/lower.ts`) so no `outputs: []` gets baked into the window.
        const n = get().addCount;
        const created: Node = {
          id: newLocalId('n'),
          type,
          config: {},
          // COPIED, never aliased: the store owns its graph, and holding a
          // caller's object would let that caller mutate a node's position from
          // outside the actions — the single mutation point this store's doc
          // claims. Otherwise, stagger so repeated adds don't stack exactly.
          position: position ? { ...position } : { x: 80 + (n % 5) * 40, y: 80 + (n % 5) * 40 },
        };
        // #526 — seed the declared output contract through the SAME composition the
        // server and the load path use, rather than reaching into the catalog entry
        // here. Hand-seeding worked, but it was a third place that had to agree
        // about what a node's contract is; one function is what makes them unable
        // to disagree. (The run-time SSOT remains the node's own `config.outputs`.)
        const node = lowerPipelineNodes([created])[0]!;
        edit((s) => ({
          nodes: [...s.nodes, node],
          // Only a stagger consumes a slot — see the `addCount` doc.
          addCount: position ? s.addCount : s.addCount + 1,
        }));
      },

      duplicateNode(id) {
        get().duplicateNodes([id]);
      },

      duplicateNodes(ids) {
        const live = get();
        const sources = live.nodes.filter((n) => ids.includes(n.id));
        if (sources.length === 0) return 0;
        const kept = new Set(sources.map((n) => n.id));
        // Every edge WITHIN the copied set travels with it. Membership, not
        // selection, decides: selecting two nodes and asking for a copy means the
        // pair, and an operator does not think of the arrow between them as a
        // third thing they forgot to click.
        const internal = live.edges.filter((e) => kept.has(e.from) && kept.has(e.to));
        edit((s) => {
          const cloned = cloneNodesInto(s, sources, internal);
          return {
            nodes: cloned.nodes,
            edges: cloned.edges,
            containers: cloned.containers,
            // The copies, not the sources, are what the operator is about to edit
            // — duplicating is how you say "another one of these, but different".
            selected: cloned.newIds.map((id) => ({ kind: 'node' as const, id })),
            // ONE gesture consumes ONE stagger slot, however many nodes it copied.
            addCount: s.addCount + 1,
          };
        });
        return sources.length;
      },

      duplicateSelection() {
        return get().duplicateNodes(
          get()
            .selected.filter((sel) => sel.kind === 'node')
            .map((sel) => sel.id),
        );
      },

      copySelection(pipelineId) {
        const live = get();
        const ids = live.selected.filter((s) => s.kind === 'node').map((s) => s.id);
        const nodes = live.nodes.filter((n) => ids.includes(n.id));
        if (nodes.length === 0) return 0;
        const kept = new Set(nodes.map((n) => n.id));
        writeClipboard({
          pipelineId,
          nodes,
          edges: live.edges.filter((e) => kept.has(e.from) && kept.has(e.to)),
        });
        return nodes.length;
      },

      pasteClipboard(pipelineId) {
        const held = readClipboard();
        if (held === null || held.nodes.length === 0) {
          return { ok: false, reason: 'Nothing has been copied yet.' };
        }
        if (held.pipelineId !== pipelineId) {
          return {
            ok: false,
            reason:
              'That was copied from a different pipeline. Pasting across pipelines is not supported yet.',
          };
        }
        edit((s) => {
          const cloned = cloneNodesInto(s, held.nodes, held.edges);
          return {
            nodes: cloned.nodes,
            edges: cloned.edges,
            containers: cloned.containers,
            selected: cloned.newIds.map((id) => ({ kind: 'node' as const, id })),
            addCount: s.addCount + 1,
          };
        });
        return { ok: true, count: held.nodes.length };
      },

      moveNodes(moves) {
        const nodes = get().nodes;
        // A drag that lands back where it started is not an edit — `setNodeContainer`'s
        // rule, for its reason, plus one U17 adds: a no-op that records history is a
        // dead undo press, and a drag returning to its own origin is the easiest one
        // to perform by accident. At set level the same rule reads: record nothing
        // unless at least one member genuinely moved.
        const real = moves.filter(({ id, position }) => {
          const current = nodes.find((n) => n.id === id);
          return (
            current !== undefined &&
            (current.position.x !== position.x || current.position.y !== position.y)
          );
        });
        if (real.length === 0) return;
        const byId = new Map(real.map((m) => [m.id, m.position]));
        edit((s) => ({
          nodes: s.nodes.map((n) => {
            const position = byId.get(n.id);
            return position === undefined ? n : { ...n, position };
          }),
        }));
      },

      deleteNode(id) {
        get().deleteNodesAndEdges([id], []);
      },

      deleteSelection() {
        const selected = get().selected;
        // Containers are filtered out, not refused: a container is EXCLUSIVE in
        // the set, so this is the whole selection being one, and the press means
        // "delete the box" — which only the confirm-gated affordance does.
        get().deleteNodesAndEdges(
          selected.filter((s) => s.kind === 'node').map((s) => s.id),
          selected.filter((s) => s.kind === 'edge').map((s) => s.id),
        );
      },

      deleteNodesAndEdges(nodeIds, edgeIds) {
        const live = get();
        const doomedNodes = new Set(nodeIds.filter((id) => live.nodes.some((n) => n.id === id)));
        const doomedEdges = new Set(edgeIds.filter((id) => live.edges.some((e) => e.id === id)));
        if (doomedNodes.size === 0 && doomedEdges.size === 0) return;
        edit((s) => {
          const removedEdgeIds = new Set([
            ...doomedEdges,
            ...s.edges
              .filter((e) => doomedNodes.has(e.from) || doomedNodes.has(e.to))
              .map((e) => e.id),
          ]);
          const selected = s.selected.filter((sel) =>
            sel.kind === 'node'
              ? !doomedNodes.has(sel.id)
              : sel.kind === 'edge'
                ? !removedEdgeIds.has(sel.id)
                : true,
          );
          return {
            nodes: s.nodes.filter((n) => !doomedNodes.has(n.id)),
            edges: s.edges.filter((e) => !removedEdgeIds.has(e.id)),
            // #746 — container membership cascades exactly like the incident
            // edges above. A container listing a node that no longer exists is a
            // doc `validatePipelineDoc` refuses, so leaving the id behind made the
            // canvas unsavable with nothing on screen able to repair it.
            //
            // A container that loses its LAST child is KEPT, not deleted with it.
            // Deleting one is a structure write that also owns its incident edges
            // and its exitWhen/items/maxRounds/timeout config, none of it
            // re-authorable on the canvas until U23/#839 — so a cascade destroys
            // authored structure the operator cannot get back.
            //
            // That reasoning is SYMMETRIC, which is why keeping the container was
            // only half an answer: an emptied container was ALSO unrecoverable,
            // just quieter — an empty `stage` validates clean and saved itself into
            // an immutable version forever, and an empty `loop`/`foreach` blocked
            // every save with no way out but a reload.
            //
            // #748 closed that: `deleteContainer` is the affordance, so keeping the
            // container here is now a genuine choice (the operator decides whether
            // the box goes) rather than the only thing the canvas could do. The
            // fix was the affordance, not a better default here — this default is
            // unchanged.
            //
            // Pruned once per doomed node. `pruneContainerChild` is a pure
            // `Container[] -> Container[]`, so folding it is the batch form —
            // there is no second rule to write down.
            containers: [...doomedNodes].reduce(pruneContainerChild, s.containers),
            // #1139 — a half-picked binding on a node that no longer exists is
            // unreachable state keyed by a stale id. Dropped with the node, so a
            // later paste that reuses the id cannot inherit it.
            pendingBindings: Object.fromEntries(
              Object.entries(s.pendingBindings).filter(([nodeId]) => !doomedNodes.has(nodeId)),
            ),
            selected,
          };
        });
      },

      /**
       * #748 — remove a container.
       *
       * Deliberately NOT symmetric with `deleteNode`'s membership prune, in the one
       * way that matters: the CHILDREN survive. A container's children are real
       * authored activities that merely sit inside it, so removing the box
       * un-groups them (they run at the top level, which the reducer already
       * handles — nothing assumes universal container membership). Cascading them
       * would make this action a worse trap than the one it exists to end, since an
       * activity's config is no more re-authorable than a container's.
       *
       * What IS cascaded is the incident edges, matched exactly as `deleteNode`
       * matches them: a container id is a legal `from`/`to` (one string field
       * shared with nodes), so an edge left naming a deleted container is a
       * dangling ref — the same unsavable doc, with nothing on screen able to
       * repair it, that #746 was filed about.
       *
       * The container's own `exitWhen`/`items`/`maxRounds`/`timeout` IS lost from
       * the doc — recoverably, since U17: this action records history like every
       * other, so one undo brings the box, its config and its cascaded edges
       * back. The canvas still confirms, because a cascade the operator did not
       * intend is worth stopping before it happens rather than after, and the
       * confirmation still names what goes and what stays.
       */
      deleteContainer(id) {
        if (!get().containers.some((c) => c.id === id)) return;
        edit((s) => {
          const next = cascadeDeleteContainer(s, id);
          const kept = new Set(next.edges.map((e) => e.id));
          const removedEdgeIds = new Set(s.edges.filter((e) => !kept.has(e.id)).map((e) => e.id));
          return {
            containers: next.containers,
            edges: next.edges,
            // Two ways to strand a selection here: an EDGE the cascade removed,
            // and — since U23 — the deleted CONTAINER itself. RF drives neither
            // clear (it never sees a container at all, and the edge is gone
            // before it could emit a deselect), so both are this action's job.
            selected: s.selected.filter(
              (sel) =>
                !(sel.kind === 'edge' && removedEdgeIds.has(sel.id)) &&
                !(sel.kind === 'container' && sel.id === id),
            ),
          };
        });
      },

      createContainer(container) {
        const parsed = ContainerSchema.safeParse(container);
        if (!parsed.success) return;
        const c = parsed.data;
        const s = get();
        // One namespace for node and container ids (`validateDoc` says so), so a
        // collision check has to look at both.
        if (s.nodes.some((n) => n.id === c.id) || s.containers.some((x) => x.id === c.id)) return;
        // Never born empty: an empty `loop`/`foreach` is a doc `validateDoc`
        // refuses, and an empty `stage` validates clean and mints itself into an
        // immutable version forever — the two halves of #748's trap.
        if (c.children.length === 0) return;
        // A container whose children are not current nodes is the phantom-child
        // doc #746 was filed about, authored fresh instead of left behind.
        if (!c.children.every((ch) => s.nodes.some((n) => n.id === ch))) return;
        edit((st) => ({ containers: containersWithNew(st.containers, c) }));
      },

      setNodeContainer(nodeId, containerId) {
        const s = get();
        if (!s.nodes.some((n) => n.id === nodeId)) return;
        if (containerId !== null && !s.containers.some((c) => c.id === containerId)) return;
        const next = assignContainerChild(s.containers, nodeId, containerId);
        // Re-picking the container a node is already in must not mark the canvas
        // dirty — an unchanged graph that reports itself as edited is how a "you
        // have unsaved changes" prompt loses the operator's trust.
        if (next === s.containers) return;
        edit(() => ({ containers: next }));
      },

      updateContainer(id, next) {
        const s = get();
        const current = s.containers.find((c) => c.id === id);
        if (current === undefined) return;
        // `id`, `kind` and `children` are structural, not config — see the note.
        if (next.id !== id) return;
        if (next.kind !== current.kind) return;
        // Vacuous for `ContainerPanel`, and deliberately kept anyway: its
        // `assembleConfig` shallow-copies, so `next.children` IS `current.children`
        // and this can never fire from there. It guards the seam, not that caller.
        // (The sharing is harmless — every writer here is copy-on-write and nothing
        // mutates a children array in place — but it is the shape `loadVersion`'s
        // deep copy exists to keep away from `loaded`, so: no in-place membership
        // edits, ever.)
        if (
          next.children.length !== current.children.length ||
          next.children.some((ch, i) => ch !== current.children[i])
        ) {
          return;
        }
        if (!ContainerSchema.safeParse(next).success) return;
        // Pressing Apply without typing must not mark the canvas dirty.
        if (sameContainerConfig(current, next)) return;
        edit((st) => ({ containers: containersWithUpdated(st.containers, next) }));
      },

      /**
       * Append an edge, or refuse it.
       *
       * The refusal rules are NOT written here any more: they are
       * `connectRejection`, the same predicate the canvas measures a connection
       * DRAG against (U6b), so the gesture React Flow refuses and the call this
       * store refuses cannot come to disagree. This end stays the backstop for a
       * caller that is not the canvas, and it is deliberately silent — the canvas
       * is where a refusal is explained, because it is where the operator is.
       *
       * The forward-DAG rule is new here. It was previously left entirely to the
       * save gate, so a cycle-closing edge could be drawn, seen, and only then
       * refused by a validation badge.
       *
       * One other semantic widened with the move: an endpoint is now a node id OR a
       * CONTAINER id, where this used to accept node ids only. Containers are legal
       * edge endpoints in the doc model, so refusing them was the narrower rule; no
       * current caller passes one (React Flow's ports are on nodes).
       */
      connect(from, to, condition, options) {
        const back = options?.back === true;
        const graph = {
          nodes: get().nodes,
          edges: get().edges,
          containers: get().containers,
        };
        /* The candidate is judged WITH its back-ness, so the rules that decide the
         answer are the ones that apply to the edge actually being authored — a
         back-edge is exempt from the boundary and DAG rules and subject to its
         own three (`backEdgeDefect`). Judging the forward shape and authoring
         the back one is the mismatch `DRAWN_EDGE_CONDITION`'s docblock warns
         about, in its other axis. */
        if (connectRejection(precomputeConnect(graph), { from, to, condition, back }) !== null) {
          return;
        }
        /* `maxBounces` is authored HERE rather than left for the panel: the save
         gate refuses a back-edge without one, so a capless edge would be
         unsavable from the instant it appeared, with the operator's only clue a
         validation badge about an edge they just drew. The panel EDITS the cap;
         it does not have to supply it. */
        const edge = {
          id: newLocalId('e'),
          from,
          to,
          ...condition,
          ...(back ? { back: true, maxBounces: DEFAULT_MAX_BOUNCES } : {}),
        } as Edge;
        edit((s) => ({ edges: [...s.edges, edge] }));
      },

      updateEdgeBounces(id, maxBounces) {
        if (!isMaxBounces(maxBounces)) return;
        const current = get().edges.find((e) => e.id === id);
        if (current === undefined || current.back !== true) return;
        // Re-committing the cap it already holds must not mark the canvas dirty —
        // `setNodeContainer`'s rule, for its reason: an unchanged graph that
        // reports itself as edited is how a "you have unsaved changes" prompt
        // loses the operator's trust. The panel's own guard is a STRING compare
        // (`text === stored`), so `10.0`, ` 10` and `+10` over a stored `10` all
        // reach here as a numerically identical write.
        if (current.maxBounces === maxBounces) return;
        edit((s) => ({
          edges: s.edges.map((e) => (e.id === id ? { ...e, maxBounces } : e)),
        }));
      },

      deleteEdge(id) {
        get().deleteNodesAndEdges([], [id]);
      },

      /**
       * U19 slice 2 — move an existing edge: new endpoints, new condition, or
       * both, in ONE act that preserves the edge's identity.
       *
       * This replaces `updateEdgeCondition`, whose only caller was the `Fires on`
       * dropdown. A retype is now the special case where both endpoints happen to
       * stay put, which is why the whole gesture is one action rather than a
       * retype plus an endpoint move: an edge dragged from `a -success-> b` to
       * `a -failure-> c` passes through `a -failure-> b` in neither the doc nor
       * the operator's intent, and committing that intermediate would put a state
       * on the undo stack nobody asked for and could fail a rule the endpoints
       * they actually chose does not.
       *
       * THE EDGE IS JUDGED AGAINST THE GRAPH WITHOUT ITSELF. It cannot duplicate
       * itself (dropping it back where it started would otherwise be refused for
       * colliding with the edge in hand), and it cannot be the cycle it is being
       * dragged out of. That exclusion is what lets every rule in
       * `connectRejection` apply unchanged and correctly — including the
       * duplicate rule that `retypeCollides` used to answer separately, which is
       * why that predicate is gone rather than kept as a second reader of the
       * same question (#847's defect class).
       *
       * `back` rides on the candidate, so a back-edge stays subject to its own
       * three rules wherever it is dragged, and `retypeEdge`'s rest-spread
       * carries `back`/`maxBounces` through to the rewired edge. The canvas
       * explains a refusal; this stays silent, the same backstop posture as
       * `connect`.
       */
      rewireEdge(id, target) {
        const current = get().edges.find((e) => e.id === id);
        if (current === undefined) return;
        const { from, to, condition } = target;
        /* Nothing moved. Returning before `edit` keeps a drop-back-where-it-
           started off the undo stack and out of the dirty flag — `setNodeContainer`'s
           rule, for its reason: a graph that reports an edit it did not make is
           how an unsaved-changes prompt loses the operator's trust. */
        if (
          current.from === from &&
          current.to === to &&
          encodeCondition(conditionOf(current)) === encodeCondition(condition)
        ) {
          return;
        }
        const graph = {
          nodes: get().nodes,
          edges: get().edges.filter((e) => e.id !== id),
          containers: get().containers,
        };
        const back = current.back === true;
        if (connectRejection(precomputeConnect(graph), { from, to, condition, back }) !== null) {
          return;
        }
        const rewired = retypeEdge({ ...current, from, to }, condition);
        edit((s) => ({
          edges: s.edges.map((e) => (e.id === id ? rewired : e)),
        }));
      },

      updateNodeConfig(id, config) {
        if (!get().nodes.some((n) => n.id === id)) return;
        edit((s) => ({
          nodes: s.nodes.map((n) => (n.id === id ? { ...n, config } : n)),
        }));
      },

      updateNodeCall(id, call) {
        const node = get().nodes.find((n) => n.id === id);
        if (node === undefined) return;
        // #953 — the same predicate the inspector routes on, so a node that gets
        // the call editor can always write through it. Keying this on the type
        // alone made a legacy `call_pipeline`-typed node's blob read-only.
        if (!authorsCallBlob(node)) return;
        edit((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== id) return n;
            const next = { ...n };
            if (call) next.call = call;
            else delete next.call;
            return next;
          }),
        }));
      },

      setNodeConnection(id, connectionId) {
        if (!get().nodes.some((n) => n.id === id)) return;
        edit((s) => ({
          nodes: s.nodes.map((n) => {
            if (n.id !== id) return n;
            const next = { ...n };
            if (connectionId) next.connectionId = connectionId;
            else delete next.connectionId;
            return next;
          }),
        }));
      },

      setNodeBindingEnd(id, kind, side, value) {
        const state = get();
        if (!state.nodes.some((n) => n.id === id)) return;
        const field = kind === 'connections' ? 'connectionIds' : 'datasetIds';

        // The node's OWN pair wins over anything pending: a complete pair is the
        // document, and `pendingBindings` is only ever the half-picked remainder.
        const node = state.nodes.find((n) => n.id === id);
        const committed = node?.[field];
        const held = state.pendingBindings[id]?.[kind];
        const current = committed ?? held ?? {};
        const nextPair = { ...current, [side]: value };
        const source = nextPair.source || undefined;
        const sink = nextPair.sink || undefined;

        // What counts as a COMPLETE binding is the CATALOG's answer, not a
        // constant — #1221 M12 slice 2. Until `lookup` this read
        // `source !== undefined && sink !== undefined`, which was right when
        // every dataset-bound activity moved data between two ends. A
        // source-only activity would never satisfy it, so its `datasetIds` would
        // never reach the doc and the node would sit permanently half-bound with
        // no way to finish it.
        //
        // Asked PER KIND, not per entry, because this one function serves both
        // pairs — and the two answers are NOT symmetric. A blanket relaxation
        // keyed off the entry alone would let a half-bound `copy` CONNECTION
        // pair reach the doc, which is the exact thing the original predicate
        // existed to stop.
        //
        // `connections` ALWAYS needs both ends, unconditionally, because
        // `NodeSchema.connectionIds` still requires both: M12 slice 1 (#1220)
        // widened `datasetIds.sink` to optional and deliberately did NOT touch
        // its connection twin. A source-only connection pair is therefore not
        // expressible, and an activity that binds no sink connection does not
        // use this pair at all — it authors the SINGULAR `connectionId` instead
        // (`PipelineCanvas`'s `paired` branch). Making this conditional would
        // produce a doc the server refuses at save, for a control nothing
        // renders.
        //
        // An UNKNOWN activity type keeps the pair-required behaviour, and that
        // polarity is deliberate: it is the safe direction. Requiring both ends
        // of something that needs one leaves a node the author can see is
        // unfinished; accepting one end of something that needs two writes a doc
        // the server refuses at save.
        const entry = getActivity(node?.type ?? '');
        const needsBothEnds =
          kind === 'connections' || entry === undefined || entry.datasetKinds?.sink !== undefined;

        // Only a complete binding reaches the doc. Anything less deletes the key,
        // so the doc is `NodeSchema`-valid at every intermediate step and the
        // client-side `PipelineVersionWriteSchema.parse` on save can never see a
        // half pair — see `pendingBindings` for why that matters.
        //
        // The sink key is OMITTED, never assigned `undefined`. M12 slice 1
        // (#1220) went to some trouble to keep `null` (the end was stripped on
        // import) distinct from ABSENT (there is no sink end), and a
        // present-`undefined` would be a third spelling — one that survives
        // `toEqual` unnoticed and reaches `JSON.stringify` as a dropped key.
        // `portability/export.ts`'s `stripNodeDatasetIds` uses this idiom for
        // the same reason.
        //
        // A source-only binding DROPS any sink it inherited, rather than
        // carrying it forward. Reachable through an imported or API-seeded doc:
        // `current` spreads the node's existing pair, so editing only the source
        // of a node whose entry declares no sink would re-commit the stale sink
        // — and no picker is rendered for that end, so nothing could ever clear
        // it. Inert at dispatch (the executor resolves a sink dataset only when
        // the catalog declares the kinds), but "only a complete binding reaches
        // the doc" should be true because this function makes it true, not
        // because a later layer ignores the difference.
        const bound =
          source === undefined
            ? undefined
            : !needsBothEnds
              ? { source }
              : sink !== undefined
                ? { source, sink }
                : undefined;
        const complete = bound !== undefined;
        const wasCommitted = committed !== undefined;
        if (complete || wasCommitted) {
          edit((s) => ({
            nodes: s.nodes.map((n) => {
              if (n.id !== id) return n;
              const next = { ...n };
              // Narrowed by KIND rather than written through `next[field]`,
              // because the two fields have genuinely different types: a
              // `connectionIds` requires both ends and a `datasetIds` does not,
              // so the union index signature demands a value valid for BOTH and
              // a source-only pair is not. Splitting it keeps that difference
              // checked instead of casting past it.
              if (bound === undefined) delete next[field];
              else if (kind === 'datasets') next.datasetIds = bound;
              else if (bound.sink !== undefined)
                next.connectionIds = { source: bound.source, sink: bound.sink };
              // A connections pair with no sink is unreachable — `needsBothEnds`
              // is unconditionally true for that kind — and is left as a no-op
              // rather than a cast asserting what the branch above already
              // establishes.
              return next;
            }),
          }));
        }

        // The remainder — NOT through `edit()`. Selection state, not document
        // state: picking one end must not dirty the doc or push an undo step.
        set((s) => {
          const forNode = { ...s.pendingBindings[id] };
          // DELETE, not assign-empty, when nothing is left half-picked. An
          // assigned `{source: undefined, sink: undefined}` is still a truthy
          // object, and `NodePanel` reads `thisNode?.connectionIds ?? pending?.connections`
          // — a `??` that an empty object satisfies. That made `halfBound` true
          // for a node the author had just returned to fully blank (pick a
          // source, then reselect "— none —"), so the panel claimed a
          // half-bound pair was going unsaved when nothing was bound at all.
          const emptied = source === undefined && sink === undefined;
          if (complete || emptied) delete forNode[kind];
          else forNode[kind] = { source, sink };
          const rest = { ...s.pendingBindings };
          if (forNode.connections === undefined && forNode.datasets === undefined) delete rest[id];
          else rest[id] = forNode;
          return { pendingBindings: rest };
        });
      },

      addParam() {
        edit((s) => ({ params: [...s.params, blankParam(s.params)] }));
      },

      updateParam(index, next) {
        if (!inRange(index, get().params.length)) return;
        const current = get().params[index]!;
        edit(
          (s) => ({ params: s.params.map((p, i) => (i === index ? next : p)) }),
          rowCoalesceKey('param', index, current, next),
        );
      },

      removeParam(index) {
        if (!inRange(index, get().params.length)) return;
        edit((s) => ({ params: s.params.filter((_, i) => i !== index) }));
      },

      addOutput() {
        edit((s) => ({ outputs: [...s.outputs, blankOutput(s.outputs)] }));
      },

      updateOutput(index, next) {
        if (!inRange(index, get().outputs.length)) return;
        const current = get().outputs[index]!;
        edit(
          (s) => ({ outputs: s.outputs.map((o, i) => (i === index ? next : o)) }),
          rowCoalesceKey('output', index, current, next),
        );
      },

      removeOutput(index) {
        if (!inRange(index, get().outputs.length)) return;
        edit((s) => ({ outputs: s.outputs.filter((_, i) => i !== index) }));
      },

      /**
       * IDEMPOTENT — re-selecting what is already selected is a no-op.
       *
       * #737: the canvas now mirrors React Flow's selection back into the store,
       * while the store drives RF's edge `selected` prop. Writing an equal-but-new
       * `Selection` object on every RF report would re-render the canvas, rebuild
       * the derived edge array and hand RF a fresh selection state, which reports
       * again — a loop that the value guard, not a `useEffect` dependency, is what
       * actually stops.
       *
       * NOT an edit: a selection is not part of the doc, so it records no undo
       * entry and undo never restores one (it only CLEARS a selection its restored
       * doc no longer contains).
       */
      select(sel) {
        get().setSelection(sel === null ? [] : [sel]);
      },

      setSelection(next) {
        const normalised = containerExclusive(next);
        if (sameSelectionSet(get().selected, normalised)) return;
        set({ selected: normalised });
      },

      undo() {
        const s = get();
        const previous = s.past[s.past.length - 1];
        if (previous === undefined) return;
        coalescing = null;
        set({
          ...restoreFrom(previous, s),
          past: s.past.slice(0, -1),
          // Bounded by `past`, which is capped, so this needs no cap of its own.
          future: [...s.future, snapshotOf(s)],
        });
      },

      redo() {
        const s = get();
        const next = s.future[s.future.length - 1];
        if (next === undefined) return;
        coalescing = null;
        set({
          ...restoreFrom(next, s),
          past: [...s.past, snapshotOf(s)].slice(-HISTORY_LIMIT),
          future: s.future.slice(0, -1),
        });
      },
    };
  });
}
