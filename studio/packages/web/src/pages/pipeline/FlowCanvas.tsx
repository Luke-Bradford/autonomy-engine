import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
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
  useStore as useReactFlowStore,
  useStoreApi as useReactFlowStoreApi,
  type Connection,
  type Edge as FlowEdge,
  type EdgeChange,
  type FinalConnectionState,
  type Node as FlowNode,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  implicitRouting,
  type ContainerKind,
  type Position as DomainPosition,
} from '@autonomy-studio/shared';
import type { StoreApi } from 'zustand';
import { activityLabel, activityLabels } from './activityLabel';
import { containerLabels, routingChangeBetween, routingSentence } from './containerRules';
import { hasActivityDragType, readActivityDragType } from './activityDnd';
import { toFlowEdge } from './edgeCondition';
import { EdgeMarkers } from './EdgeMarkers';
import { connectRejection, precomputeConnect, type ConnectRejection } from './connectRules';
import {
  appearedIds,
  containerAriaLabel,
  containerHandles,
  containerRects,
  emptyContainerIds,
  liveNodeRects,
  revealTransform,
  usableExtent,
  UNMEASURED_NODE_SIZE,
  type ContainerBox,
} from './containerLayout';
import { DRAWN_EDGE_CONDITION, orientDrawnEnds, SOURCE_PORT_ID, TARGET_PORT_ID } from './ports';
import {
  cascadeDeleteContainer,
  nextSelection,
  type CanvasState,
  type Selection,
} from './canvasStore';

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
  /** This container's within-kind name (`loop 2`) — `containerLabels`' ordinal. */
  label: string;
  /** Whether this container is the property panel's current subject (U23). */
  selected: boolean;
  /** Confirm, then remove this container — see `confirmDeleteContainer` (#748). */
  onDelete: (id: string, kind: ContainerKind) => void;
  /** Make this container the property panel's subject — U23's config form. */
  onConfigure: (id: string) => void;
}

/**
 * U6c — a container, drawn as the box its children sit in.
 *
 * The header states the container in WORDS ('loop 2' / 'stage 1'), not by colour
 * or shape alone — the epic's non-color-status-labels criterion — and it is the
 * same text `connectRules` names the container by when it refuses a boundary
 * crossing, so a refusal points at something on screen.
 *
 * #883 put the within-kind ORDINAL in that header. It used to be the bare kind,
 * on the reasoning that the kind is what the box IS; but `containerLabels` had
 * already made "loop 2" the name every surface that OFFERS a container uses, so
 * the box was the one place the name could not be matched to a rectangle. #878
 * settled the question by drawing the activity ordinal on its box: leaving the
 * container's off made a single sentence identify one end and not the other
 * ("'HTTP Request 2' is inside the loop container").
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
const ContainerNode = memo(function ContainerNode({ id, data }: NodeProps) {
  const d = data as ContainerData;
  return (
    <div className={`flow-container${d.selected ? ' flow-container--selected' : ''}`}>
      <Handle type="target" id={TARGET_PORT_ID} position={Position.Left} />
      <span className="flow-container-label">{d.label}</span>
      {/* #748 — the box's own chrome is inert, and this is the one part of it
          that is not. (The edge HANDLES above are hit-testable too, and predate
          this: two opt-ins, not one.) A container cannot be made `selectable` —
          RF would write `pointer-events: all` on a wrapper spanning a whole
          region of the canvas, which then eats the pane clicks aimed between its
          children — so the delete affordance lives here instead of behind a
          selection and a property panel. `pointer-events` is re-enabled for this
          control in the stylesheet, the same opt-back-in the handles use.
          The id comes from React Flow's own node prop, so nothing about WHICH
          container this is has to be carried in `data`.

          `nodrag nopan` completes that parity — RF's own `Handle` sets both, and
          without them this button is hit-testable but NOT exempt from the pane's
          gesture filter, which bails only on `.nopan` ancestry. An activity node
          escapes that by being `draggable`, so d3-drag stops the mousedown; a
          container is `draggable: false`, so nothing would intercept and pressing
          the × then twitching the mouse would pan the whole canvas. */}
      <button
        type="button"
        className="flow-container-delete nodrag nopan"
        aria-label={`Delete ${d.label} container`}
        title={`Delete ${d.label} container`}
        onClick={() => d.onDelete(id, d.kind)}
      >
        ✕
      </button>
      {/* U23 — the SECOND opt-in to hit-testing on this box, and it exists for
          exactly the reason the ✕ above does: a container cannot be selected, so
          a config panel cannot be reached the way every other element's is. This
          button IS the selection gesture. Same `nodrag nopan` + stylesheet
          `pointer-events` opt-in, same id-from-RF's-own-prop.

          Its accessible name carries the WITHIN-KIND ORDINAL (`loop 2`), not the
          bare kind: two loops on screen would otherwise give two buttons with
          one name, which is ambiguous to a screen reader and unaddressable to a
          spec. Since #883 the ✕ beside it and the BOX's own label read the same
          `label`, so this is no longer the one place on the box the ordinal
          reaches — it is simply how a container is named. */}
      <button
        type="button"
        className="flow-container-configure nodrag nopan"
        aria-label={`Configure ${d.label}`}
        title={`Configure ${d.label}`}
        aria-pressed={d.selected}
        onClick={() => d.onConfigure(id)}
      >
        ⚙
      </button>
      <Handle type="source" id={SOURCE_PORT_ID} position={Position.Right} />
    </div>
  );
});

// Module-level constant: React Flow requires a stable `nodeTypes` identity (a
// new object each render re-mounts every node and warns).
const nodeTypes = { activity: ActivityNode, container: ContainerNode };

/**
 * How many activity ids the #788 implicit-chain advisory spells out before it
 * summarises the rest. An advisory that grows without bound stops being an
 * advisory and becomes an occlusion: a panel naming forty nodes across the top
 * of the canvas is worse than the silence it replaces. Six is enough to make the
 * ORDER concrete (the surprising part is that there is one at all), and the
 * count in the same sentence keeps the total honest when the list is cut.
 */
const IMPLICIT_CHAIN_PREVIEW = 6;

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
  // #746 — the containers, straight off the store. This used to select `loaded`
  // WHOLE and reach into it, because `s.loaded?.containers ?? []` allocates a
  // fresh array on every store read and zustand compares selector results with
  // `Object.is` — a new reference every time is a re-render loop, not a memo.
  // `containers` is now a stable field the store copy-on-writes, so it can be
  // selected directly, and this component no longer re-renders on a `rebaseLoaded`
  // that changes nothing it draws.
  const containers = useStore(store, (s) => s.containers);

  /**
   * #788 — the implicit success chain, said out loud.
   *
   * An edge-less doc does not run as unrouted parallel roots: `effectiveEdges`
   * synthesizes a success chain over node ARRAY order, so deleting the last edge
   * and saving replaces the authored topology with a line. That inference is
   * staying (the operator's call on #788 — it is in the shipped MVP and docs
   * authored without edges rely on it), which leaves discoverability as the thing
   * to fix: the convention was readable only as the absence of something.
   *
   * `implicitRouting` owns what may be claimed, containers included: the
   * synthesized chain crosses container boundaries and the WALK then discards
   * those edges, so a doc with containers comes back as `partitioned` and this
   * panel names no order for it. Getting that wrong would have had the canvas
   * confidently state the opposite of what runs — worse than the silence the
   * ticket set out to end — so the order is never re-derived here.
   */
  const routing = useMemo(
    () => implicitRouting({ nodes, edges, containers }),
    [nodes, edges, containers],
  );

  /**
   * The operator-facing name of every activity and every container on this
   * canvas, minted once (#878). The box label, the advisory and the property
   * panel all read these two maps, so no surface can name a node differently
   * from the rectangle it points at.
   */
  const nodeLabels = useMemo(() => activityLabels(nodes), [nodes]);
  const containerLabelsById = useMemo(() => containerLabels(containers), [containers]);

  /**
   * How the #788 advisory names one thing it points at — an activity by its
   * `activityLabels` ordinal, a container by its `containerLabels` one.
   *
   * #878: both arms used to spell out RAW IDS for activities, which
   * `newLocalId` mints as `n_7c44a16f-…` for anything drawn on the canvas — so
   * the panel named a rectangle by a string that appears nowhere on the canvas.
   * An id is unique but unreadable; the label is both, and it is the text the box
   * itself now carries, which is what makes the sentence actionable.
   *
   * An id that resolves to neither (a stale view) still degrades to the raw id
   * rather than inventing a name.
   */
  const advisoryName = useCallback(
    (id: string) => nodeLabels.get(id) ?? containerLabelsById.get(id) ?? id,
    [nodeLabels, containerLabelsById],
  );

  /** #840 — the parallel roots, named, for the `partitioned` arm of the advisory. */
  const parallelRoots = useMemo(() => {
    if (routing?.kind !== 'partitioned') return [];
    return routing.partition.roots.map(advisoryName);
  }, [routing, advisoryName]);

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
  // `setViewport` is the reveal below; it is the only imperative viewport write
  // on this canvas.
  const { screenToFlowPosition, setViewport } = useReactFlow();
  /* React Flow's OWN store, read imperatively via `getState()` and never
     subscribed to. The reveal needs the live transform and the pane size, and a
     `useStore((s) => s.transform)` selector would re-render this component on
     every frame of every pan and zoom — on a canvas that runs
     `onlyRenderVisibleElements` precisely because render cost matters. Aliased
     because the bare `useStore` in this file is ZUSTAND's, over the app store. */
  const reactFlowStore = useReactFlowStoreApi();
  /* The pane SIZE, subscribed — unlike the transform, which is read imperatively.
     These change when the pane is resized (a splitter drag, a window resize, a
     panel collapsing to zero and back), never per pan or zoom frame, so the
     re-render cost is the same as any other layout change. Subscribed rather
     than read because the reveal effect must RE-RUN when a pane that was 0x0
     comes back: nothing else in its dependencies changes on a pure resize, so
     without these a container emptied while the pane was collapsed would have
     its reveal dropped unless some unrelated node or container change happened
     to follow. Two scalar selectors, not one object — an object selector would
     return a fresh identity every render and never settle. */
  const paneWidth = useReactFlowStore((s) => s.width);
  const paneHeight = useReactFlowStore((s) => s.height);

  /**
   * U17 — the DOMAIN position each node held at the last reconcile.
   *
   * The escape hatch the carry-forward below owed to U17/U9/U22: it is how this
   * effect tells "the view is ahead of the domain" (a drag — keep the view) from
   * "the domain moved on its own" (an undo, an auto-layout, a version restore —
   * the view is stale and must follow).
   *
   * A remembered position rather than a store epoch/generation counter, because
   * it cannot mis-fire: it is derived from the very positions being reconciled,
   * so it needs no dependency wiring to stay in step, and it covers every
   * programmatic writer at once instead of each one remembering to signal.
   *
   * It cannot fire mid-drag either — `onNodesChange` commits `moveNode` only
   * once a drag settles (`c.dragging !== true`), so the domain position is
   * unchanged for the whole gesture, and at drag-end the domain position IS the
   * view position, making the hatch a no-op exactly when the carry-forward
   * matters.
   */
  const lastDomainPositions = useRef(new Map<string, DomainPosition>());

  // Reconcile store → view: rebuild the view array from the domain nodes,
  // carrying forward each surviving node's live position and measured size so
  // React Flow never re-initialises (and never flickers) an existing node.
  useEffect(() => {
    // Both computed OUTSIDE the updater below, which must stay pure: StrictMode
    // double-invokes it in development, and a ref written from inside would then
    // record a reconcile that had not happened. (The second invocation is a
    // no-op either way — by then the view array already carries the domain
    // positions, so re-deciding "domain wins" changes nothing.)
    const seen = lastDomainPositions.current;
    const domainMoved = new Set(
      nodes
        .filter((n) => {
          const was = seen.get(n.id);
          return was === undefined || was.x !== n.position.x || was.y !== n.position.y;
        })
        .map((n) => n.id),
    );
    lastDomainPositions.current = new Map(nodes.map((n) => [n.id, n.position]));

    setFlowNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return nodes.map((n) => {
        const existing = byId.get(n.id);
        return {
          ...existing,
          id: n.id,
          type: 'activity',
          // Keep React Flow's live position during/after a drag; fall back to
          // the domain position for a freshly-added node — or take it when the
          // DOMAIN is what moved (U17, above).
          position: domainMoved.has(n.id) ? n.position : (existing?.position ?? n.position),
          data: {
            // #878 — the box carries the IDENTIFYING name ("HTTP Request 2"),
            // not the kind. Every message that points at one activity now names
            // it this way, and a name the canvas cannot show is a name the
            // operator cannot act on. The fallback is unreachable: `nodeLabels`
            // is built from this very array.
            title: nodeLabels.get(n.id) ?? activityLabel(n),
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
  }, [nodes, nodeLabels, selected, setFlowNodes]);

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
   * `containers` are the store's working membership — created and re-parented
   * from the property panel (U6d), pruned by a delete (#746) — so what is drawn
   * tracks the graph on screen rather than the version it was opened on.
   */
  /**
   * #748 — confirm, then remove the container.
   *
   * Confirmed where every other destructive act in this app is (a `window.confirm`
   * — `PipelinesPage`, `ConnectionsPage`, `TriggersPage`), and unlike "Delete
   * node"/"Delete edge" it is confirmed AT ALL, because the two are not the same
   * risk: a container owns `exitWhen`/`items`/`maxRounds`/`timeout` that no
   * surface can re-author yet (U23, #839) and there is no undo, so a mis-click is
   * unrecoverable rather than merely annoying.
   *
   * The message states BOTH halves — what goes and what stays. "Are you sure?"
   * would leave the operator guessing whether their activities are about to go
   * with the box, which is the one thing this action deliberately does not do.
   *
   * A `foreach` gets a THIRD sentence, because for that kind "the activities are
   * kept" is true but misleading. `${item}` is scoped BY MEMBERSHIP — only nodes
   * inside a `foreach` get `item` in scope (`params.ts` builds `foreachChildIds`
   * from exactly those containers) — so un-grouping a child that references it
   * turns every such reference into a validation error and the doc stops saving.
   * That is the same shape of trap this ticket exists to end, so it must not be
   * sprung silently. It IS recoverable, unlike the container's own config: the
   * freed children are still selectable and their config is editable in
   * `NodePanel`, so the operator can edit the references out. Saying so is what
   * makes the difference between a recoverable state and a mystery.
   *
   * Stated for EVERY `foreach` rather than only when a child really references
   * `${item}`. A detector would have to find expressions anywhere in a child's
   * config, and the ways to miss one (`${ item }`, `${item.field}`, an expression
   * nested in a field this code does not know about) all fail in the direction of
   * a silent trap. Over-warning on a `foreach` with no references is the harmless
   * direction, and is nearly hypothetical anyway — iterating without using the
   * item is what a `foreach` is for.
   */
  /**
   * U23 — make a container the property panel's subject.
   *
   * A plain `select`, not a toggle. The ⚙ is the only way IN, but a pane click
   * and the ✕ are both ways out, so a second press re-selecting what is already
   * selected is a harmless no-op rather than a hidden second gesture.
   */
  const selectContainer = useCallback(
    (id: string) => {
      store.getState().select({ kind: 'container', id });
    },
    [store],
  );

  /**
   * #840 — the delete's ROUTING consequence, appended to its destruction warning.
   *
   * Two things this edit can do to routing, neither of which any validator
   * reports: removing the last container turns the inferred partition back into
   * one sequence, and the edge CASCADE can remove the doc's last authored edge,
   * which starts inferring routing for a doc that previously authored its own.
   * Both mint into the next immutable version.
   *
   * Appended rather than folded into `confirmContainerEdit`: that gate diffs the
   * VALIDATOR's issues, which is not what a delete costs, and `containerRules`
   * argues that merging the two makes each vaguer. So the routing half is reused
   * and the destruction sentence stays this function's own.
   */
  const confirmDeleteContainer = useCallback(
    (id: string, kind: ContainerKind) => {
      const state = store.getState();
      const routing = routingSentence(
        routingChangeBetween(state, { ...state, ...cascadeDeleteContainer(state, id) }),
      );
      // #883 — the container is named the way its box now is. Naming the button
      // "Delete loop 2 container" and then asking "Delete this loop container?"
      // would relocate the one-end-identified split rather than close it, and
      // with two loops on screen the dialog would not say which one is going.
      //
      // Recomputed from `state` rather than read off the `containerLabelsById`
      // memo above, and that is the correctness point: this callback is memoised
      // on `[store]` alone, so closing over the memo would name the container
      // from the render that created the callback, not from the doc as it stands
      // when the ✕ is pressed. `state` is `store.getState()`, taken on the click.
      const name = containerLabels(state.containers).get(id) ?? kind;
      const confirmed = window.confirm(
        `Delete this ${name} container?\n\n` +
          // U17 — this used to end "and this cannot be undone", which was true
          // when it was written and is not any more. The destruction is
          // unchanged and still worth confirming (the container's config and
          // its incident edges both go); what changed is that the operator now
          // has a way back, and a dialog that hides it would make them decline
          // a reversible action.
          'Its settings and the edges connected to it are removed — Undo (⌘Z) brings them back. ' +
          'The activities inside are kept — they move out to the top level.' +
          (kind === 'foreach'
            ? ' Any ${item} they reference will no longer resolve, and must be edited' +
              ' before the pipeline can be saved.'
            : '') +
          (routing === null ? '' : `\n\n${routing}`),
      );
      if (!confirmed) return;
      store.getState().deleteContainer(id);
    },
    [store],
  );

  /* The BOXES are their own memo, separate from the nodes rendered from them.
     The reveal effect below needs `childCount`, which the rendered node keeps
     only as an aria label, and splitting keeps this identity a function of
     GEOMETRY alone — folded into the node memo it would also change whenever
     `confirmDeleteContainer` did, re-running the reveal for a reason that has
     nothing to do with where anything is. */
  const containerBoxes = useMemo<Map<string, ContainerBox>>(() => {
    if (containers.length === 0) return new Map();
    /* `liveNodeRects` drops a view node the DOC no longer has. The store is
       mutated one render before the reconcile effect rebuilds `flowNodes`, so
       without it every box is derived once from bounds that still include a
       just-deleted node — see that function for why the empty fallback, and
       hence the reveal below, is what that breaks. */
    const rects = containerRects(
      containers,
      liveNodeRects(
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
        new Set(nodes.map((n) => n.id)),
      ),
    );
    return rects;
  }, [containers, nodes, flowNodes]);

  const containerNodes: FlowNode[] = useMemo(() => {
    // The SAME within-kind ordinals the membership `<select>` offers and
    // `readableIssue` quotes, so "loop 2" names one container everywhere it
    // appears rather than three things that happen to agree.
    const labels = containerLabelsById;
    return containers.map((c) => {
      const rect = containerBoxes.get(c.id)!;
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
        /* A DERIVED node must state its own geometry — React Flow can never
           measure one, and a container that stays "uninitialized" loses every
           edge that touches it, which is the whole defect U6c exists to fix.
           Why it cannot be measured: `adoptUserNodes` reuses a node's internals
           only while the SAME object identity comes back through the `nodes`
           prop. This object is rebuilt on every render (it is a `useMemo` over
           the activity rects), so RF re-adopts it every time, and `parseHandles`
           then reads `!userNode.measured ? undefined : <previous bounds>` —
           discarding whatever its ResizeObserver had just measured. The measured
           size cannot come back the normal way either: a container's dimension
           change is filtered out at `onNodesChange` (below) precisely because it
           is not the store's to hold. The result is a node RF resets to
           unmeasured forever, and `getEdgePosition` returns `null` for an
           endpoint with no handle bounds — silently, since RF's error channel is
           a no-op in a production build. So both facts are STATED rather than
           observed — two different things about a node whose geometry is derived,
           not two attempts at one fix:
             - `measured`, the size. Also what `adoptUserNodes` reads to decide
               whether the graph counts as initialised at all.
             - `handles`, the port bounds, taken verbatim by `parseHandles`, so
               initialisation does not depend on a DOM measurement landing.
           Mutation-tested (`e2e/container-rendering.spec.ts`): either one alone
           is enough to keep the edges — removing BOTH is what reproduces the
           original defect. They are kept together because each answers a
           question the other does not, and both are exactly as trustworthy as
           `rect`, which is this node's only source of truth anyway. */
        measured: { width: rect.width, height: rect.height },
        handles: containerHandles(rect.width, rect.height),
        data: {
          kind: c.kind,
          label: labels.get(c.id) ?? c.kind,
          // Re-derived from the store, never carried forward — the same rule
          // and the same reason as the activity nodes' `selected` above.
          selected: selected?.kind === 'container' && selected.id === c.id,
          onDelete: confirmDeleteContainer,
          onConfigure: selectContainer,
        } satisfies ContainerData,
        /* On the node, so RF puts them on the element it owns — the wrapper this
           component renders inside. `ariaRole` is needed explicitly because a
           non-focusable node otherwise gets no role at all. */
        ariaRole: 'group',
        // #883 — the ordinal, so two same-kinded boxes are two distinguishable
        // groups to a screen reader, matching the text the box now draws.
        ariaLabel: containerAriaLabel(labels.get(c.id) ?? c.kind, rect.childCount),
        /* Still NOT selectable, and that is now a decision rather than a default
           (#748). The box carries one edit — its delete button — and the obvious
           way to have offered that was to make the container selectable and give
           it a property panel like every other element. It cannot be: RF writes
           `pointer-events: all` on the wrapper of a selectable node, and this
           wrapper spans a REGION of the canvas containing other interactive
           things, so the box would start eating every pane click aimed at the
           space between its children — the exact bug
           `e2e/container-rendering.spec.ts` mutation-proves against this line.
           The button opts back into hit-testing on its own instead.

           Creating a container and moving a node in or out is the property
           panel's, as of U6d — a `<select>` on the NODE, precisely because the box
           cannot be RF-selected. U23 gave the box its own CONFIG panel without
           relaxing this line: the ⚙ writes the store's `Selection` directly, so
           a container is selectable in the STORE's sense and not in RF's, which
           is the whole point. DRAGGING one in, and the RF `parentId` mapping that
           would make a container draggable as a group, is still U23's part 2. */
        selectable: false,
        draggable: false,
        /* `deletable: false` is a THIRD redundant guard, honestly labelled as one
           rather than dressed up as load-bearing: RF's Backspace path only
           targets a node RF considers selected, and a container is never in RF's
           selection (the store's own container selection is a different fact and
           RF cannot see it), container
           ids are filtered at the change seam before any branch runs, and a
           `remove` that somehow reached `deleteNode(<container id>)` would find
           no node and no-op. Nothing can reach `deleteContainer` except the
           confirmed button. Kept because all three of those are properties of
           OTHER lines that a later change could flip. */
        deletable: false,
        focusable: false,
        // Behind its children. Both the explicit z-index and the array order
        // below are set: RF sorts by `zIndex` and falls back to array order.
        zIndex: 0,
      } satisfies FlowNode;
    });
  }, [
    containers,
    containerBoxes,
    containerLabelsById,
    selected,
    confirmDeleteContainer,
    selectContainer,
  ]);

  /**
   * #785 — a container that has just become EMPTY is panned into view.
   *
   * `containerRects` puts a box it cannot size from its children OUTSIDE the
   * content bounds (deliberately — see its comment), and a fitted viewport ends
   * flush WITH those bounds, so such a box lands reliably just off-screen and
   * `onlyRenderVisibleElements` culls it out of the DOM altogether. Since #748
   * the box carries the container's ONLY delete control. An emptied `loop` or
   * `foreach` also disables Save ("makes no progress"), so the operator was left
   * with a dead Save whose fix was on an element they could not see — and an
   * emptied `stage` is WORSE, not better: it validates clean and saves silently,
   * so there is not even a badge pointing at the container that vanished.
   *
   * Driven off a SET DIFF, not off the delete action, because emptying is not one
   * event: `deleteNode` empties a container by removing its last child, and
   * `loadVersion` can arrive already-empty. `deleteContainer` — the one action
   * that sounds like the trigger — REMOVES the box and is never the emptying.
   * The diff also keeps `setViewport` out of the store, which is deliberately
   * React-Flow-free.
   *
   * The first run only RECORDS. A container that is empty from load is framed by
   * the `fitView` prop, which fits the bounding box of every rendered node and so
   * already includes it; revealing on mount would pan the canvas on every page
   * load for no reason. This effect owns the TRANSITION into emptiness only.
   *
   * Re-running is cheap and idempotent: the set is invariant under pan and
   * measurement (membership does not depend on either), so the identity churn in
   * `containerBoxes` as React Flow measures produces no `appeared` and no write.
   */
  const knownEmptyContainers = useRef<Set<string> | null>(null);
  useEffect(() => {
    const empty = emptyContainerIds(containerBoxes);
    /* Read the pane BEFORE banking the set: React Flow reports 0x0 until it has
       measured, and a run that cannot tell what is visible must not consume a
       transition it could not act on.

       Which of two things that leaves depends on WHEN the pane was unmeasured,
       and both are correct:
        - the pane had been measured and went to 0 (a collapsed or hidden panel).
          The ref is already a set, so the transition is still an `appeared` on
          the run after the pane comes back, and it is revealed then. This is the
          retry case, and it is why the pane size is a DEPENDENCY of this effect:
          a pane returning is otherwise invisible to it.
        - the pane has NEVER been measured. The ref is still null, so the first
          measured run records and reports nothing — it looks like the mount case
          because it IS the mount case: the `fitView` prop has not fired yet
          either (it waits for initialised nodes AND dimensions), and it fits
          every rendered node including the empty box. Handing that framing to
          `fitView` rather than panning to it is the same division of labour as on
          any other load, so nothing is lost by not retrying here. */
    const { transform } = reactFlowStore.getState();
    if (paneWidth <= 0 || paneHeight <= 0) return;

    const known = knownEmptyContainers.current;
    knownEmptyContainers.current = empty;
    const appeared = appearedIds(known, empty);
    if (appeared.length === 0) return;

    const boxes = appeared
      .map((id) => containerBoxes.get(id))
      .filter((box): box is ContainerBox => box !== undefined);
    /* `usableExtent`, not the raw pane: the MiniMap and Controls are drawn INSIDE
       it with `pointer-events: all`, and a box landed flush against the
       bottom-right edge can have its delete control underneath them — revealed
       and still unclickable, which is the trap unfixed.
       `null` = already visible. Not writing at all is the point: a box the
       operator can already see must not have their viewport moved under them. */
    const usable = usableExtent(paneWidth, paneHeight);
    const next = revealTransform(boxes, transform, usable.width, usable.height);
    if (next !== null) void setViewport(next);
  }, [containerBoxes, paneWidth, paneHeight, reactFlowStore, setViewport]);

  /** Containers FIRST, so they paint behind the activities they enclose. */
  const renderedNodes = useMemo(
    () => [...containerNodes, ...flowNodes],
    [containerNodes, flowNodes],
  );

  /**
   * Ids RF may report changes for that the domain store must never see.
   *
   * Container ids MINUS the activity ids, because the two share ONE namespace.
   * A collision is refused by `validateDoc`, but that gate is advisory and
   * write-path only, so a version written before it can still load. In that doc
   * `renderedNodes` carries the id twice, and RF's Map-keyed `nodeLookup` keeps
   * the LAST one — the activity. Filtering the id would then drop every change
   * for a node that IS in the store: no drag, no select, no delete, i.e. no way
   * to edit the doc back out of the collision. Subtracting means the activity
   * behaves normally and only the (invisible) container loses its changes, which
   * it has none of.
   */
  const containerIds = useMemo(() => {
    const activityIds = new Set(flowNodes.map((n) => n.id));
    return new Set(containerNodes.map((n) => n.id).filter((id) => !activityIds.has(id)));
  }, [containerNodes, flowNodes]);

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
    ...toFlowEdge(e),
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
       no node and silently does nothing: U6d authors membership through the
       property panel, not through this change seam, so the collision stays
       latent — but it is a live footgun for U23's drag-membership.
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
    () => precomputeConnect({ nodes, edges, containers }),
    [nodes, edges, containers],
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
   * U6e — whether the refusal on screen can be answered with a BACK-EDGE.
   *
   * The refusal message for a cycle-closer has always ended *"a loop is
   * expressed as a back-edge with a maxBounces cap"*, and there was no way to
   * make one: the engine has run back-edges since P2c and the save gate has
   * validated them just as long, but the canvas could only ever refuse the
   * gesture that means one. This turns that sentence into a control.
   *
   * OFFERED, not applied silently. Promoting the drag on drop would change what
   * an existing gesture means — a mis-drag of `b → a` for `a → b` would become a
   * loop instead of a clear refusal — and, more decisively, TWO different
   * refusals can be answered this way (a forward cycle, and a child crossing out
   * to its enclosing container), so a silent promotion would have to guess which
   * of two meanings the operator had.
   *
   * Gated on the whole BACK-EDGE rule set for the edge that would actually be
   * authored, not on the refusal's REASON: cycle-closure implies the ancestry
   * rule but not the PROGRESS rule (the reset body is computed over a node-only
   * adjacency, so a cycle running through a container endpoint leaves the source
   * out of its own body). An offer shown on reason alone would author a doc the
   * save gate refuses on topology.
   *
   * That gate is NOT a guarantee the resulting doc SAVES, and the distinction is
   * stated because the first version of this comment claimed otherwise.
   * `backEdgeDefect` answers about the EDGE; a back-edge also has a doc-wide
   * consequence it cannot see — the first `back: true` edge flips
   * `canReRunNodes`, which disables `settled`, so every `${nodes.x.status}` ref
   * in the doc newly fails `validateRefs`. Reproduced: `a → b → c` with `c`'s
   * config holding `${nodes.a.status}` accepts the offer and then badges invalid.
   *
   * The offer is still shown, and that is U6d's rule rather than a concession: a
   * consequence REVERSIBLE BY THE SAME CONTROL is warned about, not refused.
   * Deleting the edge fully repairs it, the validation badge names the exact
   * ref, and Save is already gated on the badge — so nothing is destroyed and
   * nothing is silent. Refusing instead would make a legitimate loop
   * unauthorable because of an expression in an unrelated node, which is the
   * "control that silently does nothing" defect this panel exists to fix. The
   * #748/U16 traps this feature guards against are the ones with NO way back;
   * this is not one of them.
   */
  const backOffer: { from: string; to: string } | null = useMemo(() => {
    if (attempted === null || refusal === null) return null;
    const candidate = { ...drawnCandidate(attempted.from, attempted.to), back: true };
    if (connectRejection(connectPre, candidate) !== null) return null;
    return { from: attempted.from, to: attempted.to };
  }, [attempted, refusal, connectPre, drawnCandidate]);

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
        /* U23 — the ONLY way a container selection can be cleared by clicking
           away. Every other kind clears through React Flow: it emits a
           `select:false` change for the element that was selected, which
           `applySelectChange` folds into the store. A container is never in RF's
           selection at all (the change seam filters container ids out, and the
           node is `selectable: false`), so RF has nothing to deselect and the
           config panel would otherwise stay open forever.

           Harmless for the other kinds rather than merely tolerable: clicking
           the pane already clears them, so setting `null` here is idempotent
           with the change RF is about to emit. */
        onPaneClick={() => store.getState().select(null)}
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
        {/* U6c — containers are in `nodeLookup` now, and the MiniMap draws EVERY
            node in it with one fill. Left alone, a `stage`/`loop` paints a large
            solid blob in the same colour as the activities it encloses, on top of
            them (containers come first, so they paint first). Classed instead, so
            the CSS can draw it as an outline the way it reads on the canvas. */}
        <MiniMap
          pannable
          zoomable
          nodeClassName={(n) => (n.type === 'container' ? 'minimap-node-container' : '')}
        />
        <Controls />
        {routing !== null && (
          /* #788 — see `routing` above. NOT a live region, and that is
             deliberate. The page already runs TWO polite regions — the toolbox's
             empty-results line (always mounted, `ActivityToolbox.tsx`) and the
             validation badges (mounted only while there are issues,
             `PipelineCanvas.tsx`) — plus the assertive refusal below. A third
             polite announcer, re-firing on every edge deletion, is how a canvas
             becomes hostile to a screen reader; this is a standing description of
             the graph, not an event. The honest cost, stated rather than hidden:
             a screen-reader user who deletes the last edge is not TOLD that the
             topology changed, only that the panel is there to be read. Giving
             that user the announcement without spamming everyone else needs the
             page's live-region policy sorted out, which is U-epic work, not this
             ticket's.

             Top, so it does not fight the refusal toast at bottom-center when
             both are up. It can overlap a container the #785 reveal just panned
             into view (both need an edge-less doc WITH containers) — visual only,
             `pointer-events: none` keeps it non-blocking. Filed as #794.

             Both copies end on what SAVING does, because that is the actual cost
             in the ticket: the inferred routing is what gets minted into the next
             immutable version, and a version cannot be edited afterwards. */
          <Panel position="top-center" className="canvas-advisory">
            {routing.kind === 'chain' ? (
              <>
                No edges authored — these {routing.order.length} activities run in one sequence, in
                the order they were added:{' '}
                <strong>
                  {routing.order.slice(0, IMPLICIT_CHAIN_PREVIEW).map(advisoryName).join(' → ')}
                </strong>
                {routing.order.length > IMPLICIT_CHAIN_PREVIEW
                  ? ` +${routing.order.length - IMPLICIT_CHAIN_PREVIEW} more`
                  : ''}
                . Saving mints that as this version&rsquo;s routing.
              </>
            ) : (
              /* The count is BRANCHED ON rather than interpolated, because one
                 root is a real and common shape — drop the first activity into a
                 stage and the stage is the only thing that starts — and "split
                 that chain into 1 that start in parallel" is both ungrammatical
                 and a claim of parallelism where there is none.

                 Neither arm claims to describe the WHOLE graph: it says what
                 STARTS, which is what the flat node list cannot show. Things that
                 run after a root still run; naming the roots does not deny
                 them. */
              <>
                No edges authored — routing is <strong>inferred</strong> from the order activities
                were added, and this graph&rsquo;s containers reshape that chain.{' '}
                {parallelRoots.length === 1 ? (
                  <>
                    It starts at <strong>{parallelRoots[0]}</strong>.
                  </>
                ) : (
                  <>
                    {parallelRoots.length} things start in parallel:{' '}
                    <strong>{parallelRoots.slice(0, IMPLICIT_CHAIN_PREVIEW).join(', ')}</strong>
                    {parallelRoots.length > IMPLICIT_CHAIN_PREVIEW
                      ? ` +${parallelRoots.length - IMPLICIT_CHAIN_PREVIEW} more`
                      : ''}
                    .
                  </>
                )}{' '}
                Saving mints the inferred routing as this version&rsquo;s routing.
              </>
            )}
          </Panel>
        )}
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
            {backOffer !== null && (
              <button
                type="button"
                className="canvas-refusal-action"
                onClick={() => {
                  store
                    .getState()
                    .connect(backOffer.from, backOffer.to, DRAWN_EDGE_CONDITION, { back: true });
                  // Clear the attempt, or the assertive live region keeps
                  // announcing a refusal for an edge that now EXISTS —
                  // `refusal` is recomputed from the forward candidate, which
                  // is still refused, and always will be.
                  setAttempted(null);
                }}
              >
                Make it a back-edge
              </button>
            )}
            <button type="button" onClick={() => setAttempted(null)} aria-label="Dismiss">
              ✕
            </button>
          </Panel>
        )}
      </ReactFlow>
    </>
  );
}
