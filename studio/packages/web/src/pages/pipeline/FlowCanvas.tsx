import { memo, useEffect } from 'react';
import { useStore } from 'zustand';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getActivity } from '@autonomy-studio/shared';
import type { StoreApi } from 'zustand';
import type { CanvasState } from './canvasStore';

interface ActivityData extends Record<string, unknown> {
  title: string;
  hasConnection: boolean;
}

/**
 * The custom activity node. Memoised — React Flow re-renders the node layer on
 * every viewport change, so a memo keeps a stable node cheap. One target handle
 * (incoming edges) and one source handle (outgoing) match the engine's single
 * in/out node model; edge branch (`on`) is chosen after connecting, in the
 * property panel.
 */
const ActivityNode = memo(function ActivityNode({ data, selected }: NodeProps) {
  const d = data as ActivityData;
  return (
    <div className={`flow-node${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <strong>{d.title}</strong>
      <span className="flow-node-sub">
        {d.hasConnection ? 'connection bound' : 'no connection'}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

// Module-level constant: React Flow requires a stable `nodeTypes` identity (a
// new object each render re-mounts every node and warns).
const nodeTypes = { activity: ActivityNode };

/**
 * Renders the working graph with React Flow. The zustand store is the DOMAIN
 * source of truth (Node/Edge schema shapes); React Flow owns the VIEW node
 * array (via `useNodesState`) so it can attach and keep each node's measured
 * dimensions across renders — deriving brand-new node objects every render
 * would drop `measured` and make connected edges flicker on every drag tick.
 * The two are reconciled: store changes (add/delete/config/connection/select)
 * flow INTO the view array preserving each surviving node's live position and
 * measured size; view changes (drag/remove) flow BACK into the store. Edges,
 * which carry no measured state, are derived straight from the store.
 * `onlyRenderVisibleElements` keeps a large graph responsive.
 */
export function FlowCanvas({ store }: { store: StoreApi<CanvasState> }) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const selected = useStore(store, (s) => s.selected);

  const [flowNodes, setFlowNodes, onNodesChangeRaw] = useNodesState<FlowNode>([]);

  // Reconcile store → view: rebuild the view array from the domain nodes,
  // carrying forward each surviving node's live position and measured size so
  // React Flow never re-initialises (and never flickers) an existing node.
  useEffect(() => {
    setFlowNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const existing = byId.get(n.id);
        return {
          ...existing,
          id: n.id,
          type: 'activity',
          // Keep React Flow's live position during/after a drag; fall back to
          // the domain position for a freshly-added node.
          position: existing?.position ?? n.position,
          data: {
            title: getActivity(n.type)?.title ?? n.type,
            hasConnection: n.connectionId != null,
          } satisfies ActivityData,
          selected: selected?.kind === 'node' && selected.id === n.id,
        };
      });
    });
  }, [nodes, selected, setFlowNodes]);

  const flowEdges: FlowEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.on,
    selected: selected?.kind === 'edge' && selected.id === e.id,
  }));

  function onNodesChange(changes: NodeChange[]) {
    // Apply every change to the view first (this is where React Flow records
    // measured dimensions and the in-progress drag position).
    onNodesChangeRaw(changes);
    const st = store.getState();
    for (const c of changes) {
      // Commit a move to the domain store once the drag settles (or for a
      // programmatic move) — not on every mid-drag tick, so the domain graph
      // doesn't churn while dragging.
      if (c.type === 'position' && c.position && c.dragging !== true) {
        st.moveNode(c.id, c.position);
      } else if (c.type === 'remove') {
        st.deleteNode(c.id);
      }
    }
  }

  function onEdgesChange(changes: EdgeChange[]) {
    const st = store.getState();
    for (const c of changes) {
      if (c.type === 'remove') st.deleteEdge(c.id);
    }
  }

  function onConnect(conn: Connection) {
    // A freshly-drawn edge defaults to the `success` branch; the operator
    // re-picks the branch by selecting the edge in the property panel.
    if (conn.source && conn.target) store.getState().connect(conn.source, conn.target, 'success');
  }

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeClick={(_, node) => store.getState().select({ kind: 'node', id: node.id })}
      onEdgeClick={(_, edge) => store.getState().select({ kind: 'edge', id: edge.id })}
      onPaneClick={() => store.getState().select(null)}
      onlyRenderVisibleElements
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background />
      <MiniMap pannable zoomable />
      <Controls />
    </ReactFlow>
  );
}
