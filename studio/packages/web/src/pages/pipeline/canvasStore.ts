import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  getActivity,
  isStructuralCallActivity,
  lowerPipelineNodes,
  type Container,
  type Edge,
  type Node,
  type PipelineVersion,
  type Position,
} from '@autonomy-studio/shared';
import { newLocalId } from '../../lib/ids';
import { retypeCollides, type EdgeCondition } from './edgeCondition';
import { connectRejection, precomputeConnect } from './connectRules';

/** What the property panel is currently editing. */
export interface Selection {
  kind: 'node' | 'edge';
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
 * is pure `Container[] -> Container[]`. Exported for its own tests and for U6d,
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

export interface CanvasState {
  /**
   * The immutable version the canvas was opened on (`null` = a brand-new
   * pipeline with no versions). Kept so a save can carry forward the parts of
   * the doc this slice has no UI for (`params`/`outputs`) and so "Save" rebases
   * onto the new version it creates.
   */
  loaded: PipelineVersion | null;
  /** The working graph — the store owns its own copy (never the loaded arrays). */
  nodes: Node[];
  edges: Edge[];
  /**
   * The doc's containers — WORKING state as of #746, not a view of `loaded`.
   *
   * The canvas cannot yet CREATE one or move a node in or out (U6d/#425), so
   * they look like pass-through: seeded on load, drawn by `FlowCanvas`, fed to
   * the connect rules, written back on save. But membership is not read-only,
   * because deleting a node changes it. While these were read off `loaded`,
   * `deleteNode` had nothing to prune, so the deleted id stayed listed as a
   * child and every later save was refused (`child '<id>' is not a node in this
   * pipeline`) with no canvas affordance to repair it.
   */
  containers: Container[];
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
   * Append an edge from `from` to `to` carrying `condition`. Refuses (no-op) a
   * candidate `connectRejection` rejects — a self-loop, an endpoint that is not
   * a current node/container, a duplicate, or an edge that would close a forward
   * cycle.
   *
   * Takes a whole `EdgeCondition` rather than an `EdgeOn`: `on: 'branch'` is only
   * half an edge (the label is the routing key), so the looser signature could
   * author an edge `EdgeSchema` does not accept.
   */
  connect(from: string, to: string, condition: EdgeCondition): void;
  deleteEdge(id: string): void;
  /**
   * Retype an edge to a new condition. Refuses (no-op) a retype that would make
   * the edge a DUPLICATE of another — see `retypeCollides`.
   */
  updateEdgeCondition(id: string, condition: EdgeCondition): void;
  updateNodeConfig(id: string, config: Record<string, unknown>): void;
  setNodeConnection(id: string, connectionId: string | undefined): void;
  select(sel: Selection | null): void;
}

/**
 * A vanilla (framework-free) zustand store holding the canvas working graph.
 * Vanilla — not a React hook — so every mutation is unit-testable without a DOM
 * (`store.getState().addNode(...)`); the React canvas subscribes via
 * `useStore(store, selector)`. Actions are the SINGLE place the graph mutates,
 * which is what keeps the engine's global-id / no-dangling-edge invariants
 * intact: `deleteNode` cascades to incident edges and `connect` refuses a
 * self-loop or an endpoint that is not a current node.
 */
export function createCanvasStore(): StoreApi<CanvasState> {
  return createStore<CanvasState>((set, get) => ({
    loaded: null,
    nodes: [],
    edges: [],
    containers: [],
    selected: null,
    dirty: false,
    addCount: 0,

    loadVersion(v) {
      // Built ONCE rather than per edge: the two ids that share one namespace
      // (see the edge filter below for why containers belong in here).
      const endpointIds = new Set<string>(
        v ? [...v.nodes.map((n) => n.id), ...v.containers.map((c) => c.id)] : [],
      );
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
        // and both delete paths cascade) — the reachable sources are the API and
        // a git import, which the write gate now closes.
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
        // live hazard the moment U6d edits membership in place — latent sharing
        // that is free to rule out here.
        containers: v ? v.containers.map((c) => ({ ...c, children: [...c.children] })) : [],
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
          // re-authorable on the canvas until U6d/#425 — so a cascade destroys
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
          // A container is not a `Selection` kind — nothing can select one — so
          // only a selected EDGE the cascade just removed can be stranded.
          selected:
            s.selected?.kind === 'edge' && removedEdgeIds.has(s.selected.id) ? null : s.selected,
          dirty: true,
        };
      });
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
    connect(from, to, condition) {
      const graph = {
        nodes: get().nodes,
        edges: get().edges,
        containers: get().containers,
      };
      if (connectRejection(precomputeConnect(graph), { from, to, condition }) !== null) return;
      const edge = { id: newLocalId('e'), from, to, ...condition } as Edge;
      set((s) => ({ edges: [...s.edges, edge], dirty: true }));
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
    select(sel) {
      if (sameSelection(get().selected, sel)) return;
      set({ selected: sel });
    },
  }));
}
