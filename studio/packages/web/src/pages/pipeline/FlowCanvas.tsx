import { memo, useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { useStore } from 'zustand';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type FinalConnectionState,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getActivity, type ContainerKind } from '@autonomy-studio/shared';
import type { StoreApi } from 'zustand';
import { hasActivityDragType, readActivityDragType } from './activityDnd';
import { edgeAriaLabel, edgeArrowMarkerId, edgeLabel, edgeVariantClass } from './edgeCondition';
import { EdgeMarkers } from './EdgeMarkers';
import { connectRejection, precomputeConnect, type ConnectRejection } from './connectRules';
import { containerRects } from './containerLayout';
import { DRAWN_EDGE_CONDITION, orientDrawnEnds, SOURCE_PORT_ID, TARGET_PORT_ID } from './ports';
import { nextSelection, type CanvasState, type Selection } from './canvasStore';

interface ActivityData extends Record<string, unknown> {
  title: string;
  hasConnection: boolean;
}

/**
 * The custom activity node. Memoised — React Flow re-renders the node layer on
 * every viewport change, so a memo keeps a stable node cheap.
 *
 * One target port (incoming edges) and one source port (outgoing) match the
 * engine's single in/out node model; which outcome an edge routes is chosen
 * afterwards, in the property panel. Both handles are now IDENTIFIED (U6b) —
 * `ports.ts` says why, and why U19 is where the source side becomes one port per
 * outcome.
 */
const ActivityNode = memo(function ActivityNode({ data, selected }: NodeProps) {
  const d = data as ActivityData;
  return (
    <div className={`flow-node${selected ? ' selected' : ''}`}>
      <Handle type="target" id={TARGET_PORT_ID} position={Position.Left} />
      <strong>{d.title}</strong>
      <span className="flow-node-sub">
        {d.hasConnection ? 'connection bound' : 'no connection'}
      </span>
      <Handle type="source" id={SOURCE_PORT_ID} position={Position.Right} />
    </div>
  );
});

interface ContainerData extends Record<string, unknown> {
  kind: ContainerKind;
  childCount: number;
}

/**
 * U6c — a container, drawn as the box its children sit in.
 *
 * The header states the KIND in words ('loop' / 'stage' / 'foreach'), not by
 * colour or shape alone — the epic's non-color-status-labels criterion, and the
 * same word `connectRules` names the container by when it refuses a boundary
 * crossing, so a refusal points at something on screen.
 *
 * BOTH handle types, with the ids every edge names. `flowEdges` sets
 * `sourceHandle: 'out'` / `targetHandle: 'in'` on every edge uniformly, so a
 * container that is an edge SOURCE needs the source handle and one that is a
 * TARGET needs the target handle. Without them React Flow cannot resolve the
 * endpoint and the edge does not render — which, before U6c, is exactly what
 * happened to every container edge (silently: RF's `onlyRenderVisibleElements`
 * path drops an edge whose endpoint node is missing from the lookup, with no
 * console error to notice it by).
 */
const ContainerNode = memo(function ContainerNode({ data }: NodeProps) {
  const d = data as ContainerData;
  return (
    <div
      className="flow-container"
      role="group"
      aria-label={`${d.kind} container, ${d.childCount} ${d.childCount === 1 ? 'activity' : 'activities'}`}
    >
      <Handle type="target" id={TARGET_PORT_ID} position={Position.Left} />
      <span className="flow-container-label">{d.kind}</span>
      <Handle type="source" id={SOURCE_PORT_ID} position={Position.Right} />
    </div>
  );
});

// Module-level constant: React Flow requires a stable `nodeTypes` identity (a
// new object each render re-mounts every node and warns).
const nodeTypes = { activity: ActivityNode, container: ContainerNode };

/**
 * The size assumed for a node React Flow has not measured yet.
 *
 * Used for ONE frame: `measured` is populated as soon as RF observes the node,
 * and the container box re-derives from the real size on the next render. It
 * exists so the first paint of a freshly-loaded doc has a plausible box instead
 * of a zero-area one, not as a layout constant anything depends on.
 */
const UNMEASURED_NODE_SIZE = { width: 150, height: 52 };

/**
 * Canvas CHROME that must not accept a toolbox drop (U5).
 *
 * React Flow spreads unknown props — including `onDrop`/`onDragOver` — onto its
 * OUTER wrapper, and `<MiniMap>`, `<Controls>` and the attribution all render
 * inside that wrapper via its `Panel` primitive (they share the
 * `react-flow__panel` class). Without this guard, releasing a drag over the
 * minimap would author a node at whatever flow position happens to sit under
 * that screen corner — a placement the operator never pointed at.
 *
 * The same predicate gates `dragover`, so a drag held over the chrome shows the
 * browser's own "no drop" cursor rather than inviting a drop it will discard.
 */
const CANVAS_CHROME_SELECTOR = '.react-flow__panel';

/**
 * Is this drag event over the canvas surface (as opposed to its chrome)?
 *
 * `event.target` — not `currentTarget` (always the wrapper) and not
 * `relatedTarget` (only meaningful on `dragenter`/`dragleave`).
 *
 * Fails CLOSED on a target that is not an `Element`: unreachable in practice
 * (a hit-tested drag target always is one), but "we could not tell where this
 * landed" must not resolve to "author a node there".
 */
function isOverCanvasSurface(event: DragEvent<HTMLDivElement>): boolean {
  const target = event.target;
  return target instanceof Element && target.closest(CANVAS_CHROME_SELECTOR) === null;
}

/**
 * Renders the working graph with React Flow. The zustand store is the DOMAIN
 * source of truth (Node/Edge schema shapes); React Flow owns the VIEW node
 * array (via `useNodesState`) so it can attach and keep each node's measured
 * dimensions across renders — deriving brand-new node objects every render
 * would drop `measured` and make connected edges flicker on every drag tick.
 * The two are reconciled: store changes (add/delete/config/connection/select)
 * flow INTO the view array preserving each surviving node's live position and
 * measured size; view changes (drag/remove/select) flow BACK into the store.
 * Edges, which carry no measured state, are derived straight from the store.
 * `onlyRenderVisibleElements` keeps a large graph responsive.
 *
 * SELECTION is a round trip (#737), and the store is the authority at both ends:
 * React Flow reports a selection as a `select` CHANGE, which the handlers below
 * fold into the store; the store then re-derives `selected` for every node and
 * edge. See `applySelectChange` for why the change handlers — not
 * `onSelectionChange` — are the seam, and the `selected:` line in the reconcile
 * effect for why the view must not be allowed to disagree.
 *
 * The regression check the epic asks for is `e2e/canvas-drag-reconciliation.spec.ts`
 * (U6a). Do NOT try to replace it with a unit test: "an unrelated store change
 * does not remount an existing node" does NOT discriminate, because React keys
 * node elements by id, so DOM identity survives even if the carry-forward below
 * is deleted outright (U5 confirmed that by mutation and deleted the test). The
 * property only diverges while a drag is IN FLIGHT, when the view position
 * leads the domain position and `measured` is already populated — neither of
 * which jsdom can produce, and neither of which survives a settled drag. Both
 * halves of the carry-forward were mutation-checked against that spec.
 *
 * KNOWN LIMIT, for U17/U9/U22: `position` here is carried forward
 * UNCONDITIONALLY, so once a node is in the view array a DOMAIN position write
 * never reaches the screen. That is exactly right mid-drag and wrong for
 * undo-of-a-move (U17), auto-layout (U9) and restore-version (U22), which are
 * all domain position writes. Whoever builds those needs a "domain wins"
 * escape hatch (a move generation/epoch, or clearing the view entry on a
 * programmatic move) — not a relaxation of this line, which the spec above
 * pins.
 */
export function FlowCanvas({ store }: { store: StoreApi<CanvasState> }) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const selected = useStore(store, (s) => s.selected);
  // The LOADED version, selected whole rather than as `s.loaded?.containers ?? []`:
  // that selector would allocate a fresh array on every store read, and zustand
  // compares selector results with `Object.is` — a new reference every time is a
  // re-render loop, not a memo.
  const loaded = useStore(store, (s) => s.loaded);

  const [flowNodes, setFlowNodes, onNodesChangeRaw] = useNodesState<FlowNode>([]);
  /**
   * The ENDS of the last refused connection attempt — not its message.
   *
   * Storing the message would freeze it, and a frozen refusal goes stale as soon
   * as the graph moves under it: delete one of the two activities it names and an
   * assertive `role="alert"` sits there naming something that no longer exists,
   * ready to be re-announced on any incidental re-render. Keeping the ENDS and
   * re-deriving below means the panel always states the reason as it is NOW, and
   * disappears by itself when the obstacle is removed (delete the conflicting
   * edge and the duplicate refusal is simply no longer true).
   */
  const [attempted, setAttempted] = useState<{ from: string; to: string } | null>(null);
  // Converts a pointer position to flow coordinates under the live zoom/pan.
  // Requires the surrounding `ReactFlowProvider` (supplied by `PipelineCanvas`).
  const { screenToFlowPosition } = useReactFlow();

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
          // #737 — RE-DERIVED from the store every time, NOT carried forward in
          // the spread above. The store is the single authority on what is
          // selected, in both directions: the `select` changes below write into
          // it, and this line writes back out.
          //
          // Carrying `selected` forward instead (so React Flow could own node
          // selection and keep a shift-marquee alive) was tried and is WRONG,
          // because the two can then disagree — and React Flow's recovery path
          // is a dead end. `handleNodeClick` early-returns when the node it was
          // given is ALREADY `selected`, emitting no change at all. So any state
          // where the view says selected and the store says not — after a save,
          // where `loadVersion` writes `selected: null` while the view entry
          // survives by id — leaves a node that paints its selection ring,
          // reports nothing to the property panel, and CANNOT be re-selected by
          // clicking it or by Enter. (Backspace would still delete it.) The
          // operator's only way out is to click empty canvas first.
          //
          // The cost of re-deriving, stated plainly: a shift-marquee or
          // ctrl-click collapses to a single selection, so multi-node drag is
          // not available. That is the store's model — one `Selection` — and
          // real multi-select is U21's, which widens it. Consistency beats a
          // capability that leaves the canvas stuck.
          selected: selected?.kind === 'node' && selected.id === n.id,
        };
      });
    });
  }, [nodes, selected, setFlowNodes]);

  /**
   * U6c — the container boxes, DERIVED from the activity nodes rather than held
   * in state.
   *
   * They are deliberately not in the `useNodesState` array. A container's rect is
   * a function of its children's rects, and RF writes measured dimensions back
   * through `onNodesChange`; a container living in that array would therefore be
   * a feedback loop — set nodes, get measured, recompute, set nodes. Deriving
   * breaks it by construction: container geometry depends only on ACTIVITY
   * geometry, never on its own.
   *
   * `containers` come from the LOADED version — the canvas cannot author one yet
   * (U6d) — and are read through the same carry-forward a save writes back.
   */
  const containerNodes: FlowNode[] = useMemo(() => {
    const containers = loaded?.containers ?? [];
    if (containers.length === 0) return [];
    const rects = containerRects(
      containers,
      new Map(
        flowNodes.map((n) => [
          n.id,
          {
            x: n.position.x,
            y: n.position.y,
            width: n.measured?.width ?? UNMEASURED_NODE_SIZE.width,
            height: n.measured?.height ?? UNMEASURED_NODE_SIZE.height,
          },
        ]),
      ),
    );
    return containers.map((c) => {
      const rect = rects.get(c.id)!;
      return {
        id: c.id,
        type: 'container',
        position: { x: rect.x, y: rect.y },
        /* Size as TOP-LEVEL props, not only in `style`. `onlyRenderVisibleElements`
           is on, and RF culls against `measured.width ?? width ?? initialWidth ?? 0`
           — a derived node RF has not measured would otherwise be culled against a
           0×0 box, taking its edges with it (`isEdgeVisible`). */
        width: rect.width,
        height: rect.height,
        style: { width: rect.width, height: rect.height },
        data: {
          kind: c.kind,
          childCount: c.children.length,
        } satisfies ContainerData,
        /* Read-only in U6c: the box states membership, it does not edit it.
           Creating/editing a container and dragging nodes in and out is U6d, and
           the RF `parentId` mapping that would make a container draggable as a
           group is U23's. */
        selectable: false,
        draggable: false,
        deletable: false,
        focusable: false,
        // Behind its children. Both the explicit z-index and the array order
        // below are set: RF sorts by `zIndex` and falls back to array order.
        zIndex: 0,
      } satisfies FlowNode;
    });
  }, [loaded, flowNodes]);

  /** Containers FIRST, so they paint behind the activities they enclose. */
  const renderedNodes = useMemo(
    () => [...containerNodes, ...flowNodes],
    [containerNodes, flowNodes],
  );

  /** Ids RF may report changes for that the domain store must never see. */
  const containerIds = useMemo(() => new Set(containerNodes.map((n) => n.id)), [containerNodes]);

  /**
   * Typed edges (U6a). The variant CLASS goes on React Flow's edge `<g>`, where
   * it sets `--xy-edge-stroke` — NOT an inline `style.stroke`, and not a rule on
   * `.react-flow__edge-path` directly. RF puts `edge.style` inline on the path,
   * which would outrank its own `.react-flow__edge.selected .react-flow__edge-path`
   * rule and silently kill the selection highlight; a competing class rule on
   * the path ties that rule on specificity (0,3,0) and would be decided by
   * stylesheet import order. Setting the custom property one level up keeps RF's
   * selected rule winning on its own terms. (Arrowheads are NOT reached by that
   * variable — RF renders marker defs once, outside every edge `<g>` — so U6b
   * gives them their own defs and their own CSS rules: `EdgeMarkers`.)
   */
  const flowEdges: FlowEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    // The ports are named explicitly rather than left to React Flow's
    // "first handle of this type" fallback: the fallback is what silently
    // mis-attaches every edge the moment a node has TWO source handles (U19).
    sourceHandle: SOURCE_PORT_ID,
    targetHandle: TARGET_PORT_ID,
    label: edgeLabel(e),
    className: edgeVariantClass(e),
    // U6b — the arrowhead, so direction is on screen rather than inferred from
    // which side the endpoints happen to sit on. A STRING marker id references
    // one of `EdgeMarkers`' own defs (RF's object form would need a literal
    // colour, and these hues are custom properties).
    markerEnd: edgeArrowMarkerId(e),
    // RF renders an edge as role="img"/"group"; under either, the SVG <text>
    // label is NOT exposed, so without this the outcome is colour-only.
    ariaLabel: edgeAriaLabel(e),
    selected: selected?.kind === 'edge' && selected.id === e.id,
  }));

  /**
   * #737 — mirror one React Flow `select` change into the store.
   *
   * THIS is the seam, and it is not interchangeable with `onSelectionChange`.
   * The canvas drives React Flow from `nodes`/`edges` props, i.e. CONTROLLED
   * mode, in which `triggerNodeChanges`/`triggerEdgeChanges` do not touch RF's
   * own store — they hand the change to these callbacks and nothing else. RF's
   * `edgeLookup`, which is what `onSelectionChange` reports from, is rebuilt
   * verbatim from the `edges` prop, so for edges that callback can only ever
   * report back the selection this component already told it about. Every real
   * selection — click, TAB+Enter, Escape, pane-click — arrives here or nowhere.
   *
   * `store.getState()` is re-read per change rather than hoisted: a batch can
   * carry a select and the matching deselects together, and `nextSelection`'s
   * guard has to see the selection the earlier change in the SAME batch just
   * made.
   */
  function applySelectChange(target: Selection, selected: boolean) {
    const st = store.getState();
    st.select(nextSelection(st.selected, target, selected));
  }

  function onNodesChange(changes: NodeChange[]) {
    /* Container changes are dropped before anything sees them (U6c). Container
       nodes are DERIVED, so they are in the `nodes` prop but not in the view
       state array and not in the domain store at all — RF still reports their
       measured dimensions, and a `remove` if one were ever deleted. Letting those
       through would ask `useNodesState` to track a node it does not own and,
       worse, hand `deleteNode('<container id>')` to the store, which would find
       no node and silently do nothing today but is a live footgun for U6d.
       Filtered at the SEAM rather than in each branch below, so a change type
       added later cannot miss the guard. */
    const own = changes.filter((c) => !('id' in c) || !containerIds.has(c.id));
    // Apply every change to the view first (this is where React Flow records
    // measured dimensions, the in-progress drag position, and its own node
    // selection).
    onNodesChangeRaw(own);
    const st = store.getState();
    for (const c of own) {
      // Commit a move to the domain store once the drag settles (or for a
      // programmatic move) — not on every mid-drag tick, so the domain graph
      // doesn't churn while dragging.
      if (c.type === 'position' && c.position && c.dragging !== true) {
        st.moveNode(c.id, c.position);
      } else if (c.type === 'remove') {
        st.deleteNode(c.id);
      } else if (c.type === 'select') {
        applySelectChange({ kind: 'node', id: c.id }, c.selected);
      }
    }
  }

  function onEdgesChange(changes: EdgeChange[]) {
    const st = store.getState();
    for (const c of changes) {
      if (c.type === 'remove') st.deleteEdge(c.id);
      else if (c.type === 'select') applySelectChange({ kind: 'edge', id: c.id }, c.selected);
    }
  }

  /**
   * U6b — the connect-time rules, hoisted per GRAPH.
   *
   * `isValidConnection` runs on every pointer-move while a connection is being
   * dragged, so the endpoint and edge-key sets are built once here rather than
   * per move. The cycle sweep inside `connectRejection` stays linear and only
   * runs for a candidate the cheap rules already passed.
   */
  const connectPre = useMemo(
    () => precomputeConnect({ nodes, edges, containers: loaded?.containers ?? [] }),
    [nodes, edges, loaded],
  );

  /** The candidate a DRAWN connection proposes — one definition, two callers. */
  const drawnCandidate = useCallback(
    (from: string, to: string) => ({ from, to, condition: DRAWN_EDGE_CONDITION }),
    [],
  );

  /**
   * The refusal to render: the CURRENT reason the last attempted connection
   * cannot be made, or `null` if there is none any more.
   *
   * A vanished endpoint drops the message rather than re-explaining it as
   * `unknown-endpoint` — that reason exists for a caller that is not the canvas,
   * and its text is the only one that has no activity to name, so it would print
   * the raw id the rest of this feature works to keep off screen.
   */
  const refusal: ConnectRejection | null = useMemo(() => {
    if (attempted === null) return null;
    if (!connectPre.endpoints.has(attempted.from) || !connectPre.endpoints.has(attempted.to)) {
      return null;
    }
    return connectRejection(connectPre, drawnCandidate(attempted.from, attempted.to));
  }, [attempted, connectPre, drawnCandidate]);

  /**
   * Whether React Flow should allow this connection at all.
   *
   * Returning false makes RF refuse the DROP (`onConnect` never fires) and mark
   * the hovered handle invalid mid-gesture, which is the whole point: the store
   * has always refused these, but silently and only after the fact.
   */
  const isValidConnection = useCallback(
    (c: Connection | FlowEdge) =>
      connectRejection(connectPre, drawnCandidate(c.source, c.target)) === null,
    [connectPre, drawnCandidate],
  );

  function onConnect(conn: Connection) {
    setAttempted(null);
    // A freshly-drawn edge carries `DRAWN_EDGE_CONDITION` — the SAME condition
    // `isValidConnection` judged, so what was allowed is what gets authored. The
    // operator re-picks the condition by selecting the edge in the property panel.
    if (conn.source && conn.target)
      store.getState().connect(conn.source, conn.target, DRAWN_EDGE_CONDITION);
  }

  /**
   * SAY WHY a connection was refused.
   *
   * `isValidConnection` can only answer yes/no, so on its own it turns a refused
   * drag into a gesture that quietly does nothing — the same defect class U6a
   * fixed in the condition picker (a control that refuses invisibly). RF calls
   * `onConnectEnd` on every pointer-up, valid or not, with the handle it landed
   * on, so this is where the reason can be recovered and shown.
   *
   * `isValid === false` means "over a handle, and refused" — `null` is "not over
   * a handle at all" (a drop on empty canvas, which is a cancel, not a refusal).
   * A rejection this predicate cannot name is left silent on purpose: RF also
   * refuses structurally impossible drops (source→source), where the reason is
   * the gesture rather than a rule about the graph.
   *
   * The ends MUST be oriented before they are judged. RF hands this callback the
   * RAW gesture — where the pointer went down, and what it was over on release —
   * not the source→target connection it normalised internally to decide validity.
   * See `orientDrawnEnds` for what reading them raw does to the message, which is
   * worse than a wrong string: for a backwards cycle-closer it produces no
   * message at all.
   */
  function onConnectEnd(_event: MouseEvent | TouchEvent, state: FinalConnectionState) {
    if (state.isValid !== false) return;
    const origin = state.fromNode?.id;
    const release = state.toNode?.id;
    if (origin === undefined || release === undefined) return;
    setAttempted(orientDrawnEnds(origin, release, state.fromHandle?.type));
  }

  /**
   * Accept a toolbox drag over the canvas surface.
   *
   * `preventDefault()` is what makes an element a drop target, so it is called
   * ONLY for our own drags: without the gate the canvas would swallow every file
   * / link / text drag the operator happens to release over it, silently doing
   * nothing instead of letting the browser do its default thing.
   *
   * The gate reads `dataTransfer.types`, never the payload — during `dragover`
   * the drag-data store is in protected mode and `getData()` returns `''`. See
   * `activityDnd.ts`.
   */
  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasActivityDragType(event.dataTransfer) || !isOverCanvasSurface(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    /* The SAME predicate as `onDragOver`, and it must stay the same one.
       `dragover` can only see the drag's SHAPE, so it accepts on the MIME type
       alone; if `drop` then bailed on an unreadable PAYLOAD without cancelling,
       the canvas would have promised a copy-drop with the cursor and then handed
       the event back to the browser to perform its DEFAULT action.
       `DataTransfer.types` is a LIST, so a drag carrying our type alongside
       `text/uri-list` would navigate the page to the dropped URL — discarding an
       unsaved graph with no confirmation. Claim every drop we invited, THEN
       decide whether it authors anything. */
    if (!hasActivityDragType(event.dataTransfer) || !isOverCanvasSurface(event)) return;
    event.preventDefault();
    // Ours, but not something we can author (an uncatalogued or structural-call
    // type from another tab or an older build): a no-op, not a default action.
    const type = readActivityDragType(event.dataTransfer);
    if (type === null) return;
    /* The node's TOP-LEFT lands under the pointer. Deliberately not offset to
       centre it: the drag image is a toolbox BUTTON, whose size bears no
       relation to the node's, so subtracting the grab offset inside it would be
       false precision. `screenToFlowPosition` accounts for the live zoom + pan,
       so the placement is correct under any viewport transform. */
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    store.getState().addNode(type, position);
  }

  return (
    <>
      <EdgeMarkers />
      <ReactFlow
        nodes={renderedNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => setAttempted(null)}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onlyRenderVisibleElements
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <MiniMap pannable zoomable />
        <Controls />
        {refusal !== null && (
          /* Canvas-LOCAL, via RF's own `Panel`, per the epic's z-index/portal
             policy (only global menus portal to body).

             `role="alert"` rather than a second `role="status"`: `PipelineCanvas`
             already runs a polite live region for the persistent validation
             badges, and two polite regions updating together double-announce.
             This one is the direct answer to a gesture the operator just made,
             which is what assertive is for. It is plain markup rather than a
             Fluent `MessageBar` to keep the lazy canvas chunk light — the shell's
             own badge list is the same idiom. */
          <Panel position="bottom-center" className="canvas-refusal">
            <span role="alert">{refusal.message}</span>
            <button type="button" onClick={() => setAttempted(null)} aria-label="Dismiss">
              ✕
            </button>
          </Panel>
        )}
      </ReactFlow>
    </>
  );
}
