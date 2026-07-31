import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react';
import type { PipelineVersion, RunState } from '@autonomy-studio/shared';
import { activityLabel } from '../pipeline/activityLabel';
import {
  containerAriaLabel,
  containerHandles,
  containerRects,
  UNMEASURED_NODE_SIZE,
} from '../pipeline/containerLayout';
import {
  edgeAriaLabel,
  edgeArrowMarkerId,
  edgeLabel,
  edgeVariantClass,
} from '../pipeline/edgeCondition';
import { SOURCE_PORT_ID, TARGET_PORT_ID } from '../pipeline/ports';
import { containerStatusTone, nodeStatusTone, type StatusTone } from './runProjection';

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
  /** The engine's own status word, or `null` when nothing is projected yet. */
  status: string | null;
  tone: StatusTone | null;
}

export interface RunContainerData extends Record<string, unknown> {
  kind: PipelineVersion['containers'][number]['kind'];
  status: string | null;
  tone: StatusTone | null;
  /** A container's own progress; `null` until it has started. */
  round: number | null;
}

/** What a node says when the run has no state for it. */
export const NO_STATUS_LABEL = 'not projected';

export function toneClass(prefix: string, tone: StatusTone | null): string {
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
  const activities: FlowNode[] = doc.nodes.map((n) => {
    const status = state?.nodes[n.id]?.status ?? null;
    return {
      id: n.id,
      type: 'runActivity',
      position: n.position,
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        title: activityLabel(n),
        status,
        tone: status === null ? null : nodeStatusTone(status),
      } satisfies RunNodeData,
      ariaLabel: `${activityLabel(n)}, ${status ?? NO_STATUS_LABEL}`,
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
        status,
        tone: status === null ? null : containerStatusTone(status),
        round: cs?.round ?? null,
      } satisfies RunContainerData,
      ariaRole: 'group',
      ariaLabel: `${containerAriaLabel(c.kind, rect.childCount)}, ${status ?? NO_STATUS_LABEL}`,
    };
  });

  // Containers first, so a box paints BEHIND the activities it encloses.
  return [...boxes, ...activities];
}

/**
 * The edges — the author canvas's vocabulary verbatim (hue class, label,
 * arrowhead def, aria label, the additive `edge-back` hook), with every
 * interaction affordance off.
 */
export function runFlowEdges(doc: RunDoc): FlowEdge[] {
  return doc.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: SOURCE_PORT_ID,
    targetHandle: TARGET_PORT_ID,
    label: edgeLabel(e),
    className: `${edgeVariantClass(e)}${e.back === true ? ' edge-back' : ''}`,
    markerEnd: edgeArrowMarkerId(e),
    ariaLabel: edgeAriaLabel(e),
    selectable: false,
    focusable: false,
  }));
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
 * and one whose status did change carries the measurement forward.
 */
export function mergeRunNodes(prev: FlowNode[], next: FlowNode[]): FlowNode[] {
  const before = new Map(prev.map((n) => [n.id, n]));
  return next.map((n) => {
    const old = before.get(n.id);
    if (old === undefined) return n;
    const a = old.data as RunNodeData;
    const b = n.data as RunNodeData;
    // Compared field-by-field rather than by a deep equal: these ARE the fields
    // the node renders, so a new one added here must be considered deliberately.
    const sameData = a.title === b.title && a.status === b.status && a.tone === b.tone;
    if (sameData && old.position.x === n.position.x && old.position.y === n.position.y) return old;
    // Changed — keep whatever React Flow measured, so the node does not fall
    // back to uninitialised and take its edges with it for a frame.
    return { ...n, measured: n.measured ?? old.measured, handles: n.handles ?? old.handles };
  });
}
