import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  getActivity,
  isStructuralCallActivity,
  lowerPipelineNodes,
  type EdgeOn,
  type Edge,
  type Node,
  type PipelineVersion,
  type Position,
} from '@autonomy-studio/shared';
import { newLocalId } from '../../lib/ids';
import { authoringEdgeKey, retypeCollides, type EdgeCondition } from './edgeCondition';

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

export interface CanvasState {
  /**
   * The immutable version the canvas was opened on (`null` = a brand-new
   * pipeline with no versions). Kept so a save can carry forward the parts of
   * the doc this slice has no UI for (`params`/`outputs`/`containers`) and so
   * "Save" rebases onto the new version it creates.
   */
  loaded: PipelineVersion | null;
  /** The working graph — the store owns its own copy (never the loaded arrays). */
  nodes: Node[];
  edges: Edge[];
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
  connect(from: string, to: string, on: EdgeOn): void;
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
    selected: null,
    dirty: false,
    addCount: 0,

    loadVersion(v) {
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
        edges: v ? v.edges.map((e) => ({ ...e })) : [],
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
          s.selected &&
          ((s.selected.kind === 'node' && s.selected.id === id) ||
            (s.selected.kind === 'edge' && removedEdgeIds.has(s.selected.id)))
            ? null
            : s.selected;
        return {
          nodes: s.nodes.filter((n) => n.id !== id),
          edges: s.edges.filter((e) => e.from !== id && e.to !== id),
          selected,
          dirty: true,
        };
      });
    },

    connect(from, to, on) {
      if (from === to) return; // no self-loops
      const ids = new Set(get().nodes.map((n) => n.id));
      if (!ids.has(from) || !ids.has(to)) return; // both endpoints must be nodes
      const edge: Edge = { id: newLocalId('e'), from, to, on };
      const key = authoringEdgeKey(edge);
      if (get().edges.some((e) => authoringEdgeKey(e) === key)) return; // dedupe
      set((s) => ({ edges: [...s.edges, edge], dirty: true }));
    },

    deleteEdge(id) {
      if (!get().edges.some((e) => e.id === id)) return;
      set((s) => ({
        edges: s.edges.filter((e) => e.id !== id),
        selected: s.selected?.kind === 'edge' && s.selected.id === id ? null : s.selected,
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
