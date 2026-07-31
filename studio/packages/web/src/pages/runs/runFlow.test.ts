import { describe, expect, it } from 'vitest';
import type { RunState } from '@autonomy-studio/shared';
import { EMPTY_CARRY, engineForDoc, foldRunProjection } from './runProjection';
import { NO_STATUS_LABEL, runFlowEdges, runFlowNodes, type RunDoc } from './runFlow';

const DOC: RunDoc = {
  nodes: [
    { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
    { id: 'b', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
    { id: 'c', type: 'http_request', position: { x: 240, y: 160 }, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', on: 'success' },
    // `c` is the FAILURE branch, so a successful `a` leaves it `skipped` — a
    // status the event-driven table has no vocabulary for at all.
    { id: 'e2', from: 'a', to: 'c', on: 'failure' },
    { id: 'e3', from: 'b', to: 'a', on: 'failure', back: true, maxBounces: 3 },
  ],
  containers: [],
};

const CONTAINER_DOC: RunDoc = {
  nodes: [
    { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
    { id: 'b', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
  ],
  edges: [],
  containers: [{ id: 'stg', kind: 'stage', children: ['a', 'b'] }],
};

/** A projection of `DOC` in which `a` succeeded, so `b` is ready and `c` skipped. */
function projected(): RunState {
  const engine = engineForDoc(DOC);
  const base = {
    id: 'x',
    runId: 'run_1',
    ts: 1,
  };
  const started = {
    ...base,
    seq: 0,
    type: 'run.started',
    payload: { type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv_1', params: {} },
  };
  const first = foldRunProjection(engine, DOC, [started], EMPTY_CARRY).projection;
  if (!first.ok) throw new Error('fixture: run.started must project');
  const attemptId = first.state.nodes.a!.currentAttemptId!;

  const log = [
    started,
    {
      ...base,
      seq: 1,
      type: 'node.dispatched',
      payload: {
        type: 'node.dispatched',
        runId: 'run_1',
        nodeId: 'a',
        attemptId,
        idempotent: false,
      },
    },
    {
      ...base,
      seq: 2,
      type: 'node.succeeded',
      payload: {
        type: 'node.succeeded',
        runId: 'run_1',
        nodeId: 'a',
        attemptId,
        outputs: {},
      },
    },
  ];
  const result = foldRunProjection(engine, DOC, log as never, EMPTY_CARRY).projection;
  if (!result.ok) throw new Error('fixture: log must project');
  return result.state;
}

describe('runFlowNodes', () => {
  it('carries the engine status and its tone onto every node in the DOC', () => {
    const state = projected();
    const nodes = runFlowNodes(DOC, state);

    const a = nodes.find((n) => n.id === 'a')!;
    expect(a.data.status).toBe('success');
    expect(a.data.tone).toBe('success');

    // Neither `b` nor `c` has an event of its own, so the doc-free table can
    // produce no row for either — and yet they are in DIFFERENT states, which is
    // exactly what the doc buys. `skipped` is not even in the table's vocabulary.
    const b = nodes.find((n) => n.id === 'b')!;
    expect(b.data.status).toBe('ready');
    expect(b.data.tone).toBe('neutral');

    const c = nodes.find((n) => n.id === 'c')!;
    expect(c.data.status).toBe('skipped');
    expect(c.data.tone).toBe('skipped');
  });

  it('says "not projected" — NOT pending — when there is no run state', () => {
    // A different fact from "pending", and the distinction is the whole reason
    // the page withholds the overlay during replay.
    const nodes = runFlowNodes(DOC, null);
    expect(nodes.map((n) => n.data.status)).toEqual([null, null, null]);
    expect(nodes.map((n) => n.data.tone)).toEqual([null, null, null]);
    expect(nodes[0]!.ariaLabel).toContain(NO_STATUS_LABEL);
  });

  it('puts the status in the accessible name, so it is not conveyed by colour alone', () => {
    const nodes = runFlowNodes(DOC, projected());
    // The label is the activity's TITLE (the author canvas's own rule), not its id.
    expect(nodes.find((n) => n.id === 'a')!.ariaLabel).toBe('HTTP Request, success');
  });

  it('renders every node UNDRAGGABLE and UNSELECTABLE — this is a monitor', () => {
    for (const n of runFlowNodes(CONTAINER_DOC, null)) {
      expect(n.draggable).toBe(false);
      expect(n.selectable).toBe(false);
      expect(n.connectable).toBe(false);
    }
  });

  it('draws container boxes BEHIND their children, with stated geometry and handles', () => {
    const nodes = runFlowNodes(CONTAINER_DOC, null);

    // Containers first — React Flow paints in array order, so a box listed after
    // its children would cover them.
    expect(nodes[0]!.id).toBe('stg');
    expect(nodes[0]!.type).toBe('runContainer');

    // Stated, not measured: without BOTH, React Flow drops every edge touching
    // the box (the defect `e2e/container-rendering.spec.ts` pins on the author
    // canvas).
    expect(nodes[0]!.measured).toEqual({ width: nodes[0]!.width, height: nodes[0]!.height });
    expect(nodes[0]!.handles).toHaveLength(2);

    // The box encloses both children.
    expect(nodes[0]!.position.x).toBeLessThan(0);
    expect(nodes[0]!.width!).toBeGreaterThan(240);
  });

  it('carries a container’s own status and round', () => {
    const state: RunState = {
      ...projected(),
      containers: { stg: { status: 'active', round: 2, outputs: {} } },
    };
    const box = runFlowNodes(CONTAINER_DOC, state)[0]!;
    expect(box.data.status).toBe('active');
    expect(box.data.tone).toBe('running');
    expect(box.data.round).toBe(2);
    expect(box.ariaLabel).toContain('active');
  });
});

describe('runFlowEdges', () => {
  it('reuses the author canvas’s edge vocabulary verbatim', () => {
    const [success, , back] = runFlowEdges(DOC);

    expect(success!.className).toContain('edge-variant-success');
    expect(success!.markerEnd).toBeTruthy();
    expect(success!.ariaLabel).toBeTruthy();

    // U6e — `edge-back` is additive, on top of the condition's own hue class.
    expect(back!.className).toContain('edge-variant-failure');
    expect(back!.className).toContain('edge-back');
  });

  it('makes every edge unselectable and unfocusable', () => {
    for (const e of runFlowEdges(DOC)) {
      expect(e.selectable).toBe(false);
      expect(e.focusable).toBe(false);
    }
  });
});
