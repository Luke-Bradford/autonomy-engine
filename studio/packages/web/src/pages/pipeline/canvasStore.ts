import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  getActivity,
  type EdgeOn,
  type Edge,
  type Node,
  type PipelineVersion,
  type Position,
} from '@autonomy-studio/shared';
import { newLocalId } from '../../lib/ids';

/** What the property panel is currently editing. */
export interface Selection {
  kind: 'node' | 'edge';
  id: string;
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
  /** Monotonic counter so successive palette adds don't stack at one point. */
  addCount: number;

  loadVersion(v: PipelineVersion | null): void;
  /**
   * Point `loaded` at a new version WITHOUT touching the working graph or the
   * dirty flag — used after a save when the operator kept editing during the
   * in-flight request, so their edits are not clobbered by the just-saved graph.
   */
  rebaseLoaded(v: PipelineVersion): void;
  addNode(type: string): void;
  moveNode(id: string, position: Position): void;
  deleteNode(id: string): void;
  connect(from: string, to: string, on: EdgeOn): void;
  deleteEdge(id: string): void;
  updateEdgeOn(id: string, on: EdgeOn): void;
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
        loaded: v,
        // Deep-ish copy: fresh arrays with fresh node/edge objects so editing
        // the working graph never mutates the loaded version in place.
        nodes: v ? v.nodes.map((n) => ({ ...n })) : [],
        edges: v ? v.edges.map((e) => ({ ...e })) : [],
        selected: null,
        dirty: false,
        addCount: 0,
      });
    },

    rebaseLoaded(v) {
      set({ loaded: v });
    },

    addNode(type) {
      const entry = getActivity(type);
      if (!entry) return; // unknown catalog type — ignore rather than author garbage
      const n = get().addCount;
      const node: Node = {
        id: newLocalId('n'),
        type,
        // Seed the node's declared output contract from the catalog template
        // (the run-time SSOT is the node's own config.outputs, see catalog docs).
        config: { outputs: entry.outputs.map((o) => ({ ...o })) },
        // Stagger so repeated adds don't stack exactly on top of each other.
        position: { x: 80 + (n % 5) * 40, y: 80 + (n % 5) * 40 },
      };
      set((s) => ({ nodes: [...s.nodes, node], addCount: s.addCount + 1, dirty: true }));
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
      if (get().edges.some((e) => e.from === from && e.to === to && e.on === on)) return; // dedupe
      const edge: Edge = { id: newLocalId('e'), from, to, on };
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

    updateEdgeOn(id, on) {
      if (!get().edges.some((e) => e.id === id)) return;
      set((s) => ({
        edges: s.edges.map((e) => (e.id === id ? { ...e, on } : e)),
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

    select(sel) {
      set({ selected: sel });
    },
  }));
}
