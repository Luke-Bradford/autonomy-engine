import { memo, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { RunState } from '@autonomy-studio/shared';
import { EdgeMarkers } from '../pipeline/EdgeMarkers';
import { SOURCE_PORT_ID, TARGET_PORT_ID } from '../pipeline/ports';
import {
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
 * through `runFlow.ts`. This component adds NO handlers at all, so there is no
 * mutation surface to have to disable.
 */

/**
 * An activity with its run status. Reuses `.flow-node` (and `.flow-node-sub`)
 * so the box, type scale and spacing are the author canvas's, with the status
 * carried by an ADDITIONAL class rather than by overriding anything.
 *
 * The status word is rendered as TEXT beside the colour. Ten engine statuses
 * share five hues, so colour alone would collapse `retry_pending`,
 * `wait_pending`, `external_wait_pending` and `waiting` into one indistinguish-
 * able amber — the same lossy vocabulary the doc-free table already had. Colour
 * narrows it to a family; the label says which member.
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
  const nodes = useMemo(() => runFlowNodes(doc, state), [doc, state]);
  const edges = useMemo(() => runFlowEdges(doc), [doc]);

  return (
    <div className="run-canvas" data-testid="run-canvas">
      <ReactFlowProvider>
        <EdgeMarkers />
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          /* Read-only, stated on every axis rather than left to the absence of
             handlers: no change callback is wired, so React Flow would drop an
             interaction anyway, but a later edit that adds one must not silently
             make the MONITOR authorable. */
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
