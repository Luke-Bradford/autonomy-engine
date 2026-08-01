import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  ContainerSchema,
  getActivity,
  isStructuralCallActivity,
  lowerPipelineNodes,
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
  DEFAULT_MAX_BOUNCES,
  isMaxBounces,
  retypeCollides,
  type EdgeCondition,
} from './edgeCondition';
import { connectRejection, edgeEndpointIds, precomputeConnect } from './connectRules';
import { blankOutput, blankParam } from './paramRules';

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
 * explicit button on its box, and cleared only by a pane click or by its own
 * deletion — never by `nextSelection`, which speaks for RF.
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
 * #737 — the next single selection after React Flow reports that `target`
 * became (or stopped being) selected.
 *
 * The canvas mirrors RF's selection into the store one `select` CHANGE at a
 * time, so this has to be decided per element, without the full selected set.
 *
 * The DESELECT guard is the load-bearing half. RF emits a select and the
 * matching deselects in one batch and across BOTH element kinds:
 * `addSelectedNodes` calls `triggerNodeChanges` and then
 * `triggerEdgeChanges(getSelectionChanges(edgeLookup, …))`, so selecting node A
 * arrives as `{A, selected:true}` immediately followed by a `selected:false` for
 * every other node AND every edge. Clearing on any deselect would therefore undo
 * the selection microseconds after making it — the panel would flicker open and
 * shut on every click. Only the CURRENT selection's own deselect clears.
 */
export function nextSelection(
  current: Selection | null,
  target: Selection,
  selected: boolean,
): Selection | null {
  if (selected) return target;
  return sameSelection(current, target) ? null : current;
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
      error: parsed.error.issues.map((i) => `${i.path.join('.') || kind}: ${i.message}`).join('; '),
    };
  }
  return { container: parsed.data };
}

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
  selected: Selection | null;
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
  moveNode(id: string, position: Position): void;
  deleteNode(id: string): void;
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
   * Retype an edge to a new condition. Refuses (no-op) a retype that would make
   * the edge a DUPLICATE of another — see `retypeCollides`.
   */
  updateEdgeCondition(id: string, condition: EdgeCondition): void;
  updateNodeConfig(id: string, config: Record<string, unknown>): void;
  setNodeConnection(id: string, connectionId: string | undefined): void;
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
  select(sel: Selection | null): void;
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
  return createStore<CanvasState>((set, get) => ({
    loaded: null,
    nodes: [],
    edges: [],
    containers: [],
    params: [],
    outputs: [],
    selected: null,
    dirty: false,
    addCount: 0,

    loadVersion(v) {
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
        selected: null,
        dirty: false,
        addCount: 0,
      });
    },

    rebaseLoaded(v) {
      set({ loaded: v });
    },

    addNode(type, position) {
      if (!getActivity(type)) return; // unknown catalog type — ignore rather than author garbage
      // A structural-call activity (`execute_pipeline`) stores its settings in
      // `node.call`, not `node.config`, so this generic config-form path would
      // author a call-less, un-saveable node. Refuse it (the toolbox also hides
      // its entry, and the drop path refuses the payload); call-node authoring is
      // #425. Both guards run for a DROPPED node too — a position argument is
      // placement, never a bypass.
      if (isStructuralCallActivity(type)) return;
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
      set((s) => ({
        nodes: [...s.nodes, node],
        // Only a stagger consumes a slot — see the `addCount` doc.
        addCount: position ? s.addCount : s.addCount + 1,
        dirty: true,
      }));
    },

    moveNode(id, position) {
      if (!get().nodes.some((n) => n.id === id)) return;
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, position } : n)),
        dirty: true,
      }));
    },

    deleteNode(id) {
      if (!get().nodes.some((n) => n.id === id)) return;
      set((s) => {
        const removedEdgeIds = new Set(
          s.edges.filter((e) => e.from === id || e.to === id).map((e) => e.id),
        );
        const selected =
          sameSelection(s.selected, { kind: 'node', id }) ||
          (s.selected?.kind === 'edge' && removedEdgeIds.has(s.selected.id))
            ? null
            : s.selected;
        return {
          nodes: s.nodes.filter((n) => n.id !== id),
          edges: s.edges.filter((e) => e.from !== id && e.to !== id),
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
          containers: pruneContainerChild(s.containers, id),
          selected,
          dirty: true,
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
     * The container's own `exitWhen`/`items`/`maxRounds`/`timeout` IS lost, and
     * there is no undo. That is why the canvas confirms before calling this, and
     * why the confirmation names what goes and what stays.
     */
    deleteContainer(id) {
      if (!get().containers.some((c) => c.id === id)) return;
      set((s) => {
        const removedEdgeIds = new Set(
          s.edges.filter((e) => e.from === id || e.to === id).map((e) => e.id),
        );
        return {
          containers: s.containers.filter((c) => c.id !== id),
          edges: s.edges.filter((e) => e.from !== id && e.to !== id),
          // Two ways to strand a selection here: an EDGE the cascade removed,
          // and — since U23 — the deleted CONTAINER itself. RF drives neither
          // clear (it never sees a container at all, and the edge is gone
          // before it could emit a deselect), so both are this action's job.
          selected:
            (s.selected?.kind === 'edge' && removedEdgeIds.has(s.selected.id)) ||
            (s.selected?.kind === 'container' && s.selected.id === id)
              ? null
              : s.selected,
          dirty: true,
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
      set((st) => ({ containers: containersWithNew(st.containers, c), dirty: true }));
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
      set({ containers: next, dirty: true });
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
      set((st) => ({ containers: containersWithUpdated(st.containers, next), dirty: true }));
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
      set((s) => ({ edges: [...s.edges, edge], dirty: true }));
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
      set((s) => ({
        edges: s.edges.map((e) => (e.id === id ? { ...e, maxBounces } : e)),
        dirty: true,
      }));
    },

    deleteEdge(id) {
      if (!get().edges.some((e) => e.id === id)) return;
      set((s) => ({
        edges: s.edges.filter((e) => e.id !== id),
        selected: sameSelection(s.selected, { kind: 'edge', id }) ? null : s.selected,
        dirty: true,
      }));
    },

    /**
     * Retype an edge, refusing a retype that would DUPLICATE another edge.
     *
     * `connect`'s dedupe is not enough on its own: retyping walks straight
     * around it (connect A→B `success`, retype it to `skipped`, connect A→B
     * `success` again, retype THAT to `skipped` → two byte-identical edges).
     * Nothing downstream catches it — `validatePipelineDoc` has no duplicate-
     * EDGE rule, its id-uniqueness check covers nodes and containers only — and
     * the consequences are real: the two share one edge identity, so as
     * back-edges they halve `maxBounces` and resolve each other's reset body,
     * and on the canvas they stack as overlapping SVG paths neither of which
     * can be clicked apart. U6a multiplies the reachable surface by every
     * branch label a source declares, so the guard belongs here, not only in
     * `connect`.
     *
     * A REFUSAL is right rather than a silent merge: the operator still has the
     * edge they selected, and deleting one of two identical edges is a thing
     * they can see and do. It is also not the operator's first warning —
     * `EdgePanel` disables a condition another edge already holds, using the
     * SAME `retypeCollides` predicate, so a refusal here is the backstop for a
     * caller that is not the picker, not the UX.
     */
    updateEdgeCondition(id, condition) {
      const current = get().edges.find((e) => e.id === id);
      if (current === undefined) return;
      const retyped = retypeEdge(current, condition);
      if (retypeCollides(get().edges, current, retyped)) return;
      set((s) => ({
        edges: s.edges.map((e) => (e.id === id ? retyped : e)),
        dirty: true,
      }));
    },

    updateNodeConfig(id, config) {
      if (!get().nodes.some((n) => n.id === id)) return;
      set((s) => ({
        nodes: s.nodes.map((n) => (n.id === id ? { ...n, config } : n)),
        dirty: true,
      }));
    },

    setNodeConnection(id, connectionId) {
      if (!get().nodes.some((n) => n.id === id)) return;
      set((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== id) return n;
          const next = { ...n };
          if (connectionId) next.connectionId = connectionId;
          else delete next.connectionId;
          return next;
        }),
        dirty: true,
      }));
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
     */
    addParam() {
      set((s) => ({ params: [...s.params, blankParam(s.params)], dirty: true }));
    },

    updateParam(index, next) {
      set((s) => ({
        params: s.params.map((p, i) => (i === index ? next : p)),
        dirty: true,
      }));
    },

    removeParam(index) {
      set((s) => ({ params: s.params.filter((_, i) => i !== index), dirty: true }));
    },

    addOutput() {
      set((s) => ({ outputs: [...s.outputs, blankOutput(s.outputs)], dirty: true }));
    },

    updateOutput(index, next) {
      set((s) => ({
        outputs: s.outputs.map((o, i) => (i === index ? next : o)),
        dirty: true,
      }));
    },

    removeOutput(index) {
      set((s) => ({ outputs: s.outputs.filter((_, i) => i !== index), dirty: true }));
    },

    select(sel) {
      if (sameSelection(get().selected, sel)) return;
      set({ selected: sel });
    },
  }));
}
