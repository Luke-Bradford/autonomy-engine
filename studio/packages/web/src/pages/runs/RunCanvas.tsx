import { memo, useEffect, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  type Node as FlowNode,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { RunState } from '@autonomy-studio/shared';
import { EdgeMarkers } from '../pipeline/EdgeMarkers';
import { SOURCE_PORT_ID, TARGET_PORT_ID } from '../pipeline/ports';
import {
  mergeRunNodes,
  NO_STATUS_LABEL,
  runFlowEdges,
  runFlowNodes,
  toneClass,
  type RunContainerData,
  type RunDoc,
  type RunNodeData,
} from './runFlow';

/**
 * U11 — the authored graph, drawn with a run's state over it.
 *
 * A SEPARATE renderer from the author canvas, deliberately, and the alternative
 * was considered first: `FlowCanvas` takes a `CanvasState` store, so the monitor
 * could have hydrated one with `loadVersion` and passed a `readOnly` flag. Three
 * things make that wrong rather than merely inelegant:
 *
 *  1. `loadVersion` is LOSSY BY DESIGN — it lowers nodes through the catalog and
 *     DROPS an edge whose endpoint resolves to neither a node nor a container,
 *     so the author sees the contract a save would mint. Correct there; wrong
 *     here. The projection is folded over the SERVER's doc, so an edge the store
 *     silently removed would leave a node marked `skipped` with no visible cause
 *     — the overlay disagreeing with the graph beneath it is the one failure
 *     this view exists to prevent.
 *  2. React Flow's interaction flags (`nodesDraggable` and friends) never reach
 *     a custom node's own DOM, so a `readOnly` `FlowCanvas` would still render
 *     the container's ✕ delete button — a live graph EDIT on a monitor.
 *  3. Every future author affordance would have to remember the monitor.
 *
 * What is shared is what must not diverge, and it is shared as CODE rather than
 * by convention: the geometry (`containerRects`, `containerHandles`,
 * `UNMEASURED_NODE_SIZE`), the edge vocabulary and its one `EdgeMarkers` def
 * set, the port ids, the node label rule, and the CSS classes — all reached
 * through `runFlow.ts`. The ONE handler it wires is `onNodesChange`, and only so
 * React Flow's own measurements land back on the node objects (see below) — no
 * gesture on this canvas can author anything, because nothing here reads from or
 * writes to a canvas store.
 */

/**
 * An activity with its run status. Reuses `.flow-node` (and `.flow-node-sub`)
 * so the box, type scale and spacing are the author canvas's, with the status
 * carried by an ADDITIONAL class rather than by overriding anything.
 *
 * The status word is rendered as TEXT beside the colour. Ten engine statuses
 * share five hues, so colour alone would collapse `retry_pending`,
 * `wait_pending`, `external_wait_pending` and `waiting` into one indistinguish-
 * able amber. Colour narrows it to a family; the label says which member.
 *
 * The word comes from `nodeStatus.ts` (U25), which the run TABLE renders
 * through as well — so the two surfaces cannot describe one node differently.
 * That map is also what turns those four into distinct sentences rather than
 * four spellings of "held".
 */
const RunActivityNode = memo(function RunActivityNode({ data }: NodeProps) {
  const d = data as RunNodeData;
  return (
    <div className={`flow-node run-node${toneClass('run-node', d.tone)}`}>
      <Handle type="target" id={TARGET_PORT_ID} position={Position.Left} />
      <strong>{d.title}</strong>
      <span className="flow-node-sub run-node-status">{d.status ?? NO_STATUS_LABEL}</span>
      <Handle type="source" id={SOURCE_PORT_ID} position={Position.Right} />
    </div>
  );
});

/**
 * A container box with its run status. The author canvas's box, minus the
 * delete button — the reason this file exists rather than a `readOnly` prop.
 */
const RunContainerNode = memo(function RunContainerNode({ data }: NodeProps) {
  const d = data as RunContainerData;
  return (
    <div className={`flow-container run-container${toneClass('run-container', d.tone)}`}>
      <Handle type="target" id={TARGET_PORT_ID} position={Position.Left} />
      <span className="flow-container-label">
        {d.kind}
        {d.status !== null && ` · ${d.status}`}
        {d.round !== null && d.round > 0 && ` · round ${d.round}`}
      </span>
      <Handle type="source" id={SOURCE_PORT_ID} position={Position.Right} />
    </div>
  );
});

// Module-level for a stable identity — a new object each render re-mounts every
// node and warns (the same constraint the author canvas records).
const nodeTypes = { runActivity: RunActivityNode, runContainer: RunContainerNode };

export interface RunCanvasProps {
  /** The immutable version the run is bound to — R1's `pipelineVersion`. */
  doc: RunDoc;
  /** The projected run state, or `null` for "not projected (yet)". */
  state: RunState | null;
}

/**
 * The graph, with the run over it. Self-contained — it supplies its own
 * `ReactFlowProvider`, because the `useReactFlow` family throws without one and
 * this page has no canvas shell to inherit it from.
 */
export function RunCanvas({ doc, state }: RunCanvasProps) {
  /* React Flow owns the VIEW array so it can attach and KEEP each node's
     measured dimensions across renders — the author canvas holds them the same
     way, and for the same reason. `onNodesChange` is wired for that alone: with
     every interaction affordance off, a dimension change is the only change
     React Flow can produce here. */
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const edges = useMemo(() => runFlowEdges(doc), [doc]);

  useEffect(() => {
    setNodes((prev) => mergeRunNodes(prev, runFlowNodes(doc, state)));
  }, [doc, state, setNodes]);

  return (
    <div className="run-canvas" data-testid="run-canvas">
      <ReactFlowProvider>
        <EdgeMarkers />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          /* Read-only, stated on every axis rather than inferred from the fact
             that nothing here would act on an interaction. `onNodesChange` above
             carries measurements, and would happily carry a drag or a selection
             too — these are what stop one being produced in the first place. */
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          /* `null` disables the key entirely — RF's default is Backspace, and a
             delete gesture on a monitor is not a no-op worth risking. */
          deleteKeyCode={null}
          onlyRenderVisibleElements
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          {/* `showInteractive={false}` removes the lock toggle — it flips
              `nodesDraggable`/`elementsSelectable` back ON, which would undo
              every line above from the UI. */}
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
