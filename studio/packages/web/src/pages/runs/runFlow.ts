import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import {
  COPY_ACTIVITY_TYPE,
  containerMembership,
  type Node,
  type PipelineVersion,
  type RunState,
} from '@autonomy-studio/shared';
import { activityLabel, activityLabels } from '../pipeline/activityLabel';
import {
  containerAriaLabel,
  containerHandles,
  containerRects,
  UNMEASURED_NODE_SIZE,
} from '../pipeline/containerLayout';
import { containerLabels } from '../pipeline/containerRules';
import { activityBadges, activitySummary, type ActivityBadge } from '../pipeline/activitySummary';
import { toFlowEdge } from '../pipeline/edgeCondition';
import {
  nodeBoxHeight,
  portIdsOf,
  sourcePortsOf,
  usedConditionsBySource,
  type SourcePort,
} from '../pipeline/ports';
import {
  containerStatusLabel,
  containerStatusTone,
  nodeStatusLabel,
  nodeStatusTone,
  type StatusTone,
} from './nodeStatus';
import { formatCount, formatNodeDuration, isMeasurableSpan } from './format';
import type { NodeActivity } from './runSummary';

/**
 * U11 — the doc + run state → React Flow arrays, as PURE functions.
 *
 * Separate from `RunCanvas` so they can be tested for real: jsdom measures every
 * element as zero, and React Flow's `onlyRenderVisibleElements` culls against
 * that, so a component test can assert the canvas MOUNTED but never what is on
 * it. The author canvas has the same constraint and answers it the same way —
 * pure modules unit-tested, the rendering itself covered by an e2e.
 */

/** The doc fields this view needs — R1's `pipelineVersion`, structurally. */
export type RunDoc = Pick<PipelineVersion, 'nodes' | 'edges' | 'containers'>;

export interface RunNodeData extends Record<string, unknown> {
  title: string;
  /**
   * U19 — this source's outgoing ports, as ONE string (`portIdsOf`).
   *
   * A primitive rather than the `SourcePort[]` the author canvas passes,
   * because `sameRenderedData` below compares `data` members with `Object.is`:
   * a fresh array per event would report every node as changed and undo
   * `mergeRunNodes`' whole reason for existing. `RunCanvas` rebuilds the ports
   * from it.
   */
  portIds: string;
  /**
   * The node's status AS WORDED FOR AN OPERATOR (`nodeStatusLabel`), or `null`
   * when nothing is projected yet. The engine's identifier is deliberately not
   * what reaches the screen — U25 gave the Monitor one vocabulary, and this is
   * the same string the run table's pill shows.
   */
  status: string | null;
  tone: StatusTone | null;
  /**
   * Whether this view has a RUN behind it at all (#903). `false` on the version
   * history's read-only preview, where there is no run to be projected and so
   * `NO_STATUS_LABEL` would state a falsehood rather than an absence.
   *
   * It has to reach the node's `data`, not just this module: the memoized node
   * components render `status ?? NO_STATUS_LABEL`, so a null `status` alone
   * cannot tell them which of the two absences they are looking at.
   */
  showStatus: boolean;
  /**
   * #1394 OR3 — the authoring card's content: type (for the glyph), what the
   * step does, and its policy badges. A fact of the VERSION, so it is built once
   * per doc (`runCards`) and carried by reference: `sameRenderedData` compares
   * with `Object.is`, and a fresh object per event would re-render every node.
   */
  card: RunCard;
  /**
   * #1394 OR3 — what this run measured on the node, worded (`1.2s · 3 rows`),
   * or `null` when nothing is on record. A primitive for the same `Object.is`
   * reason `portIds` is one.
   */
  facts: string | null;
}

/** What `runNodeFacts` reads off a node's activity row. */
export type RunNodeMeasure = Pick<
  NodeActivity,
  'startedAtMs' | 'endedAtMs' | 'outputValues' | 'copiedFromRunId'
>;

/** The version-derived half of a run card — see `RunNodeData.card`. */
export interface RunCard {
  type: string;
  summary: string | null;
  badges: readonly ActivityBadge[];
}

/**
 * Every node's card, built ONCE per doc. The caller memoizes the result (on the
 * doc and its dataset names) so each card keeps its identity across run events.
 */
export function runCards(
  doc: RunDoc,
  datasetName: (id: string) => string | undefined = () => undefined,
): Map<string, RunCard> {
  return new Map(
    doc.nodes.map((n) => {
      const next: RunCard = {
        type: n.type,
        summary: activitySummary(n, datasetName),
        badges: activityBadges(n),
      };
      /* Reuse this node's last card when it is equal: the dataset names arrive
         AFTER the first paint, and a fresh object for every node would re-render
         the whole graph (and blink every edge) to change only the Copy cards.
         Keyed by the doc's own node object, which a version never replaces. */
      const prev = lastCard.get(n);
      if (prev !== undefined && sameCard(prev, next)) return [n.id, prev];
      lastCard.set(n, next);
      return [n.id, next];
    }),
  );
}

const lastCard = new WeakMap<Node, RunCard>();

function sameCard(a: RunCard, b: RunCard): boolean {
  return (
    a.type === b.type &&
    a.summary === b.summary &&
    a.badges.length === b.badges.length &&
    a.badges.every((x, i) => x.key === b.badges[i]!.key && x.label === b.badges[i]!.label)
  );
}

/**
 * #1394 OR3 — the numbers a run card shows under its status: the settled
 * duration and, for a Copy Data node, the rows it wrote.
 *
 * Only what THIS run measured. An open span has no duration yet (the node table
 * counts that one up live), and `formatNodeDuration`'s em-dash is the table's
 * way of saying so in a cell — on a card the absence is simply nothing. A node a
 * rerun COPIED ran in the source run, so its recorded rows are that run's and it
 * says nothing here. Rows are read only off a Copy node, whose catalog entry
 * declares them: any other node's `rowsWritten` output (a webhook's, a child
 * pipeline's) is a value it was handed, not a count it made.
 */
export function runNodeFacts(type: string, activity: RunNodeMeasure | undefined): string | null {
  if (activity === undefined || activity.copiedFromRunId !== undefined) return null;
  const parts: string[] = [];
  if (isMeasurableSpan(activity)) parts.push(formatNodeDuration(activity));
  const out = type === COPY_ACTIVITY_TYPE ? activity.outputValues : undefined;
  const written = out?.['rowsWritten'];
  if (isCount(written)) {
    parts.push(`${formatCount(written)} ${written === 1 ? 'row' : 'rows'}`);
    const failed = out?.['rowsFailed'];
    if (isCount(failed) && failed > 0) parts.push(`${formatCount(failed)} failed`);
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** A recorded output is `unknown`: only a whole, non-negative number is a count. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/**
 * The nodes that can run MORE THAN ONCE in a run: those inside a `foreach` or
 * `loop` box at any depth, and those on a back edge's cycle. Such a node's
 * activity row holds only the LATEST attempt's span and outputs, so a card would
 * state one iteration's `1 row` for a copy that wrote three. Its card says
 * nothing measured instead; a box already states its progress (`3 of 3 items`),
 * and the node table has the per-attempt detail. Cached per doc, like the cards.
 */
const repeatedCache = new WeakMap<RunDoc, Set<string>>();
function repeatedNodeIds(doc: RunDoc): Set<string> {
  const hit = repeatedCache.get(doc);
  if (hit !== undefined) return hit;
  const out = new Set<string>();
  const containers = doc.containers ?? [];
  if (containers.length > 0) {
    const { owner } = containerMembership(containers);
    const kind = new Map(containers.map((c) => [c.id, c.kind]));
    for (const n of doc.nodes) {
      // Walk up the owners; `seen` bounds a malformed cyclic membership.
      const seen = new Set<string>();
      for (let c = owner.get(n.id); c !== undefined && !seen.has(c); c = owner.get(c)) {
        seen.add(c);
        if (kind.get(c) !== 'stage') {
          out.add(n.id);
          break;
        }
      }
    }
  }
  /* A back edge `from → to` re-runs every node on a forward path from `to` to
     `from`: reachable forward from `to` AND reaching `from`, over the forward
     edges alone. */
  const forward = doc.edges.filter((e) => e.back !== true);
  const reach = (start: string, next: (id: string) => string[]) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length > 0) {
      for (const m of next(stack.pop()!)) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    return seen;
  };
  const succ = (id: string) => forward.filter((e) => e.from === id).map((e) => e.to);
  const pred = (id: string) => forward.filter((e) => e.to === id).map((e) => e.from);
  for (const back of doc.edges.filter((e) => e.back === true)) {
    const reachesFrom = reach(back.from, pred);
    for (const id of reach(back.to, succ)) if (reachesFrom.has(id)) out.add(id);
  }
  repeatedCache.set(doc, out);
  return out;
}

/**
 * #1394 OR3 — a run card's height. FIXED rather than measured-then-grown: this
 * view never measures anything, so the container boxes around the cards are
 * drawn from this same number (`runFlowNodes`), and a card taller than it would
 * poke out of its box. It fits a two-line name, the summary row and the status
 * row, and the card is drawn at exactly this height (`RunCanvas`), so it cannot
 * outgrow its box whatever the content.
 */
export const RUN_NODE_BASE_HEIGHT = 104;

export function runNodeHeight(portCount: number): number {
  return Math.max(RUN_NODE_BASE_HEIGHT, nodeBoxHeight(portCount));
}

export interface RunContainerData extends Record<string, unknown> {
  /**
   * What the box DRAWS, and therefore what `containerAriaLabel` announces —
   * the `containerLabels` ordinal (`loop 2`), not the bare kind (#886). It is
   * the kind that is not identifying: a doc with two loops has two boxes whose
   * kind is the same string, which is what the author canvas learned in #883.
   */
  name: string;
  /**
   * AS WORDED FOR AN OPERATOR, the same commitment `RunNodeData.status` above
   * makes, and `string` rather than `ContainerRunStatus` for the same reason:
   * the engine's identifier is not what reaches the screen.
   *
   * Both have been `string` since U11 (`d432814`), when the engine's own word
   * WAS what reached the screen for each — so the width was never a promise of
   * wording. U25 made the node half honest by wording its producer; #873 does
   * the same for this one.
   */
  status: string | null;
  tone: StatusTone | null;
  /**
   * A loop's or stage's own progress; `null` until it has started, and always
   * `null` for a foreach, whose `round` is the 0-based index of the item in
   * flight — a finished 3-item foreach would read "round 2" (#1420).
   */
  round: number | null;
  /** #1420 — a foreach's progress, worded (`2 of 3 items`); `null` for loop/stage
   * and before the foreach has resolved its `items`. */
  items: string | null;
  /** U19 — a container is a legal edge SOURCE too. Same encoding, same reason. */
  portIds: string;
  /*
   * Deliberately NO `showStatus` twin of `RunNodeData`'s. The box has only ONE
   * absence to render: it already drops the whole ` · <status>` fragment when
   * `status` is null (`RunCanvas`'s `RunContainerNode`), where the activity node
   * falls back to `NO_STATUS_LABEL` and so has to be told which absence it is
   * looking at. Suppression reaches the box through `status` being forced null,
   * and its accessible name through the builder's own local flag — a field here
   * would be set, pinned by a test, and read by nothing.
   */
}

/** How a doc is drawn when there is no run behind it (#903). */
export interface RunFlowOptions {
  /**
   * `false` suppresses every run-status word, on the boxes and in the
   * accessible names. Stated as a property of the VIEW rather than inferred
   * from `state === null`, which is a different fact: a run whose state is not
   * folded yet still owes the operator "not projected".
   */
  showStatus?: boolean;
  /**
   * #1394 OR3 — each node's card, from `runCards`; absent, built here without
   * dataset names.
   */
  cards?: ReadonlyMap<string, RunCard>;
  /** #1394 OR3 — the page's per-node activity rows, keyed by doc node id, for
   * `runNodeFacts`. Absent on a view with no run behind it. */
  activity?: ReadonlyMap<string, RunNodeMeasure>;
}

/** What a node says when the run has no state for it. */
export const NO_STATUS_LABEL = 'not projected';

export function toneClass(prefix: 'run-node' | 'run-container', tone: StatusTone | null): string {
  return tone === null ? '' : ` ${prefix}-${tone}`;
}

/**
 * The activity nodes, plus the container boxes BEHIND them.
 *
 * `state` is `null` for "not projected (yet)", which is a real and different
 * state from "every node is pending": the engine's seed holds no nodes until
 * `run.started` folds, so drawing an unprojected run as all-pending would claim
 * a finished run never ran. Every node then carries `status: null` and no tone.
 */
export function runFlowNodes(
  doc: RunDoc,
  state: RunState | null,
  options: RunFlowOptions = {},
): FlowNode[] {
  const showStatus = options.showStatus ?? true;
  const cards = options.cards ?? runCards(doc);
  const repeated = repeatedNodeIds(doc);
  /* #878 — the run graph names an activity the same way the authoring canvas
     does: kind plus within-kind ordinal. Two `http_request` nodes in one run
     would otherwise be two boxes reading "HTTP Request", in the view whose job
     is to say WHICH node failed.

     The node table and the drill-in panel on this same page read the same
     `activityLabels` map since #882, so one node has one name across the whole
     view. They resolve it against the RUN's rows rather than the doc's, so they
     also carry the fallback this branch has no need of: a row the doc does not
     name keeps its raw id. */
  const names = activityLabels(doc.nodes);
  /* U19 — the ports each source draws, so an edge's `sourceHandle` resolves to
     a handle that exists. The monitor renders the SAME edges as the author
     canvas (`toFlowEdge`), which now names the port of the edge's own outcome:
     without the matching ports here every edge on this view would resolve to
     nothing and simply not be drawn. */
  const used = usedConditionsBySource(doc.edges);
  /* Memoized, because every id is asked TWICE and `sourcePortsOf` rebuilds the
     whole list each call: a node's ports feed both the count the unmeasured-size
     fallback needs and the id string its data carries, and a container's feed
     both its stated handle bounds and its own id string. Keyed by id alone,
     which is sound because nodes and containers share one globally-unique
     namespace (the same assumption `edgeEndpointIds` is built on). */
  const cache = new Map<string, SourcePort[]>();
  const portsOf = (id: string, source: Node | undefined) => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const ports = sourcePortsOf(source, used.get(id) ?? []);
    cache.set(id, ports);
    return ports;
  };
  const portCounts = new Map(doc.nodes.map((n) => [n.id, portsOf(n.id, n).length]));
  const activities: FlowNode[] = doc.nodes.map((n) => {
    // Unreachable fallback: `names` is built from this very array.
    const name = names.get(n.id) ?? activityLabel(n);
    const status = showStatus ? (state?.nodes[n.id]?.status ?? null) : null;
    /* U25 — the node says the same word the table's pill does. The TONE still
       comes off the raw engine status, except where a cancel stopped the node
       (#1329, see `nodeStatusTone`); only what an operator reads is worded. */
    const label = status === null ? null : nodeStatusLabel(status, state?.status);
    return {
      id: n.id,
      type: 'runActivity',
      position: n.position,
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        title: name,
        status: label,
        tone: status === null ? null : nodeStatusTone(status, state?.status),
        showStatus,
        portIds: portIdsOf(portsOf(n.id, n)),
        // Unreachable fallback: `runCards` is built from this very array.
        card: cards.get(n.id) ?? { type: n.type, summary: null, badges: [] },
        /* Only on a SETTLED node: a held, re-opened or skipped node's row can
           still carry an earlier attempt's span, which is not this state's. */
        facts:
          (status === 'success' || status === 'failure') && !repeated.has(n.id)
            ? runNodeFacts(n.type, options.activity?.get(n.id))
            : null,
      } satisfies RunNodeData,
      ariaLabel: showStatus ? `${name}, ${label ?? NO_STATUS_LABEL}` : name,
    };
  });

  const containers = doc.containers ?? [];
  if (containers.length === 0) return activities;

  /* The boxes are derived from the nodes' geometry, exactly as on the author
     canvas. There the rects come from React Flow's MEASURED sizes; here from
     the nominal one, because nothing is measured on a first paint and this view
     never re-lays-out afterwards. So a box can sit a few pixels loose around its
     children — never a wrong MEMBERSHIP, which is the part that carries
     meaning. */
  const rects = containerRects(
    containers,
    new Map(
      /* U19 — a node's height is now a function of how many outcomes it
         declares, and this view never measures anything, so the nominal size
         has to be asked for the same count the node will render. Taking the
         flat pre-U19 constant would leave every box under-covering its own
         children the moment one grew a port column. */
      doc.nodes.map((n) => [
        n.id,
        {
          x: n.position.x,
          y: n.position.y,
          width: UNMEASURED_NODE_SIZE.width,
          // #1394 OR3 — the card's own fixed height, not the author canvas's
          // unmeasured guess: see `RUN_NODE_BASE_HEIGHT`.
          height: runNodeHeight(portCounts.get(n.id) ?? 0),
        },
      ]),
    ),
  );

  /* #886 — the same ordinal the author canvas draws, so a doc authored as
     `loop 1` / `loop 2` is not drawn as `loop` / `loop` the moment it runs. The
     activities inside these boxes have been named this way since #878; before
     this, the two halves of one picture named the same rectangle differently. */
  const containerNames = containerLabels(containers);

  const boxes: FlowNode[] = containers.map((c) => {
    const rect = rects.get(c.id)!;
    // Unreachable fallback: `containerNames` is built from this very array.
    const name = containerNames.get(c.id) ?? c.kind;
    const cs = showStatus ? (state?.containers[c.id] ?? null) : null;
    const status = cs?.status ?? null;
    /* #873 — worded HERE, not at the render site the ticket suggested, so the
       box and its accessible name below cannot come to disagree about WHICH WORD
       a status gets, and so nothing has to cast `data.status` back to
       `ContainerRunStatus` to word it. Same shape as the activity branch above;
       the TONE still reads the raw status, except under a cancel (#1329).

       They do still differ on the NULL path, and that is pre-existing rather
       than introduced here: `RunCanvas` drops the whole ` · <status>` fragment
       when `status` is null, so an unprojected box reads `stage` while its
       accessible name reads `…, not projected`. Worth knowing before reading the
       sentence above as stronger than it is. */
    const label = status === null ? null : containerStatusLabel(status, state?.status);
    const items = c.kind === 'foreach' ? foreachProgress(cs) : null;
    return {
      id: c.id,
      type: 'runContainer',
      position: { x: rect.x, y: rect.y },
      // Stated, not measured — a derived node React Flow can never measure loses
      // every edge that touches it without BOTH of these. The author canvas
      // records the full reasoning; `e2e/container-rendering.spec.ts`
      // mutation-proves it there.
      width: rect.width,
      height: rect.height,
      style: { width: rect.width, height: rect.height },
      measured: { width: rect.width, height: rect.height },
      /* COLLAPSED, permanently — the run monitor has no fan and needs none.
         `connectable: false` below is the reason in one word: nothing here can
         draw or re-point an edge, so a port exists only as the anchor its edge
         binds to, and every edge leaving one point at the box's middle is the
         resting look #992/#997 are for. The `false` matches what `RunCanvas`
         draws, which never carries `data-ports-expanded`; stated and rendered
         agree, which on a derived node nothing else would ever correct. */
      handles: containerHandles(rect.width, rect.height, portsOf(c.id, undefined), false),
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        name,
        status: label,
        tone: status === null ? null : containerStatusTone(status, state?.status),
        round: c.kind === 'foreach' ? null : (cs?.round ?? null),
        items,
        portIds: portIdsOf(portsOf(c.id, undefined)),
      } satisfies RunContainerData,
      ariaRole: 'group',
      // The box below draws this same `name`, which is the whole contract
      // `containerAriaLabel` documents — announcing an ordinal the picture does
      // not show would move the mismatch rather than close it.
      ariaLabel: showStatus
        ? `${containerAriaLabel(name, rect.childCount)}, ${label ?? NO_STATUS_LABEL}` +
          (items === null ? '' : `, ${items}`)
        : containerAriaLabel(name, rect.childCount),
    };
  });

  // Containers first, so a box paints BEHIND the activities it encloses.
  return [...boxes, ...activities];
}

/** #1395 OR4 — what the authoring canvas draws over one box while a run it
 * started is live. `type` is the activity's type — or the container's kind — in
 * the RUN's version, so a box whose draft has since changed it can decline an
 * entry that no longer describes it. */
export interface RunOverlayEntry {
  type: string;
  status: string;
  tone: StatusTone | null;
  /** A settled activity's duration and rows, or a container's progress. */
  facts: string | null;
}

/**
 * #1395 OR4 — the run's state per box, for the AUTHORING canvas's overlay.
 *
 * Read off `runFlowNodes` rather than worded again, so the editor and the
 * monitor share one status vocabulary, one tone map, and one rule for when a
 * node's facts are its own (settled, not repeated). An unprojected box has NO
 * entry: "not projected" is a monitor's sentence about a run it is showing, and
 * an editor with no state yet simply shows its cards.
 */
export function runNodeOverlay(
  doc: RunDoc,
  state: RunState | null,
  activity?: ReadonlyMap<string, RunNodeMeasure>,
): Map<string, RunOverlayEntry> {
  const out = new Map<string, RunOverlayEntry>();
  const types = new Map<string, string>([
    ...doc.nodes.map((n) => [n.id, n.type] as const),
    ...(doc.containers ?? []).map((c) => [c.id, c.kind] as const),
  ]);
  for (const n of runFlowNodes(doc, state, activity === undefined ? {} : { activity })) {
    if (n.type === 'runContainer') {
      const d = n.data as RunContainerData;
      if (d.status === null) continue;
      const progress =
        d.items ?? (d.round !== null && d.round > 0 ? `round ${String(d.round)}` : null);
      out.set(n.id, {
        type: types.get(n.id) ?? '',
        status: d.status,
        tone: d.tone,
        facts: progress,
      });
    } else {
      const d = n.data as RunNodeData;
      if (d.status === null) continue;
      out.set(n.id, {
        type: types.get(n.id) ?? '',
        status: d.status,
        tone: d.tone,
        facts: d.facts,
      });
    }
  }
  return out;
}

/**
 * #1420 — how many of a foreach's items have COMPLETED. `results` holds one entry
 * per completed item in sequential mode, and is seeded full-length with `null`
 * holes for the in-flight ones in parallel mode (`ContainerRunState.results`),
 * so counting non-null entries is right for both.
 */
function foreachProgress(cs: RunState['containers'][string] | null): string | null {
  if (cs?.items === undefined) return null;
  const total = cs.items.length;
  const done = (cs.results ?? []).filter((r) => r !== null).length;
  return `${done} of ${total} ${total === 1 ? 'item' : 'items'}`;
}

/**
 * The edges — the author canvas's own `toFlowEdge`, with every interaction
 * affordance off. Shared as CODE, so the two views cannot come to draw the same
 * edge differently.
 */
export function runFlowEdges(doc: RunDoc): FlowEdge[] {
  return doc.edges.map((e) => ({ ...toFlowEdge(e), selectable: false, focusable: false }));
}

/**
 * Is every rendered field of these two `data` objects equal?
 *
 * A SHALLOW compare over all keys, rather than the named-field list this
 * started as. Both node kinds' data are flat records of primitives (`title`,
 * `status`, `tone`, `kind`, `round`), and a named list silently under-compared
 * the moment a second kind arrived: it checked `title`/`status`/`tone` only, so
 * a LOOPING container — which the engine keeps `active` across re-rounds while
 * only `round` advances — matched as unchanged and kept its stale object, and
 * the "· round N" label froze on screen for the whole loop.
 *
 * Enumerating what a node renders is exactly the thing that goes out of date, so
 * it is no longer enumerated. Should a non-primitive field ever be added to
 * either data type, this returns `false` for it every time — a redundant rebuild
 * (the pre-`mergeRunNodes` behaviour, plus the carried-forward measurement),
 * never a frozen one.
 */
function sameRenderedData(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.is(a[k], b[k]));
}

/**
 * Merge a freshly-built node array into the one React Flow currently holds,
 * PRESERVING object identity wherever nothing on screen changed.
 *
 * This is not an optimisation, it is a correctness fix. `runFlowNodes` builds
 * brand-new objects, and React Flow's `adoptUserNodes` rebuilds a node's
 * internals for any user node that is not reference-identical to the previous
 * one — including `handleBounds`, which `parseHandles` leaves `undefined` for a
 * node that states neither `measured` nor `handles`. `getEdgePosition` then
 * returns `null` for an endpoint with no handle bounds, so EVERY edge touching
 * a rebuilt node renders as nothing until the ResizeObserver re-measures a
 * frame later. Since the projection returns a fresh `RunState` per event, that
 * would be every edge blinking on every event of a live run — precisely the
 * case this view exists for. (Container boxes were already immune: they state
 * their own `measured` + `handles`.)
 *
 * So: a node whose rendered data is unchanged is returned AS THE SAME OBJECT,
 * and one whose data did change carries the measurement forward.
 */

export function mergeRunNodes(prev: FlowNode[], next: FlowNode[]): FlowNode[] {
  const before = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const old = before.get(n.id);
    if (old === undefined) return n;
    if (
      old.type === n.type &&
      sameRenderedData(old.data, n.data) &&
      old.position.x === n.position.x &&
      old.position.y === n.position.y
    ) {
      return old;
    }
    // Changed — keep whatever React Flow measured, so the node does not fall
    // back to uninitialised and take its edges with it for a frame.
    return { ...n, measured: n.measured ?? old.measured, handles: n.handles ?? old.handles };
  });
}
