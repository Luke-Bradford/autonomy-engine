import { memo } from 'react';
import { useStore } from 'zustand';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
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
 * Renders the store's working graph with React Flow. The store is the single
 * source of truth: flow nodes/edges are DERIVED from it each render, and every
 * interaction (drag, connect, delete, select) is translated straight into a
 * store action. `onlyRenderVisibleElements` keeps a large graph responsive.
 */
export function FlowCanvas({ store }: { store: StoreApi<CanvasState> }) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const selected = useStore(store, (s) => s.selected);

  const flowNodes: FlowNode[] = nodes.map((n) => ({
    id: n.id,
    type: 'activity',
    position: n.position,
    data: {
      title: getActivity(n.type)?.title ?? n.type,
      hasConnection: n.connectionId != null,
    } satisfies ActivityData,
    selected: selected?.kind === 'node' && selected.id === n.id,
  }));

  const flowEdges: FlowEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.on,
    selected: selected?.kind === 'edge' && selected.id === e.id,
  }));

  function onNodesChange(changes: NodeChange[]) {
    const st = store.getState();
    for (const c of changes) {
      if (c.type === 'position' && c.position) st.moveNode(c.id, c.position);
      else if (c.type === 'remove') st.deleteNode(c.id);
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
