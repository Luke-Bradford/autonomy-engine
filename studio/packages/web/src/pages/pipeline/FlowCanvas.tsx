import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
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
import { toFlowEdge, type EdgeCondition } from './edgeCondition';
import { EdgeMarkers } from './EdgeMarkers';
import { SourcePorts } from './SourcePorts';
import {
  backEdgeOffer,
  connectRejection,
  precomputeConnect,
  type ConnectPrecheck,
  type ConnectRejection,
} from './connectRules';
import {
  appearedIds,
  containerAriaLabel,
  containerHandles,
  containerRects,
  emptyContainerIds,
  liveNodeRects,
  revealTransform,
  usableExtent,
  unmeasuredNodeSize,
  type ContainerBox,
} from './containerLayout';
import {
  conditionFromConnection,
  CONNECTION_RADIUS,
  RECONNECT_RADIUS,
  DRAWN_EDGE_CONDITION,
  nodeBoxHeight,
  orientDrawnEnds,
  sourcePortsOf,
  TARGET_PORT_ID,
  usedConditionsBySource,
  type SourcePort,
} from './ports';
import {
  cascadeDeleteContainer,
  nextSelection,
  singleSelection,
  type CanvasState,
  type Selection,
} from './canvasStore';

interface ActivityData extends Record<string, unknown> {
  title: string;
  hasConnection: boolean;
  /** U19 — one outgoing port per outcome this source can route. */
  ports: readonly SourcePort[];
}

/**
 * The custom activity node. Memoised — React Flow re-renders the node layer on
 * every viewport change, so a memo keeps a stable node cheap.
 *
 * One target port in, and — since U19 — one source port per OUTCOME out. Which
 * outcome an edge routes is now the port it was drawn from rather than a
 * dropdown chosen afterwards; `ports.ts` owns the set and `SourcePorts` draws
 * it, for the author canvas and the run monitor alike.
 */
const ActivityNode = memo(function ActivityNode({ data, selected }: NodeProps) {
  const d = data as ActivityData;
  return (
    <div
      className={`flow-node${selected ? ' selected' : ''}`}
      style={{ minHeight: nodeBoxHeight(d.ports.length) }}
    >
      <Handle type="target" id={TARGET_PORT_ID} position={Position.Left} />
      <strong>{d.title}</strong>
      <span className="flow-node-sub">
        {d.hasConnection ? 'connection bound' : 'no connection'}
      </span>
      <SourcePorts ports={d.ports} />
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
  /** U19 — the box is a legal edge SOURCE, so it carries the same port column. */
  ports: readonly SourcePort[];
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
      <SourcePorts ports={d.ports} />
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
 * The modifiers that add an element to the selection instead of replacing it.
 *
 * MODULE-level, not an inline literal. React Flow feeds this straight to
 * `useKeyPress`, whose key-parsing memo and whose add/removeEventListener
 * effect are both keyed on the value's IDENTITY, so a fresh
 * `['Meta', 'Control']` per render would tear down and re-add a pair of window
 * key listeners on every render of this canvas.
 *
 * The cost is listener CHURN, and it is worth being exact about that rather
 * than claiming input loss: React runs an effect's cleanup and its re-run
 * back-to-back inside one commit, so no key event can be dispatched into the
 * gap, and `useKeyPress` holds the pressed keys in a ref that outlives the
 * teardown anyway. Cheap to avoid, so avoided — not a correctness fix.
 *
 * See the `multiSelectionKeyCode` prop for why both keys, not one.
 */
const MULTI_SELECT_KEYS = ['Meta', 'Control'];

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
 * The limit this used to state — that the carry-forward was UNCONDITIONAL, so a
 * DOMAIN position write never reached the screen once a node was in the view
 * array — was CLOSED by U17, which owed the fix. The "domain wins" escape hatch
 * is `lastDomainPositions` below: the carry-forward now yields for a node whose
 * DOMAIN position changed since the last reconcile, which is what an undo, an
 * auto-layout (U9) and a restore-version (U22) all are. It is not a relaxation
 * of this line, which the spec above
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
   * U19 — every source's outgoing PORTS, for nodes and containers alike.
   *
   * Derived from `edges` as well as from the sources, and that dependency is
   * load-bearing rather than incidental: a port set is "what this source
   * declares, plus anything its existing edges already route on"
   * (`sourcePortsOf`). Leave `edges` out and an orphaned condition never grows a
   * port, React Flow resolves that edge's `sourceHandle` to nothing, and the
   * line vanishes with no error — the exact failure the orphan arm exists to
   * prevent.
   *
   * Memoised as ONE map so the identity of each port array is stable between
   * renders that changed neither the graph nor its edges. The run monitor's
   * `mergeRunNodes` documents what an unstable `data` member costs there; here
   * it would defeat `ActivityNode`'s memo and re-render the whole node layer on
   * every viewport change.
   */
  const portsBySource = useMemo(() => {
    const used = usedConditionsBySource(edges);
    const byId = new Map<string, SourcePort[]>();
    for (const n of nodes) byId.set(n.id, sourcePortsOf(n, used.get(n.id) ?? []));
    // A container is a legal edge SOURCE but is not a `Node`, so it declares the
    // operational outcomes and nothing else — `declaredConditionsOf(undefined)`.
    for (const c of containers) byId.set(c.id, sourcePortsOf(undefined, used.get(c.id) ?? []));
    return byId;
  }, [nodes, containers, edges]);

  /** Unreachable fallback: the map above is built from these very arrays. */
  const portsOf = useCallback(
    (id: string): readonly SourcePort[] => portsBySource.get(id) ?? [],
    [portsBySource],
  );

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
  const [attempted, setAttempted] = useState<{
    from: string;
    to: string;
    /**
     * U19 — the outcome the refused gesture was DRAWN from, so the reason (and
     * the back-edge offer below) is computed for the edge the operator actually
     * attempted. Absent when the port could not be read, which downgrades the
     * message to the `success` candidate rather than losing it: a refusal
     * explained for a near-miss condition is still a refusal explained, and a
     * silent one is the defect this panel exists to remove.
     */
    condition: EdgeCondition | null;
    /**
     * U19 slice 2 — the id of the edge this gesture was REWIRING, or `null` for
     * an ordinary drag.
     *
     * It rides on `attempted` rather than living in its own state, and that is
     * the whole reason there is no stale-rewire bug here: `onConnectStart`
     * already clears `attempted` at the start of EVERY drag (reconnect drags
     * included — React Flow calls the flow-level `onConnectStart` from the
     * reconnect anchor too, 12.11.2 index.mjs:2870), so the exclusion cannot
     * outlive the gesture that set it and poison the next one's validation.
     */
    rewiring: string | null;
  } | null>(null);

  /**
   * Which edge the drag ABOUT to start is rewiring.
   *
   * A one-callback relay, not state: `onReconnectStart` fires immediately before
   * `onConnectStart` (same call site), so this carries the id across those two
   * calls and is consumed there. Nothing renders from it.
   */
  const startingRewire = useRef<string | null>(null);

  /** The edge the drag CURRENTLY in flight is rewiring, or `null`. */
  const dragRewire = useRef<string | null>(null);

  /**
   * The precheck the IN-FLIGHT drag is judged against, held in a ref.
   *
   * `isValidConnection` cannot read the `attempted`-derived memo below, because
   * React Flow calls it from inside the same `onPointerMove` that started the
   * connection (`@xyflow/system` index.js:2458-2488) — before React has
   * re-rendered — so on the first move past the drag threshold a state-derived
   * precheck is still the previous one. For a rewire that is exactly the frame
   * where the edge in hand is still counted, which flags a drop back onto its own
   * port as a duplicate. Assigned synchronously in `onConnectStart`, which runs
   * once per gesture and before any move is judged.
   */
  const dragPre = useRef<ConnectPrecheck | null>(null);

  /**
   * The candidate `isValidConnection` last REFUSED, or `null` if it accepted.
   *
   * This is the seam that gives CLICK-to-connect a refusal explanation (#941).
   * React Flow hands `onClickConnectEnd` a `structuredClone` of its store's
   * `connection` state (`@xyflow/react` 12.11.2 index.mjs:1940-1943), and on the
   * click path that state is still `initialConnection` — every field `null`
   * (`@xyflow/system` 0.0.79 index.js:77-89), because `updateConnection` is wired
   * only into the DRAG path (index.mjs:1893). So the endpoints are NOT
   * recoverable from the argument, and the ticket's premise that they are is
   * wrong.
   *
   * They are recoverable from this predicate. `isValidHandle` builds an already
   * ORIENTED `{source, target, sourceHandle, targetHandle}` and passes it to us
   * (`@xyflow/system` index.js:2591-2603) on BOTH paths, so what we record is
   * exactly the connection React Flow judged — no re-derivation, and a backwards
   * click-connect (armed on a target port) arrives the right way round already,
   * which is why the click path needs no `orientDrawnEnds`.
   *
   * Reading `event.target`'s `data-nodeid` instead would be less faithful, not
   * more: `isValidHandle` prefers `doc.elementFromPoint` over the clicked handle
   * (index.js:2565-2570), so the DOM node under the pointer can differ from the
   * one RF actually judged.
   *
   * Cleared at every gesture START as well as every END. A drag that never
   * terminates tidily would otherwise leave a candidate here for the next click
   * to report: RF fires `onConnectEnd` only when `connectionStarted`, and its
   * `onPointerUp` early-returns before that on multi-touch (index.js:2521-2545).
   */
  const lastRefused = useRef<{
    from: string;
    to: string;
    condition: EdgeCondition | null;
  } | null>(null);

  /**
   * A gesture ENDED — drop its context so the next judgement uses the live graph.
   *
   * `dragPre` holding `null` means "no drag in flight, judge against the live
   * graph", and that is load-bearing rather than tidy. React Flow ALSO offers
   * click-to-connect — click a source port, then a target (`connectOnClick`
   * defaults to `true`, `@xyflow/react` 12.11.2 index.mjs:3333). That path runs
   * through `onClickConnectStart`/`onClickConnectEnd`, NOT through the drag
   * callbacks, while still consulting this same `isValidConnection`
   * (index.mjs:1920). A ref left set by the previous drag would judge that click
   * against a stale graph — and after a REWIRE, against one MISSING AN EDGE, so
   * a duplicate would be reported valid, drawn as accepted, and then silently
   * refused by the store's backstop. That is precisely the silent no this
   * feature exists to remove, so every terminator clears the context.
   *
   * UNTESTED, deliberately and with the reason stated rather than a green test
   * that proves nothing. The consequence is currently unobservable: the stale
   * precheck is the live graph MINUS an edge, so it can only ever be more
   * PERMISSIVE, and every false accept it produces is then refused by
   * `canvasStore.connect`'s own live-graph backstop — no edge, no message,
   * exactly as if the predicate had been right. (RF also clears
   * `connectionClickStartHandle` unconditionally, index.mjs:1943, so not even
   * the click-arm state differs.) A spec was written for this and DELETED after
   * mutation testing showed it passed with the fix reverted. The fix stands
   * anyway: a predicate that judges against a graph which is not the live one is
   * wrong on its own terms, and the only thing standing between that and a
   * visible defect is a backstop in another module.
   *
   * What made that false accept silent at all — click-to-connect having NO
   * refusal explanation, because the panel was wired to the drag callbacks only
   * — was a separate pre-existing gap, and is now closed by `onClickConnectEnd`
   * below (#941). So a stale precheck here would today produce a VISIBLE wrong
   * answer rather than an invisible one, which is the better reason for this
   * clearing than the one above.
   */
  const endGesture = useCallback(() => {
    dragPre.current = null;
    dragRewire.current = null;
    startingRewire.current = null;
    lastRefused.current = null;
  }, []);
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
            ports: portsOf(n.id),
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
          // where `loadVersion` empties the selection while the view entry
          // survives by id — leaves a node that paints its selection ring,
          // reports nothing to the property panel, and CANNOT be re-selected by
          // clicking it or by Enter. (Backspace would still delete it.) The
          // operator's only way out is to click empty canvas first.
          //
          // U21 widened the store's model from one `Selection` to a SET, which
          // is what let a shift-marquee and a ctrl-click survive: the gesture is
          // still mirrored INTO the store and read back out here, so the two
          // cannot disagree — the set is simply large enough to hold what React
          // Flow reports instead of collapsing it to the last member.
          selected: selected.some((s) => s.kind === 'node' && s.id === n.id),
        };
      });
    });
  }, [nodes, nodeLabels, portsOf, selected, setFlowNodes]);

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
   * surface can re-author yet (U23, #839), so a mis-click costs more than a
   * mis-deleted node. U17 made it recoverable rather than unrecoverable — the
   * dialog now names the undo instead of claiming permanence — which is why it
   * is still a confirm and no longer a warning about something final.
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
          flowNodes.map((n) => {
            /* The nominal size is asked for the port count this node will
               render, not taken flat: a node that declares more than the four
               operational outcomes is TALLER, and a container box derived from
               the flat figure would under-cover it for the frame before React
               Flow measures. One frame here rather than permanently (the run
               monitor never measures at all), but it is the same defect.
               Computed ONCE and read for both axes — it is one answer about one
               node, and asking twice re-derived that node's whole port set. */
            const nominal = unmeasuredNodeSize(portsOf(n.id).length);
            return [
              n.id,
              {
                x: n.position.x,
                y: n.position.y,
                width: n.measured?.width ?? nominal.width,
                height: n.measured?.height ?? nominal.height,
              },
            ] as const;
          }),
        ),
        new Set(nodes.map((n) => n.id)),
      ),
    );
    return rects;
  }, [containers, nodes, flowNodes, portsOf]);

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
        handles: containerHandles(rect.width, rect.height, portsOf(c.id)),
        data: {
          kind: c.kind,
          ports: portsOf(c.id),
          label: labels.get(c.id) ?? c.kind,
          // Re-derived from the store, never carried forward — the same rule
          // and the same reason as the activity nodes' `selected` above.
          selected: selected.some((s) => s.kind === 'container' && s.id === c.id),
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
    portsOf,
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
  const sole = singleSelection(selected);
  const flowEdges: FlowEdge[] = edges.map((e) => {
    const isSelected = selected.some((s) => s.kind === 'edge' && s.id === e.id);
    return {
      ...toFlowEdge(e),
      selected: isSelected,
      /**
       * U19 slice 2 — only the SELECTED edge offers reconnect anchors.
       *
       * Not a refinement: without it the anchors are ambiguous by construction.
       * Every edge into a node ends on the one `in` port (`TARGET_PORT_ID`), so a
       * node with three inbound edges would stack three grab circles on the same
       * pixel, and two edges leaving one outcome port stack two more — with no
       * z-order tiebreak (`elevateEdgesOnSelect` is off), you would get whichever
       * React Flow happened to render last. Gating on selection makes the anchor
       * name one edge, shrinks the anchor-vs-port overlap from every edge on the
       * canvas to one, and gives the gesture a discoverable order: select it,
       * then drag its end.
       *
       * Set HERE and not in `toFlowEdge`, which the read-only run monitor also
       * calls: interaction is the author canvas's to grant.
       *
       * U21 keeps that decision intact under multi-select, which is why this
       * reads `sole` and not `isSelected`. A marquee selects every edge incident
       * to a lassoed node (React Flow's `commitUserSelectionRect` walks
       * `connectionLookup`), so painting anchors on "any selected edge" would
       * hand back exactly the stacked-anchor ambiguity above — several at once,
       * on edges the operator never aimed at.
       */
      reconnectable: sole?.kind === 'edge' && sole.id === e.id,
    };
  });

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
    st.setSelection(nextSelection(st.selected, target, selected));
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

    /* U21 — a group drag arrives as ONE batch carrying a `position` change per
       moved node (`updateNodePositions` emits every drag item together), so the
       moves are committed together. Per node it would be one undo entry each,
       and the first press would leave the group half-moved — a state the
       operator never authored. Mid-drag ticks are still dropped: the
       `dragging !== true` filter gates the whole group at once, so the domain
       graph does not churn while dragging. */
    const moves = own.flatMap((c) =>
      c.type === 'position' && c.position && c.dragging !== true
        ? [{ id: c.id, position: c.position }]
        : [],
    );
    if (moves.length > 0) st.moveNodes(moves);

    /* No LIVE path emits a `remove` today: React Flow produces one only from
       `deleteElements`, which it calls only for `deleteKeyCode` — set to `null`
       below — and nothing in this app calls it directly. Kept, and batched,
       deliberately: it is the seam's job to funnel every removal React Flow
       could ever report into the ONE cascade, so a future caller cannot bypass
       the incident-edge and container-membership rules by going around it. */
    const removed = own.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
    if (removed.length > 0) st.deleteNodesAndEdges(removed, []);

    for (const c of own) {
      if (c.type === 'select') applySelectChange({ kind: 'node', id: c.id }, c.selected);
    }
  }

  function onEdgesChange(changes: EdgeChange[]) {
    const st = store.getState();
    const removed = changes.flatMap((c) => (c.type === 'remove' ? [c.id] : []));
    if (removed.length > 0) st.deleteNodesAndEdges([], removed);
    for (const c of changes) {
      if (c.type === 'select') applySelectChange({ kind: 'edge', id: c.id }, c.selected);
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

  /**
   * The same rules, for a gesture that is MOVING an existing edge (U19 slice 2).
   *
   * The edge in hand is left OUT of the graph its new position is judged against:
   * it cannot duplicate itself, and it cannot be the cycle it is being dragged
   * out of. Without the exclusion, dropping an edge back where it started
   * reports "already has a 'success' edge" — naming the very edge the operator
   * is holding.
   *
   * The same reduction `canvasStore.rewireEdge` does before committing, so the
   * refusal on screen and the store's own backstop cannot disagree about which
   * graph the candidate was measured against.
   */
  const rewirePre = useCallback(
    (rewiring: string | null) =>
      rewiring === null
        ? connectPre
        : precomputeConnect({ nodes, edges: edges.filter((e) => e.id !== rewiring), containers }),
    [connectPre, nodes, edges, containers],
  );

  /** The precheck the RENDERED refusal is computed against. */
  const judgePre = useMemo(
    () => rewirePre(attempted?.rewiring ?? null),
    [rewirePre, attempted?.rewiring],
  );

  /**
   * The candidate a DRAWN connection proposes — one definition, three callers
   * (validity, refusal reason, back-edge offer).
   *
   * Since U19 the condition comes from the PORT the drag started on rather than
   * from a constant, and it must stay one expression: if the validity check
   * judged `success` while the store authored `failure`, a refused duplicate
   * would become an authored one.
   */
  const drawnCandidate = useCallback(
    (from: string, to: string, condition: EdgeCondition | null) => ({
      from,
      to,
      condition: condition ?? DRAWN_EDGE_CONDITION,
    }),
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
    if (!judgePre.endpoints.has(attempted.from) || !judgePre.endpoints.has(attempted.to)) {
      return null;
    }
    return connectRejection(
      judgePre,
      drawnCandidate(attempted.from, attempted.to, attempted.condition),
    );
  }, [attempted, judgePre, drawnCandidate]);

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
   *
   * The decision itself is `backEdgeOffer` — pure, and tested there. Note it
   * reads `attempted` RAW rather than through `drawnCandidate`: this offer
   * AUTHORS an edge, so unlike the refusal message above it must not inherit the
   * `success` fallback for a port the gesture could not name.
   */
  const backOffer: { from: string; to: string; condition: EdgeCondition } | null = useMemo(
    () => (attempted === null || refusal === null ? null : backEdgeOffer(judgePre, attempted)),
    [attempted, refusal, judgePre],
  );

  /**
   * Whether React Flow should allow this connection at all.
   *
   * Returning false makes RF refuse the DROP (`onConnect` never fires) and mark
   * the hovered handle invalid mid-gesture, which is the whole point: the store
   * has always refused these, but silently and only after the fact.
   *
   * Also RECORDS what it refused, in `lastRefused` — see that ref for why this
   * is the click path's only faithful source of endpoints. Writing a ref from
   * here is safe: RF calls this from an event handler, never during render.
   */
  const isValidConnection = useCallback(
    (c: Connection | FlowEdge) => {
      /* U19 — judged for the condition the PORT names. A port that says nothing
         decodable is refused outright rather than judged as `success`: the
         alternative authors an outcome the operator did not draw, and would let
         the check and the store disagree about which edge was in question. */
      const condition = conditionFromConnection(c);
      /* The precheck the CURRENT gesture set (see `dragPre`) — for a rewire that
         is the graph without the edge in hand. Falls back to the full graph for
         a check that somehow arrives outside a drag; the full graph is the
         stricter of the two, so the fallback cannot let something through. */
      const pre = dragPre.current ?? connectPre;
      const ok =
        condition !== null &&
        connectRejection(pre, drawnCandidate(c.source, c.target, condition)) === null;
      /* Recorded on BOTH refusal paths — including the undecodable port, where
         `condition` is null. That does NOT mean an undecodable port always gets
         a panel: `attempted.condition === null` sends the `refusal` memo through
         `drawnCandidate`'s `success` fallback, and if that candidate is legal
         the memo returns null and nothing renders. The drag path behaves the
         same way, and matching it is the point — this predicate decides
         validity, not what is worth saying. */
      lastRefused.current = ok ? null : { from: c.source, to: c.target, condition };
      return ok;
    },
    [connectPre, drawnCandidate],
  );

  /**
   * Every drag starts here — a new connection AND a rewire.
   *
   * React Flow calls this from the reconnect anchor too, immediately after
   * `onReconnectStart` (12.11.2 index.mjs:2870-2874). That ordering is what makes
   * this the one place that can set the rewire context for BOTH kinds of gesture:
   * an id when `onReconnectStart` just relayed one, `null` otherwise. There is
   * consequently no path that leaves a previous rewire's exclusion in force.
   */
  const onConnectStart = useCallback(() => {
    dragRewire.current = startingRewire.current;
    startingRewire.current = null;
    dragPre.current = rewirePre(dragRewire.current);
    /* Cleared at the START too, not only in `endGesture`: a drag that never
       reaches `onConnectEnd` (multi-touch — `@xyflow/system` index.js:2521-2545)
       would otherwise hand its candidate to the NEXT click-connect, which would
       then name the wrong pair of nodes out loud. */
    lastRefused.current = null;
    setAttempted(null);
  }, [rewirePre]);

  /**
   * Click-to-connect, the OTHER way React Flow starts a connection.
   *
   * Wired explicitly rather than left to `endGesture`'s clearing, so the
   * property does not depend on the drag path having terminated tidily: a click
   * gesture is never a rewire (the reconnect anchor is drag-only), so its
   * context is "no rewire, live graph" stated outright.
   */
  const onClickConnectStart = useCallback(() => {
    endGesture();
    setAttempted(null);
  }, [endGesture]);

  /**
   * #941 — SAY WHY a CLICK-connected edge was refused.
   *
   * `onConnectEnd` below does this for the drag gesture. Click-to-connect runs
   * through different callbacks entirely, so until now a refused click authored
   * nothing and said nothing — the silent no U6a/U6b exist to remove, surviving
   * in the one gesture no spec drove.
   *
   * Both gestures consult the same `isValidConnection`, so a refused click was
   * always correctly REFUSED; only the explanation was missing. That is why this
   * reads the refusal out of that predicate rather than re-deriving it.
   *
   * Silent when nothing was recorded, and each of those cases is deliberate:
   *  - a STRUCTURALLY impossible click (source→source, or the same handle twice)
   *    short-circuits at `isValid && isValidConnection(...)` (`@xyflow/system`
   *    index.js:2603) so this predicate never runs. The drag path is silent for
   *    exactly these too, and for the same stated reason: the obstacle is the
   *    gesture, not a rule about the graph.
   *  - an ACCEPTED click records `null`, and RF has already called `onConnect`
   *    (via `onConnectExtended`, index.mjs:1938) BEFORE this fires, so the edge
   *    is authored and there is nothing to explain.
   *
   * `rewiring: null` is a fact, not a default: the reconnect anchor is
   * drag-only, so a click gesture never moves an existing edge. It follows that
   * the back-edge offer stays available here, which is right — the offer AUTHORS
   * an edge, and authoring is exactly what this gesture was trying to do.
   */
  const onClickConnectEnd = useCallback(() => {
    /* Read the gesture's context, then END it — the clearing `endGesture` does
       is load-bearing for the NEXT gesture's precheck, so it must happen on
       every path through here, refusal or not. */
    const refused = lastRefused.current;
    endGesture();
    if (refused === null) return;
    setAttempted({ ...refused, rewiring: null });
  }, [endGesture]);

  function onConnect(conn: Connection) {
    setAttempted(null);
    // The SAME condition `isValidConnection` judged, read from the same port, so
    // what was allowed is what gets authored. React Flow normalises `Connection`
    // to (source, target) whichever end the drag began on, so a backwards drag
    // still names the outcome port.
    const condition = conditionFromConnection(conn);
    if (condition === null) return;
    if (conn.source && conn.target) store.getState().connect(conn.source, conn.target, condition);
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
    /* Read the gesture's context, then END it — before any early return, so a
       cancelled or accepted drag leaves nothing behind for the next one. */
    const rewiring = dragRewire.current;
    endGesture();
    if (state.isValid !== false) return;
    const origin = state.fromNode?.id;
    const release = state.toNode?.id;
    if (origin === undefined || release === undefined) return;
    /* The SOURCE-side handle, whichever end the drag started on — the same
       normalisation `orientDrawnEnds` does for the endpoints, applied to the
       port. RF hands this callback the raw gesture, so on a backwards drag the
       outcome port is the one it ENDED on. */
    const sourceHandle =
      state.fromHandle?.type === 'target' ? state.toHandle?.id : state.fromHandle?.id;
    setAttempted({
      ...orientDrawnEnds(origin, release, state.fromHandle?.type),
      condition: conditionFromConnection({ sourceHandle }),
      rewiring,
    });
  }

  /**
   * U19 slice 2 — relay which edge the reconnect anchor picked up.
   *
   * Deliberately does no work of its own. React Flow calls `onConnectStart`
   * immediately after this, and that is where a gesture's context is
   * established, for both kinds of drag, in one place.
   */
  function onReconnectStart(_event: ReactMouseEvent, edge: FlowEdge) {
    startingRewire.current = edge.id;
  }

  /**
   * Commit a rewire: the edge keeps its id, its back-ness and its cap, and takes
   * the endpoints and outcome the gesture just named.
   *
   * The condition comes off the same `conditionFromConnection` seam the connect
   * path uses, so what `isValidConnection` judged is what gets written — and an
   * undecodable port writes nothing rather than falling back to `success`
   * (`DRAWN_EDGE_CONDITION`'s stated contract: the message may guess, an act
   * may not).
   *
   * Reading the SOURCE-side handle whichever end was dragged is handled by React
   * Flow itself here: unlike `onConnectEnd`, `Connection` arrives already
   * normalised to (source, target).
   */
  function onReconnect(oldEdge: FlowEdge, conn: Connection) {
    setAttempted(null);
    const condition = conditionFromConnection(conn);
    if (condition === null) return;
    if (!conn.source || !conn.target) return;
    store.getState().rewireEdge(oldEdge.id, { from: conn.source, to: conn.target, condition });
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
        /* U19 — reduced from React Flow's default 20. `getClosestHandle` snaps a
           drag to any handle inside this radius and skips only the exact one it
           started on, so a radius wider than half the port pitch would make
           grabbing `success` snap to `failure`. The number and the pitch it is
           constrained by live together in `ports.ts`, with a test pinning the
           relationship. */
        connectionRadius={CONNECTION_RADIUS}
        /* U21 — the canvas OWNS the delete key; React Flow does not.
           `deleteElements` fires the edge removals and the node removals as two
           separate callbacks (`triggerEdgeChanges` then `triggerNodeChanges`),
           which through the change seam is two `edit()` calls and so two undo
           entries: one press would restore a deleted node and leave its cascaded
           edge gone. That split predates multi-select — a group delete would
           have multiplied it. `PipelineCanvas`'s document keydown handler calls
           `deleteSelection()` instead, which is one entry for the whole
           gesture. */
        deleteKeyCode={null}
        /* #947 — BOTH modifiers, on every platform, instead of React Flow's
           default `isMacOs() ? 'Meta' : 'Control'`.

           That default is a USER-AGENT test, not a platform one, and the two
           can disagree: an embedded webview, a spoofed UA, or Playwright's
           `devices['Desktop Chrome']` (which reports Windows while running on
           a Mac) each pick the modifier the HOST does not use. On a Mac the
           consequence of picking Control is not a degraded gesture but no
           gesture at all: Control-click there IS the secondary-button
           gesture, so Chromium dispatches `contextmenu` INSTEAD of `click`
           (measured — the button stays 0; it is the click that goes missing).
           Node selection by pointer runs in React's `onClick`, because React
           Flow's default `nodeDragThreshold` of 1 defers `handleNodeClick`
           off the drag-start path, so the whole selection handler simply
           never runs.

           Accepting the array costs nothing — `useKeyPress` matches any entry
           — and removes the guess: ⌘-click and Ctrl-click both add to the
           selection wherever the operator actually is. Admitting Control on a
           Mac is safe rather than merely harmless: `useKeyPress` clears its
           pressed state on `contextmenu`, which is precisely the event a Mac
           Control-click produces, so it cannot strand `multiSelectionActive`
           on. The mirror case is the genuinely NEW behaviour here: Meta was
           inert on Windows/Linux before, and is now a multi-select modifier
           there too. Pressing Super normally moves focus to the Start menu or
           the activities overview, and the same hook resets on `blur` — but a
           compositor that grabs the key globally WITHOUT blurring the window
           could swallow the `keyup` and leave the flag on. Worst case is that
           the next plain click adds instead of replacing, and a pane click
           clears it; not worth guarding, worth knowing.

           Fixing the harness's user agent instead would NOT do: `test:e2e` runs
           on ubuntu in CI and on macOS locally, so only a UA-independent prop
           lets ONE spec pass in both places.

           Knowingly left: `zoomActivationKeyCode` carries the identical
           `isMacOs()` guess. It gates scroll-zoom, which never meets the
           `contextmenu`-instead-of-`click` failure above, so it is a separate
           question rather than part of this one. */
        multiSelectionKeyCode={MULTI_SELECT_KEYS}
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
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onClickConnectStart={onClickConnectStart}
        onClickConnectEnd={onClickConnectEnd}
        onReconnectStart={onReconnectStart}
        onReconnect={onReconnect}
        reconnectRadius={RECONNECT_RADIUS}
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
                    .connect(backOffer.from, backOffer.to, backOffer.condition, { back: true });
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
