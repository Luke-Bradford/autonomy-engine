import { describe, expect, it } from 'vitest';
import { ContainerRunStatusSchema, type RunState } from '@autonomy-studio/shared';
import { encodeCondition, OPERATIONAL_CONDITIONS } from '../pipeline/ports';
import { containerStatusLabel, containerStatusTone } from './nodeStatus';
import { projectRun } from './runProjection';
import { mergeRunNodes, NO_STATUS_LABEL, runFlowEdges, runFlowNodes, type RunDoc } from './runFlow';

const DOC: RunDoc = {
  nodes: [
    { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
    { id: 'b', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
    { id: 'c', type: 'http_request', position: { x: 240, y: 160 }, config: {} },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', on: 'success' },
    // `c` is the FAILURE branch, so a successful `a` leaves it `skipped` — a
    // status no event carries, so only the doc-aware projection can report it.
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

/** Two containers of ONE kind — the case a bare kind cannot tell apart. */
const TWO_LOOP_DOC: RunDoc = {
  nodes: [
    { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
    { id: 'b', type: 'http_request', position: { x: 240, y: 0 }, config: {} },
    { id: 'c', type: 'http_request', position: { x: 0, y: 400 }, config: {} },
    { id: 'd', type: 'http_request', position: { x: 240, y: 400 }, config: {} },
  ],
  edges: [],
  containers: [
    { id: 'lp1', kind: 'loop', children: ['a', 'b'] },
    { id: 'lp2', kind: 'loop', children: ['c', 'd'] },
  ],
};

/** A projection of `DOC` in which `a` succeeded, so `b` is ready and `c` skipped. */
function projected(): RunState {
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
  const first = projectRun(DOC, [started]);
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
  const result = projectRun(DOC, log as never);
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

    // Neither `b` nor `c` has an event of its own, so the doc-free FOLD can
    // produce no row for either — and yet they are in DIFFERENT states, which is
    // exactly what the doc buys. (Since U25 the table shows them anyway, by
    // reconciling against this same projection.)
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

  /**
   * #878 — `DOC` is three `http_request` nodes, which is exactly the graph that
   * used to draw three boxes reading "HTTP Request". A monitor whose job is to
   * say WHICH node failed cannot name them identically, and the name it uses is
   * the one the authoring canvas draws.
   */
  it('names each activity distinctly, in the label and in the accessible name', () => {
    const nodes = runFlowNodes(DOC, null);
    expect(nodes.map((n) => n.data.title)).toEqual([
      'HTTP Request 1',
      'HTTP Request 2',
      'HTTP Request 3',
    ]);
    expect(nodes.map((n) => n.ariaLabel)).toEqual([
      `HTTP Request 1, ${NO_STATUS_LABEL}`,
      `HTTP Request 2, ${NO_STATUS_LABEL}`,
      `HTTP Request 3, ${NO_STATUS_LABEL}`,
    ]);
  });

  it('puts the status in the accessible name, so it is not conveyed by colour alone', () => {
    const nodes = runFlowNodes(DOC, projected());
    // The label is the activity's identifying name (the author canvas's own
    // rule, #878), not its id.
    expect(nodes.find((n) => n.id === 'a')!.ariaLabel).toBe('HTTP Request 1, success');
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
    /* U19 — one target port and one SOURCE port per outcome the box can route.
       A container declares no business branches, so that is the four operational
       outcomes. Stating the wrong SET is as fatal as stating none: React Flow
       resolves an edge's `sourceHandle` against exactly these, so an edge
       leaving this box on `failure` needs a `failure` handle here or it is drawn
       as nothing at all — silently, which is why it is asserted rather than
       eyeballed. */
    expect(nodes[0]!.handles?.filter((h) => h.type === 'target')).toHaveLength(1);
    expect(nodes[0]!.handles?.filter((h) => h.type === 'source').map((h) => h.id)).toEqual(
      OPERATIONAL_CONDITIONS.map((on) => encodeCondition({ on })),
    );

    // The box encloses both children.
    expect(nodes[0]!.position.x).toBeLessThan(0);
    expect(nodes[0]!.width!).toBeGreaterThan(240);
  });

  /**
   * U19 — the composition test, and the only one that catches the silent
   * failure directly.
   *
   * `toFlowEdge` names the port of the edge's OWN condition, and React Flow
   * draws an edge whose `sourceHandle` matches no handle as NOTHING: no error,
   * no warning, no console message (`ports.ts` records the mechanism). So the
   * edges and the ports are two halves of one contract that no other assertion
   * spans — each half is individually correct in every state where the picture
   * is empty.
   *
   * The fixture is deliberately the hostile one: a `switch` whose configured
   * cases NO LONGER include the branch an existing edge routes on, which is
   * reachable by editing `config.cases` in the node panel and by importing a doc
   * from git. That edge must still be drawable, from an orphan port.
   */
  it('gives every edge a source port that EXISTS on its source', () => {
    const doc: RunDoc = {
      nodes: [
        { id: 'sw', type: 'switch', config: { on: '${x}', cases: ['red'] }, position: { x: 0, y: 0 } },
        { id: 'b', type: 'http_request', config: {}, position: { x: 300, y: 0 } },
      ],
      edges: [
        { id: 'e1', from: 'sw', to: 'b', on: 'branch', branch: 'red' },
        { id: 'e2', from: 'sw', to: 'b', on: 'failure' },
        // The orphan: `blue` is not in `cases` any more.
        { id: 'e3', from: 'sw', to: 'b', on: 'branch', branch: 'blue' },
      ],
    } as unknown as RunDoc;

    const ports = new Map(
      runFlowNodes(doc, null).map((n) => [
        n.id,
        new Set(String((n.data as { portIds: string }).portIds).split(' ')),
      ]),
    );
    const edges = runFlowEdges(doc);
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(
        ports.get(e.source)?.has(e.sourceHandle!),
        `edge ${e.id} names port ${e.sourceHandle} — its source has none`,
      ).toBe(true);
    }
  });

  it('carries a container’s own status — WORDED — and its round', () => {
    const state: RunState = {
      ...projected(),
      containers: { stg: { status: 'active', round: 2, outputs: {} } },
    };
    const box = runFlowNodes(CONTAINER_DOC, state)[0]!;
    /* #873 — these four assertions INVERT what they pinned before, which is the
       point: this test was the only thing holding the raw identifier on screen.
       `active` is the container's `dispatched`, so the box now says the word the
       node and the run already said, and the engine's identifier reaches
       neither the label nor the accessible name. */
    expect(box.data.status).toBe('running');
    expect(box.data.status).not.toBe('active');
    expect(box.ariaLabel).toContain('running');
    expect(box.ariaLabel).not.toContain('active');
    expect(box.data.tone).toBe('running');
    expect(box.data.round).toBe(2);
  });

  /* #886 — the run graph names a container the way the AUTHOR canvas does.
     Before this, its box drew and announced the bare `kind`, so a pipeline
     authored as `loop 1` / `loop 2` ran as `loop` / `loop`: the two halves of
     one picture, disagreeing about which rectangle is which. The activities
     beside them have been named this way since #878. */
  it('names a container box by its ordinal, not by its bare kind', () => {
    const box = runFlowNodes(CONTAINER_DOC, projected())[0]!;
    expect(box.data.name).toBe('stage 1');
    expect(box.ariaLabel).toContain('stage 1 container');
  });

  it('tells two containers of ONE kind apart, in the box and in its accessible name', () => {
    const boxes = runFlowNodes(TWO_LOOP_DOC, null).filter((n) => n.type === 'runContainer');
    // The bare kind — what this drew before — is the same string for both, so
    // only the ordinal can carry the difference.
    expect(boxes.map((b) => b.data.name)).toEqual(['loop 1', 'loop 2']);
    expect(boxes.map((b) => b.ariaLabel)).toEqual([
      expect.stringContaining('loop 1 container'),
      expect.stringContaining('loop 2 container'),
    ]);
  });

  it('words a container status the same way the shared map does, and keeps the tone off the RAW status', () => {
    /* Guards the SEAM rather than one status: a projection that worded `active`
       by hand and passed the rest through would satisfy the test above.

       The tone is asserted HERE rather than beside the `active` case, because
       there it could not fail — `active`'s label is `running` and its tone is
       ALSO `running`, so a tone accidentally keyed off the LABEL would read
       identically.

       And the divergence is RARER than it looks: `success`, `failure` and
       `skipped` each word to their own tone too, so FOUR of the five coincide
       and `pending` (label `pending`, tone `neutral`) is the ONLY member that
       can catch a label-keyed tone. That is why the loop must walk every member
       rather than sample one — and it is asserted below rather than asserted
       here in prose, because the first draft of this comment claimed four
       members diverged and the assertion is what caught it.
       `palette.test.ts` enumerates `.run-container-<tone>`, so a tone built from
       the label would match no rule and fall through to unstyled. */
    for (const status of ContainerRunStatusSchema.options) {
      const state: RunState = {
        ...projected(),
        containers: { stg: { status, round: 0, outputs: {} } },
      };
      const box = runFlowNodes(CONTAINER_DOC, state)[0]!;
      expect(box.data.status).toBe(containerStatusLabel(status));
      expect(box.ariaLabel).toContain(containerStatusLabel(status));
      expect(box.data.tone).toBe(containerStatusTone(status));
    }
    /* The claim above, as an assertion rather than as prose a reader has to
       trust: `pending` is the ONLY member whose label and tone differ, so it
       alone can catch a tone keyed off the label. Should a future wording make a
       second member diverge this still passes; should it make `pending`
       COINCIDE, the loop above would quietly stop discriminating anything — and
       this goes red instead. */
    const diverge = ContainerRunStatusSchema.options.filter(
      (s) => containerStatusLabel(s) !== containerStatusTone(s),
    );
    expect(diverge).toContain('pending');
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

describe('mergeRunNodes', () => {
  /* Why this exists: React Flow rebuilds a node's internals for any user node
     that is not reference-identical to the previous one, and `parseHandles`
     leaves `handleBounds` undefined for a node stating neither `measured` nor
     `handles` — so `getEdgePosition` returns null and EVERY edge touching it
     renders as nothing until the next measurement. `projectRun` returns a fresh
     state per event, so without this merge that would be every edge blinking on
     every event of a live run. */

  it('returns the SAME OBJECT for a node whose rendered data is unchanged', () => {
    const first = runFlowNodes(DOC, null);
    const second = runFlowNodes(DOC, null);
    // A fresh build really is a different object — otherwise this test is vacuous.
    expect(second[0]).not.toBe(first[0]);

    const merged = mergeRunNodes(first, second);
    expect(merged[0]).toBe(first[0]);
    expect(merged.map((n) => n.id)).toEqual(first.map((n) => n.id));
  });

  it('replaces a node whose STATUS changed, carrying React Flow’s measurement forward', () => {
    // What RF holds after it has measured: the same objects, now with `measured`.
    const measured = runFlowNodes(DOC, null).map((n) => ({
      ...n,
      measured: { width: 150, height: 52 },
    }));
    const next = runFlowNodes(DOC, projected());

    const merged = mergeRunNodes(measured, next);
    const a = merged.find((n) => n.id === 'a')!;
    expect(a.data.status).toBe('success');
    // Not reference-identical (the status DID change) — but still initialised,
    // so its edges keep their endpoints.
    expect(a).not.toBe(measured.find((n) => n.id === 'a'));
    expect(a.measured).toEqual({ width: 150, height: 52 });
  });

  it('REBUILDS a looping container whose round advanced but whose status did not', () => {
    // The engine keeps a looping container `active` across re-rounds, so
    // `status` and `tone` are identical between folds and only `round` moves.
    // A merge that compared a NAMED list of fields matched this as unchanged and
    // froze the "· round N" label on screen for the whole loop.
    const active = (round: number) =>
      runFlowNodes(CONTAINER_DOC, {
        ...projected(),
        containers: { stg: { status: 'active', round, outputs: {} } },
      });

    const first = active(1).map((n) => ({ ...n, measured: { width: 10, height: 10 } }));
    const merged = mergeRunNodes(first, active(2));

    const box = merged.find((n) => n.id === 'stg')!;
    expect(box.data.round).toBe(2);
    expect(box).not.toBe(first.find((n) => n.id === 'stg'));
    // …and it is still initialised, so its edges keep their endpoints.
    expect(box.measured).toBeDefined();
  });

  it('keeps a node it has never seen before exactly as built', () => {
    const next = runFlowNodes(DOC, null);
    expect(mergeRunNodes([], next)).toEqual(next);
  });
});

describe('U25 — the graph words a status for an operator', () => {
  /**
   * The graph and the table must show the SAME word, and the only statuses that
   * can prove it are the ones whose label differs from their identifier. The
   * suite above happens to use `success`/`ready`/`skipped`, all of which word to
   * themselves — so every assertion in it holds whether or not `runFlowNodes`
   * words anything at all. Mutating `nodeStatusLabel(status)` back to a raw
   * `status` there is invisible.
   *
   * `dispatched` is the case that bites: the engine's word names the ENGINE's
   * act (it handed the node to a driver), and printing it would put a term from
   * the reducer's vocabulary in front of an operator asking what the node is
   * doing.
   */
  it('renders `dispatched` as "running", in the node data AND in its accessible name', () => {
    const state = projected();
    const dispatched = {
      ...state,
      nodes: { ...state.nodes, a: { status: 'dispatched' as const, attempts: 1, retries: 0 } },
    };
    const a = runFlowNodes(DOC, dispatched).find((n) => n.id === 'a')!;

    expect(a.data.status).toBe('running');
    expect(a.ariaLabel).toContain('running');
    // The identifier must not reach the screen by either route — a11y name
    // included, since that is what a screen-reader user gets INSTEAD of the
    // visible text rather than in addition to it.
    expect(a.data.status).not.toBe('dispatched');
    expect(a.ariaLabel).not.toContain('dispatched');
    // The TONE still comes off the raw status, so wording it must not have
    // changed which hue family the node is drawn in.
    expect(a.data.tone).toBe('running');
  });

  it('says which alarm a parked node is waiting on, rather than the bare word', () => {
    const state = projected();
    const parked = {
      ...state,
      nodes: { ...state.nodes, a: { status: 'wait_pending' as const, attempts: 1, retries: 0 } },
    };
    const a = runFlowNodes(DOC, parked).find((n) => n.id === 'a')!;

    expect(a.data.status).toBe('waiting (timer)');
    expect(a.ariaLabel).toContain('waiting (timer)');
  });
});

/**
 * #903 — the same renderer, pointed at a doc with NO RUN behind it (the version
 * history's read-only preview on the authoring page).
 *
 * "not projected" is run vocabulary: it says a run exists whose state has not
 * been folded yet. On a stored pipeline version there is no run to project, so
 * saying it would state a falsehood about a fact the view has no opinion on.
 */
describe('runFlowNodes — statusless', () => {
  it('says nothing at all about status, on activities and on container boxes alike', () => {
    const nodes = runFlowNodes(CONTAINER_DOC, null, { showStatus: false });

    for (const n of nodes) {
      expect(n.data.status).toBeNull();
      expect(n.data.tone).toBeNull();
      // The accessible name is where the status leaked on BOTH node types — the
      // box already dropped it from its drawn text but not from its aria-label.
      expect(n.ariaLabel).not.toContain(NO_STATUS_LABEL);
    }

    /* The flag itself is carried only by the ACTIVITY node, which is the only
       one that needs telling which absence it is rendering. Asserted on that
       type alone, so a `showStatus` added to the container data would be dead
       code this test failed to notice rather than dead code it pinned. */
    for (const n of nodes.filter((x) => x.type === 'runActivity')) {
      expect(n.data.showStatus).toBe(false);
    }
    for (const n of nodes.filter((x) => x.type === 'runContainer')) {
      expect(n.data).not.toHaveProperty('showStatus');
    }
  });

  it('still names each activity and each container box', () => {
    const nodes = runFlowNodes(CONTAINER_DOC, null, { showStatus: false });
    for (const n of nodes) expect(n.ariaLabel).toBeTruthy();
    const activity = nodes.find((n) => n.type === 'runActivity')!;
    expect(activity.ariaLabel).toBe(activity.data.title);
  });

  /* A run status is suppressed because the VIEW has no run — not because the
     state happens to be null. Passing a projected state with the flag off must
     still say nothing, or the flag would be a hint rather than a contract. */
  it('suppresses a status even when a run state IS supplied', () => {
    const nodes = runFlowNodes(DOC, projected(), { showStatus: false });
    expect(nodes.map((n) => n.data.status)).toEqual([null, null, null]);
    expect(nodes[0]!.ariaLabel).toBe('HTTP Request 1');
  });

  /* The regression the flag must not cause: every existing caller passes no
     options and must keep the run wording. */
  it('defaults to showing status, so the monitor is unchanged', () => {
    const nodes = runFlowNodes(DOC, null);
    for (const n of nodes) expect(n.data.showStatus).toBe(true);
    expect(nodes[0]!.ariaLabel).toContain(NO_STATUS_LABEL);
  });
});
