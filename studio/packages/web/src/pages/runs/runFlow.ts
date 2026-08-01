import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { PipelineVersion, RunState } from '@autonomy-studio/shared';
import { activityLabels } from '../pipeline/activityLabel';
import {
  containerAriaLabel,
  containerHandles,
  containerRects,
  UNMEASURED_NODE_SIZE,
} from '../pipeline/containerLayout';
import { toFlowEdge } from '../pipeline/edgeCondition';
import {
  containerStatusLabel,
  containerStatusTone,
  nodeStatusLabel,
  nodeStatusTone,
  type StatusTone,
} from './nodeStatus';

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
   * The node's status AS WORDED FOR AN OPERATOR (`nodeStatusLabel`), or `null`
   * when nothing is projected yet. The engine's identifier is deliberately not
   * what reaches the screen — U25 gave the Monitor one vocabulary, and this is
   * the same string the run table's pill shows.
   */
  status: string | null;
  tone: StatusTone | null;
}

export interface RunContainerData extends Record<string, unknown> {
  kind: PipelineVersion['containers'][number]['kind'];
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
  /** A container's own progress; `null` until it has started. */
  round: number | null;
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
export function runFlowNodes(doc: RunDoc, state: RunState | null): FlowNode[] {
  /* #878 — the run graph names an activity the same way the authoring canvas
     does: kind plus within-kind ordinal. Two `http_request` nodes in one run
     would otherwise be two boxes reading "HTTP Request", and a monitor whose
     whole job is to say WHICH node failed cannot afford that. */
  const names = activityLabels(doc.nodes);
  const activities: FlowNode[] = doc.nodes.map((n) => {
    const name = names.get(n.id) ?? n.id;
    const status = state?.nodes[n.id]?.status ?? null;
    /* U25 — the node says the same word the table's pill does. The TONE still
       comes off the raw engine status; only what an operator reads is worded. */
    const label = status === null ? null : nodeStatusLabel(status);
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
        tone: status === null ? null : nodeStatusTone(status),
      } satisfies RunNodeData,
      ariaLabel: `${name}, ${label ?? NO_STATUS_LABEL}`,
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
      doc.nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y, ...UNMEASURED_NODE_SIZE }]),
    ),
  );

  const boxes: FlowNode[] = containers.map((c) => {
    const rect = rects.get(c.id)!;
    const cs = state?.containers[c.id] ?? null;
    const status = cs?.status ?? null;
    /* #873 — worded HERE, not at the render site the ticket suggested, so the
       box and its accessible name below cannot come to disagree about WHICH WORD
       a status gets, and so nothing has to cast `data.status` back to
       `ContainerRunStatus` to word it. Same shape as the activity branch above;
       the TONE still reads the raw status.

       They do still differ on the NULL path, and that is pre-existing rather
       than introduced here: `RunCanvas` drops the whole ` · <status>` fragment
       when `status` is null, so an unprojected box reads `stage` while its
       accessible name reads `…, not projected`. Worth knowing before reading the
       sentence above as stronger than it is. */
    const label = status === null ? null : containerStatusLabel(status);
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
      handles: containerHandles(rect.width, rect.height),
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        kind: c.kind,
        status: label,
        tone: status === null ? null : containerStatusTone(status),
        round: cs?.round ?? null,
      } satisfies RunContainerData,
      ariaRole: 'group',
      ariaLabel: `${containerAriaLabel(c.kind, rect.childCount)}, ${label ?? NO_STATUS_LABEL}`,
    };
  });

  // Containers first, so a box paints BEHIND the activities it encloses.
  return [...boxes, ...activities];
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
