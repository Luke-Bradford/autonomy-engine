import { describe, expect, it } from 'vitest';
import {
  EdgeSchema,
  PipelineVersionSchema,
  type Container,
  type Node,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import {
  HISTORY_LIMIT,
  assignContainerChild,
  buildContainer,
  createCanvasStore,
  nextSelection,
  pruneContainerChild,
  sameSelection,
  containerExclusive,
  sameSelectionSet,
  singleSelection,
  type Selection,
} from './canvasStore';
import { canSave, toVersionBody, validateCanvas } from './canvasDoc';
import { DEFAULT_MAX_BOUNCES, type EdgeCondition } from './edgeCondition';

function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return PipelineVersionSchema.parse({
    id: 'plv_1',
    resourceId: 'res_plv1',
    pipelineId: 'pl_1',
    version: 1,
    params: [],
    outputs: [],
    nodes: [
      { id: 'n_a', type: 'http_request', config: {}, position: { x: 10, y: 20 } },
      { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 20 } },
    ],
    edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' }],
    containers: [],
    catalogVersion: 1,
    createdAt: 1,
    ...overrides,
  });
}

/**
 * `version()` with a source that DECLARES business branches.
 *
 * Needed since U19 slice 2: `rewireEdge` runs the full `connectRejection`, whose
 * `undeclared-condition` rule refuses a `branch:true` edge out of an
 * `http_request` — a tightening rather than a regression, because the property
 * panel never offered a branch on a source that cannot branch either. These
 * fixtures now say out loud what the authoring path always required.
 */
function branchingVersion(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return version({
    nodes: [
      { id: 'n_a', type: 'if', config: {}, position: { x: 10, y: 20 } },
      { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 20 } },
    ],
    ...overrides,
  });
}

/**
 * Retype an edge WITHOUT moving its endpoints — the case the retired
 * `Fires on` dropdown used to own, expressed through the one seam that now
 * writes an edge's shape.
 */
function retype(
  s: ReturnType<typeof createCanvasStore>,
  id: string,
  condition: EdgeCondition,
): void {
  const e = s.getState().edges.find((x) => x.id === id)!;
  s.getState().rewireEdge(id, { from: e.from, to: e.to, condition });
}

describe('canvasStore', () => {
  it('loadVersion(null) is the empty first-run state', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    const st = s.getState();
    expect(st.loaded).toBeNull();
    expect(st.nodes).toEqual([]);
    expect(st.edges).toEqual([]);
    expect(st.selected).toEqual([]);
    expect(st.dirty).toBe(false);
  });

  it('loadVersion(v) populates nodes/edges and is not dirty', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    const st = s.getState();
    expect(st.nodes).toHaveLength(2);
    expect(st.edges).toHaveLength(1);
    expect(st.dirty).toBe(false);
    // Loading a fresh version replaces the graph — the store owns its own copy.
    expect(st.nodes).not.toBe(version().nodes);
  });

  // #786 — a version minted BEFORE the endpoint-existence rule can carry an
  // edge naming nothing. React Flow silently drops such an edge, so the author
  // can neither see, select nor delete it; leaving it in the working graph would
  // mean a red badge and a dead Save with no affordance — the one-way trap #748
  // just closed, re-created by the very rule that closes the hole. Dropped on
  // load, exactly like the #526 `config.outputs` lowering in the same function.
  describe('loadVersion drops an unresolvable edge endpoint (#786)', () => {
    const dangling = () =>
      version({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
          { id: 'e_ghost', from: 'gone', to: 'n_b', on: 'success' },
          { id: 'e_ghost2', from: 'n_a', to: 'gone', on: 'failure' },
        ],
      });

    it('keeps the resolvable edges and drops the dangling ones', () => {
      const s = createCanvasStore();
      s.getState().loadVersion(dangling());
      expect(s.getState().edges.map((e) => e.id)).toEqual(['e_1']);
    });

    it('does NOT mark the canvas dirty — a display reconciliation, not an author edit', () => {
      const s = createCanvasStore();
      s.getState().loadVersion(dangling());
      expect(s.getState().dirty).toBe(false);
    });

    it('leaves `loaded` carrying the SERVER doc verbatim, as the record', () => {
      const s = createCanvasStore();
      s.getState().loadVersion(dangling());
      expect(s.getState().loaded?.edges).toHaveLength(3);
    });

    // The over-rejection guard: a CONTAINER is a legal edge endpoint, so the
    // resolvable set is nodes UNION containers. Resolving against node ids alone
    // would silently strip every container edge on load — and `toVersionBody`
    // takes `edges` from the working graph, so the next Save would mint the loss.
    it('keeps an edge whose endpoint is a CONTAINER, not a node', () => {
      const s = createCanvasStore();
      s.getState().loadVersion(
        version({
          containers: [{ id: 'stage_1', kind: 'stage', children: ['n_a'], join: 'all' }],
          edges: [{ id: 'e_c', from: 'stage_1', to: 'n_b', on: 'success' }],
        }),
      );
      expect(s.getState().edges.map((e) => e.id)).toEqual(['e_c']);
    });
  });

  it('rebaseLoaded repoints `loaded` but keeps the working graph and dirty flag', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version({ version: 1 }));
    s.getState().addNode('http_request'); // makes it dirty, 3 nodes
    const before = s.getState().nodes;
    const v2 = version({ id: 'plv_2', version: 2 });
    s.getState().rebaseLoaded(v2);
    const st = s.getState();
    expect(st.loaded).toBe(v2); // future carry-forward uses the new version
    expect(st.nodes).toBe(before); // working edits untouched
    expect(st.dirty).toBe(true); // still dirty — edits not yet persisted
  });

  it('addNode appends a node seeded from the catalog and marks dirty', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('http_request');
    const st = s.getState();
    expect(st.nodes).toHaveLength(1);
    expect(st.nodes[0]!.type).toBe('http_request');
    expect(st.nodes[0]!.id).toMatch(/^n_/);
    // config.outputs seeded from the catalog entry (status/body/headers).
    expect(st.nodes[0]!.config.outputs).toEqual([
      { name: 'status', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'headers', type: 'json' },
    ]);
    expect(st.dirty).toBe(true);
  });

  it('addNode twice yields two distinct ids', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('http_request');
    s.getState().addNode('http_request');
    const ids = s.getState().nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
  });

  it('addNode with an unknown catalog type is a no-op', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('not_a_real_activity');
    expect(s.getState().nodes).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
  });

  it('addNode ADDS a structural-call type with NO call blob and NO seeded outputs — #425', () => {
    // #425 made `execute_pipeline` authorable. The node is added WITHOUT a `call`
    // (there is no honest default target, and a blank one fails `CallConfigSchema`
    // outright instead of producing the doc validator's readable diagnostic), and
    // WITHOUT a seeded `config.outputs`: a call node's outputs come from the child
    // projection, so seeding the catalog's `[]` would flip the contract from
    // absent (store all child outputs) to declared-empty (store none) — and F13b
    // never overwrites a present value, so the flip would outlive the fix.
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('execute_pipeline');
    const node = s.getState().nodes[0]!;
    expect(node.type).toBe('execute_pipeline');
    expect(node.call).toBeUndefined();
    expect(node.config['outputs']).toBeUndefined();
    expect(s.getState().dirty).toBe(true);
  });

  it('updateNodeCall sets, clears and undoes a call blob — and refuses a non-call node', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('execute_pipeline');
    s.getState().addNode('http_request');
    const [callNode, httpNode] = s.getState().nodes as [Node, Node];

    s.getState().updateNodeCall(callNode.id, { pipelineVersionId: 'pv_1', params: { a: 1 } });
    expect(s.getState().nodes[0]!.call).toEqual({ pipelineVersionId: 'pv_1', params: { a: 1 } });

    // ONE gesture is ONE undo entry, and the undo restores the previous blob.
    s.getState().undo();
    expect(s.getState().nodes[0]!.call).toBeUndefined();
    s.getState().redo();
    expect(s.getState().nodes[0]!.call?.pipelineVersionId).toBe('pv_1');

    s.getState().updateNodeCall(callNode.id, undefined);
    expect(s.getState().nodes[0]!.call).toBeUndefined();
    expect('call' in s.getState().nodes[0]!).toBe(false);

    // A `call` on a non-call type is a field the reducer would act on while the
    // node's own catalog entry knows nothing about it — refused, not written.
    s.getState().updateNodeCall(httpNode.id, { pipelineVersionId: 'pv_1', params: {} });
    expect(s.getState().nodes[1]!.call).toBeUndefined();
    s.getState().updateNodeCall('n_missing', { pipelineVersionId: 'pv_1', params: {} });
  });

  // U5 — a node dropped from the toolbox lands where the pointer released it,
  // which the caller has already converted from screen to flow coordinates.
  it('addNode places the node at an explicitly-given position', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('http_request', { x: 412.5, y: -37 });
    expect(s.getState().nodes[0]!.position).toEqual({ x: 412.5, y: -37 });
    expect(s.getState().dirty).toBe(true);
  });

  it('a positioned add does not consume a STAGGER slot from the clicked adds', () => {
    // `addCount` exists so successive CLICKED adds don't stack at one point. A
    // drop places explicitly and stacks nothing, so counting it would shift the
    // next clicked add for no reason the user can see. Asserted on the resulting
    // POSITION, not on the counter: the counter is the mechanism, the position is
    // the behaviour, and a test on the mechanism would survive its removal.
    const staggered = createCanvasStore();
    staggered.getState().loadVersion(null);
    staggered.getState().addNode('http_request');
    staggered.getState().addNode('http_request');
    const secondClickAlone = staggered.getState().nodes[1]!.position;

    const interleaved = createCanvasStore();
    interleaved.getState().loadVersion(null);
    interleaved.getState().addNode('http_request');
    interleaved.getState().addNode('http_request', { x: 900, y: 900 }); // a drop
    interleaved.getState().addNode('http_request');
    expect(interleaved.getState().nodes[2]!.position).toEqual(secondClickAlone);
  });

  it('duplicateNode carries an authored call blob to the copy, unaliased', () => {
    // `duplicateNode` structuredClones the whole node rather than naming fields,
    // which is what stops it going stale as `NodeSchema` grows — `call` is one
    // of the fields riding on that. Asserted because a copy that silently lost
    // its target would look identical on the canvas.
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('execute_pipeline');
    const id = s.getState().nodes[0]!.id;
    s.getState().updateNodeCall(id, { pipelineVersionId: 'pv_1', params: { a: 1 } });
    s.getState().duplicateNode(id);

    const [source, copy] = s.getState().nodes as [Node, Node];
    expect(copy.call).toEqual(source.call);
    // A COPY, not an alias — editing one target must not edit the other.
    expect(copy.call).not.toBe(source.call);
    expect(copy.call!.params).not.toBe(source.call!.params);
  });

  it('addNode still refuses an UNKNOWN type WITH a position', () => {
    // The position argument is not a bypass: the drop path runs the same guards
    // as the click path, so a hand-crafted drag payload cannot author garbage.
    // (The structural-call arm of this guard retired with #425 — `execute_pipeline`
    // is authorable now, by click and by drop alike.)
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('not_a_real_activity', { x: 10, y: 10 });
    expect(s.getState().nodes).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
  });

  it('moveNode updates only the targeted node; an unknown id is a no-op', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().moveNodes([{ id: 'n_a', position: { x: 999, y: 888 } }]);
    expect(s.getState().nodes.find((n) => n.id === 'n_a')!.position).toEqual({ x: 999, y: 888 });
    expect(s.getState().nodes.find((n) => n.id === 'n_b')!.position).toEqual({ x: 100, y: 20 });
    const before = s.getState().nodes;
    s.getState().moveNodes([{ id: 'nope', position: { x: 1, y: 1 } }]);
    expect(s.getState().nodes).toBe(before); // untouched reference — no state churn
  });

  it('connect adds one edge and dedupes an identical (from,to,on)', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    // FORWARD of the loaded n_a -> n_b edge, on a different condition. The old
    // version of this spec connected n_b -> n_a, which closes a forward cycle —
    // refused as of U6b, so it would have tested the cycle rule by accident and
    // stopped covering the dedupe it is named for.
    s.getState().connect('n_a', 'n_b', { on: 'failure' });
    expect(s.getState().edges).toHaveLength(2);
    s.getState().connect('n_a', 'n_b', { on: 'failure' }); // duplicate
    expect(s.getState().edges).toHaveLength(2);
  });

  it('connect refuses a self-loop or an endpoint that is not a node', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().connect('n_a', 'n_a', { on: 'success' }); // self
    s.getState().connect('n_a', 'ghost', { on: 'success' }); // missing endpoint
    s.getState().connect('ghost', 'n_a', { on: 'success' });
    expect(s.getState().edges).toHaveLength(1); // only the loaded edge
  });

  /**
   * U6b — the forward-DAG rule now refuses the DRAW, not just the save.
   *
   * The store is the backstop for the canvas's `isValidConnection`; both call
   * `connectRejection`, so this spec and the connection gesture cannot diverge.
   */
  it('connect refuses an edge that would close a forward cycle', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version()); // n_a -> n_b
    s.getState().connect('n_b', 'n_a', { on: 'success' });
    expect(s.getState().edges).toHaveLength(1);
    expect(s.getState().dirty).toBe(false); // a refusal is not an edit
  });

  it('connect still allows a forward edge that only LOOKS like a loop (a -> b -> c, a -> c)', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().addNode('http_request', { x: 200, y: 200 });
    const third = s.getState().nodes.at(-1)!.id;
    s.getState().connect('n_b', third, { on: 'success' });
    s.getState().connect('n_a', third, { on: 'success' });
    expect(s.getState().edges).toHaveLength(3);
  });

  it('deleteNode removes the node, its incident edges, and clears a stale selection', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().select({ kind: 'node', id: 'n_a' });
    s.getState().deleteNode('n_a');
    const st = s.getState();
    expect(st.nodes.map((n) => n.id)).toEqual(['n_b']);
    expect(st.edges).toHaveLength(0); // e_1 (n_a→n_b) cascaded away
    expect(st.selected).toEqual([]);
    expect(st.dirty).toBe(true);
  });

  it('deleteEdge removes the edge and clears a selection pointing at it', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().select({ kind: 'edge', id: 'e_1' });
    s.getState().deleteEdge('e_1');
    expect(s.getState().edges).toHaveLength(0);
    expect(s.getState().selected).toEqual([]);
  });

  it('rewireEdge retypes and changes the `on` outcome of the targeted edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    retype(s, 'e_1', { on: 'completion' });
    expect(s.getState().edges[0]!.on).toBe('completion');
    expect(s.getState().dirty).toBe(true);
  });

  /**
   * The other direction of the same rewrite, authorable from the canvas as of
   * U6a: the `branch` key is REQUIRED on a business edge, so setting one must
   * add it rather than leave an `on:'branch'` edge that fails `EdgeSchema`.
   */
  it('rewireEdge retypes and sets the business `branch` key when retyping TO a branch', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(branchingVersion());
    retype(s, 'e_1', { on: 'branch', branch: 'true' });

    const edge = s.getState().edges[0]!;
    expect(edge).toMatchObject({ on: 'branch', branch: 'true' });
    expect(() => EdgeSchema.parse(edge)).not.toThrow();
  });

  it('rewireEdge retypes and rewrites the routing key when moving between branch arms', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      branchingVersion({
        edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' }],
      }),
    );
    retype(s, 'e_1', { on: 'branch', branch: 'false' });
    expect(s.getState().edges[0]).toMatchObject({ on: 'branch', branch: 'false' });
  });

  /**
   * `connect`'s dedupe is keyed on the CURRENT condition, so retyping walks
   * around it: connect A→B success, retype to skipped, connect A→B success
   * again, retype THAT to skipped → two byte-identical edges. Nothing
   * downstream refuses them (`validatePipelineDoc` has no duplicate-edge rule),
   * they share one `stableEdgeKey` bounce counter as back-edges, and they stack
   * as overlapping unclickable paths on the canvas.
   */
  it('rewireEdge retypes and REFUSES a retype that would duplicate another edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
          { id: 'e_2', from: 'n_a', to: 'n_b', on: 'failure' },
        ],
      }),
    );
    retype(s, 'e_2', { on: 'success' });

    expect(s.getState().edges.find((e) => e.id === 'e_2')!.on).toBe('failure'); // unchanged
    expect(s.getState().dirty).toBe(false);
  });

  /** The same guard on the business arm — two arms differ only by routing key. */
  it('rewireEdge retypes and REFUSES a retype onto an occupied branch arm', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' },
          { id: 'e_2', from: 'n_a', to: 'n_b', on: 'branch', branch: 'false' },
        ],
      }),
    );
    retype(s, 'e_2', { on: 'branch', branch: 'true' });
    expect(s.getState().edges.find((e) => e.id === 'e_2')).toMatchObject({ branch: 'false' });
  });

  /** ...but a no-op retype to the edge's OWN condition must not self-collide. */
  it('rewireEdge retypes and allows a retype to the edge’s own current condition', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    retype(s, 'e_1', { on: 'success' });
    expect(s.getState().edges[0]!.on).toBe('success');
  });

  /**
   * THE self-exclusion, stated as its own case because it is the whole reason
   * `rewireEdge` judges its candidate against the graph MINUS the edge in hand.
   *
   * Dropping an edge back exactly where it started produces a candidate that is
   * byte-identical to an edge that exists — itself. Judged against the full
   * graph the duplicate rule fires, and the operator's answer to "I changed my
   * mind" is a refusal naming the edge they are holding.
   *
   * What this case actually pins is the NO-OP GUARD — established by mutation:
   * remove the guard and `dirty` goes true, because the exclusion then lets the
   * unchanged candidate through to a real write. The exclusion itself is not
   * observable HERE (with the guard in place the store never reaches the rules),
   * so its discriminating proofs are the cycle case below and, for the visible
   * half, `e2e/edge-reconnect.spec.ts`'s "dropping an end back where it started
   * says nothing at all" — which is where a self-duplicate refusal would show.
   */
  it('rewireEdge does not refuse an edge for DUPLICATING ITSELF', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.setState({ dirty: false });
    s.getState().rewireEdge('e_1', { from: 'n_a', to: 'n_b', condition: { on: 'success' } });
    expect(s.getState().edges).toHaveLength(1);
    expect(s.getState().edges[0]).toMatchObject({ from: 'n_a', to: 'n_b', on: 'success' });
    // ...and, having changed nothing, it must not claim an edit either.
    expect(s.getState().dirty).toBe(false);
  });

  /**
   * The same exclusion in its other axis: an edge cannot be the cycle it is
   * being dragged OUT of. `a → b → c`, rewire `a → b`'s source onto `c`: the
   * result `c → a` closes no cycle once `a → b` is gone, but does while it is
   * still counted.
   */
  it('rewireEdge does not count the edge in hand when judging a cycle', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        nodes: [
          { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
          { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 0 } },
          { id: 'n_c', type: 'llm_call', config: {}, position: { x: 200, y: 0 } },
        ],
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
          { id: 'e_2', from: 'n_b', to: 'n_c', on: 'success' },
        ],
      }),
    );
    s.getState().rewireEdge('e_1', { from: 'n_c', to: 'n_a', condition: { on: 'success' } });
    expect(s.getState().edges.find((e) => e.id === 'e_1')).toMatchObject({
      from: 'n_c',
      to: 'n_a',
    });
  });

  it('rewireEdge MOVES an endpoint, keeping the edge’s identity', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        nodes: [
          { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
          { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 0 } },
          { id: 'n_c', type: 'llm_call', config: {}, position: { x: 200, y: 0 } },
        ],
      }),
    );
    s.getState().rewireEdge('e_1', { from: 'n_a', to: 'n_c', condition: { on: 'failure' } });
    // The id is what selection, the run log and undo all address the edge by —
    // which is the thing delete-and-redraw could not preserve.
    expect(s.getState().edges).toEqual([{ id: 'e_1', from: 'n_a', to: 'n_c', on: 'failure' }]);
  });

  /**
   * A back-edge stays judged by the three back-edge rules when it MOVES, not
   * just when it is retyped: `back` rides on the candidate, so rewiring one into
   * a position where it no longer runs backwards is refused rather than
   * persisting an edge whose `back: true` is a lie the save gate then catches.
   */
  it('rewireEdge judges a back-edge as a BACK-edge, and refuses a forward destination', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
    const id = s.getState().edges.find((e) => e.back === true)!.id;
    s.getState().rewireEdge(id, { from: 'n_a', to: 'n_b', condition: { on: 'failure' } });
    expect(s.getState().edges.find((e) => e.id === id)).toMatchObject({
      from: 'n_b',
      to: 'n_a',
      back: true,
    });
  });

  it('rewireEdge refuses to move an edge onto an endpoint that is not on the canvas', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.setState({ dirty: false });
    s.getState().rewireEdge('e_1', { from: 'n_a', to: 'ghost', condition: { on: 'success' } });
    expect(s.getState().edges[0]!.to).toBe('n_b');
    expect(s.getState().dirty).toBe(false);
  });

  /**
   * The tightening `rewireEdge` inherits by running the FULL connect rules,
   * which `updateEdgeCondition` never did: a source must declare the outcome an
   * edge routes on. An `http_request` has no branches, so `branch:true` out of
   * one was always unauthorable — the panel never offered it, and the reducer
   * would never fire it — but the store used to accept it from any other caller
   * and persist an edge that routes on a key nothing can produce.
   */
  it('rewireEdge refuses a condition the SOURCE does not declare', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version()); // n_a is an `http_request`
    s.setState({ dirty: false });
    s.getState().rewireEdge('e_1', {
      from: 'n_a',
      to: 'n_b',
      condition: { on: 'branch', branch: 'true' },
    });
    expect(s.getState().edges[0]!.on).toBe('success');
    expect(s.getState().dirty).toBe(false);
  });

  it('rewireEdge ignores an edge id it does not hold', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.setState({ dirty: false });
    s.getState().rewireEdge('nope', { from: 'n_a', to: 'n_b', condition: { on: 'failure' } });
    expect(s.getState().dirty).toBe(false);
  });

  /**
   * The collision guard must use the ENGINE's edge identity, which includes the
   * `branch` label. Both arms of one `if` may legitimately target one node (the
   * `stableEdgeKey` doc names an approval's "redo" arm alongside its forward
   * arm), and they share `(from, to, 'branch')` — so a key without the label
   * would refuse the second arm as a duplicate of the first.
   */
  it('rewireEdge retypes and ALLOWS a second branch arm between the same pair of nodes', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      branchingVersion({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' },
          { id: 'e_2', from: 'n_a', to: 'n_b', on: 'success' },
        ],
      }),
    );
    retype(s, 'e_2', { on: 'branch', branch: 'false' });
    expect(s.getState().edges.find((e) => e.id === 'e_2')).toMatchObject({
      on: 'branch',
      branch: 'false',
    });
  });

  // Retyping a BUSINESS branch edge to an operational outcome must drop the
  // `branch` routing key. A naive `{...e, on}` strands it on an edge that no
  // longer routes by it — a doc that then fails `EdgeSchema` (the union has no
  // operational member carrying `branch`). Reachable via a git-imported doc:
  // the canvas can't author a branch edge, but it can load and retype one.
  it('rewireEdge retypes and drops the business `branch` key when retyping a branch edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' }],
      }),
    );
    retype(s, 'e_1', { on: 'success' });

    const edge = s.getState().edges[0]!;
    expect(edge.on).toBe('success');
    expect(edge).not.toHaveProperty('branch');
    // The retyped edge must still be a VALID member of the union.
    expect(() => EdgeSchema.parse(edge)).not.toThrow();
  });

  // The same retype must preserve the shared `edgeBase` fields — dropping
  // `branch` must not drop the back-edge cap along with it.
  it('rewireEdge retypes and preserves back/maxBounces when retyping a branch back-edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          /* The forward edge the back-edge loops over. Since U19 slice 2 a rewire
             re-judges the edge's TOPOLOGY, and the `back-ancestry` rule wants the
             target to forward-reach the source — so a lone back-edge is a doc the
             rules refuse, which is a property of the fixture, not of the retype. */
          { id: 'e_0', from: 'n_a', to: 'n_b', on: 'success' },
          {
            id: 'e_1',
            from: 'n_b',
            to: 'n_a',
            on: 'branch',
            branch: 'retry',
            back: true,
            maxBounces: 3,
          },
        ],
      }),
    );
    retype(s, 'e_1', { on: 'failure' });

    const edge = s.getState().edges.find((e) => e.id === 'e_1')!;
    expect(edge).toMatchObject({ on: 'failure', back: true, maxBounces: 3 });
    expect(edge).not.toHaveProperty('branch');
  });

  it('updateNodeConfig replaces the config of the targeted node', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().updateNodeConfig('n_a', { url: 'https://x', outputs: [] });
    expect(s.getState().nodes.find((n) => n.id === 'n_a')!.config).toEqual({
      url: 'https://x',
      outputs: [],
    });
  });

  it('setNodeConnection binds and clears a connection', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().setNodeConnection('n_a', 'conn_1');
    expect(s.getState().nodes.find((n) => n.id === 'n_a')!.connectionId).toBe('conn_1');
    s.getState().setNodeConnection('n_a', undefined);
    expect(s.getState().nodes.find((n) => n.id === 'n_a')!.connectionId).toBeUndefined();
  });
});

describe('canvasStore — loadVersion lowers legacy node contracts (#526 / F13b)', () => {
  it('seeds config.outputs on a LEGACY node that persisted without one', () => {
    // A pre-F13b version is IMMUTABLE, so its absent contract can never be
    // repaired in place — the canvas has to show what the server WILL store on
    // the author's next save, not the empty contract the row happens to hold.
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    const [a] = s.getState().nodes;
    expect(a!.config['outputs']).toEqual([
      { name: 'status', type: 'number' },
      { name: 'body', type: 'string' },
      { name: 'headers', type: 'json' },
    ]);
  });

  it('DERIVES a structured llm_call contract rather than seeding the text-mode default', () => {
    // The reason the load path composes all four passes instead of calling
    // `lowerNodeOutputs` alone: alone, it would seed `[text, stopReason]` here.
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        nodes: [
          {
            id: 'n_s',
            type: 'llm_call',
            config: {
              prompt: 'p',
              outputMode: 'structured',
              outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
            },
            position: { x: 0, y: 0 },
          },
        ],
        edges: [],
      }),
    );
    expect(s.getState().nodes[0]!.config['outputs']).toEqual([{ name: 'verdict', type: 'string' }]);
  });

  // NOT tested here, deliberately: "an already-declared contract is left alone"
  // and "loading does not set `dirty`". Both pass with this whole change
  // REVERTED — the first is guaranteed one layer down by `lowerNodeOutputs`'s
  // never-overwrite rule (covered in `lower.test.ts`), and the second is already
  // asserted by "loadVersion(v) populates nodes/edges and is not dirty" above.
  // A test that cannot fail is not a test; it is a claim of coverage.

  it('leaves `loaded` UN-lowered — it is the server’s doc and the rebase basis', () => {
    const v = version();
    const s = createCanvasStore();
    s.getState().loadVersion(v);
    expect(s.getState().loaded).toBe(v);
    expect(v.nodes[0]!.config['outputs']).toBeUndefined();
  });

  it('still owns its own node objects (lowering returns unchanged nodes BY REFERENCE)', () => {
    // `lowerPipelineNodes` is copy-on-write: a node it does not change comes back
    // as the SAME object, so the store's own copy pass is still load-bearing.
    const v = version({
      nodes: [
        { id: 'n_a', type: 'http_request', config: { outputs: [] }, position: { x: 0, y: 0 } },
      ],
      edges: [],
    });
    const s = createCanvasStore();
    s.getState().loadVersion(v);
    expect(s.getState().nodes[0]).not.toBe(v.nodes[0]);
  });
});

/**
 * #737 — the selection model the canvas mirrors React Flow into.
 *
 * These are the unit half. The half a unit test CANNOT reach is that React Flow
 * emits the change at all: jsdom can focus an element but produces none of RF's
 * keyboard handling, and RF's controlled-mode change routing is exactly what the
 * defect turned on. `e2e/keyboard-selection.spec.ts` is the one that discriminates.
 */
describe('selection model (#737)', () => {
  const nodeA = { kind: 'node', id: 'n_a' } as const;
  const nodeB = { kind: 'node', id: 'n_b' } as const;
  const edge1 = { kind: 'edge', id: 'e_1' } as const;

  it('sameSelection compares by kind AND id, and null only equals null', () => {
    expect(sameSelection(nodeA, { kind: 'node', id: 'n_a' })).toBe(true);
    expect(sameSelection(nodeA, nodeB)).toBe(false);
    // A node and an edge can share an id in principle; the kind is what parts them.
    expect(sameSelection({ kind: 'node', id: 'x' }, { kind: 'edge', id: 'x' })).toBe(false);
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, nodeA)).toBe(false);
    expect(sameSelection(nodeA, null)).toBe(false);
  });

  // `nextSelection`'s own tests moved to "multi-selection (U21 #935)" when it
  // widened from a single slot to a SET — including the RF batch fold this block
  // used to own, which still lands on the clicked node and now does it without
  // the deselect guard a single slot needed.

  it('select is idempotent — re-selecting the same element does not write', () => {
    const s = createCanvasStore();
    s.getState().select({ kind: 'edge', id: 'e_1' });
    const before = s.getState();
    s.getState().select({ kind: 'edge', id: 'e_1' });
    // Object identity, not deep equality: an equal-but-new `selected` re-renders
    // the canvas, which re-derives the edge array, which makes React Flow report
    // the selection again. The value guard is what breaks that cycle.
    expect(s.getState()).toBe(before);
    expect(s.getState().selected).toBe(before.selected);
  });

  it('select(null) on an already-empty selection does not write either', () => {
    const s = createCanvasStore();
    const before = s.getState();
    s.getState().select(null);
    expect(s.getState()).toBe(before);
  });

  it('select still moves the selection when it genuinely changes', () => {
    const s = createCanvasStore();
    s.getState().select(nodeA);
    s.getState().select(edge1);
    expect(s.getState().selected).toEqual([edge1]);
    s.getState().select(null);
    expect(s.getState().selected).toEqual([]);
  });
});

/**
 * #746 — deleting an ENCLOSED activity used to leave its id listed in
 * `containers[].children`, and the doc became unsavable.
 *
 * The root cause was structural rather than a missing line: containers were not
 * in the store at all. They lived only on `loaded` and were carried forward
 * verbatim on save, so `deleteNode` had nothing to prune and the phantom
 * survived into the save body — where `validatePipelineDoc` refused it with
 * `child '<id>' is not a node in this pipeline`, a message naming a node the
 * operator had just deliberately removed. `canSave` gates on that, and container
 * membership was not authorable on the canvas at the time (U6d has since added
 * it), so the only way out was
 * to reload the page and lose every unsaved edit.
 *
 * These pin the fix at both levels: the prune itself, and the SYMPTOM (Save
 * comes back), because "the validator returns []" is not the thing the operator
 * reported.
 */
describe('canvasStore — container membership on delete (#746)', () => {
  /** The loaded version's `stage` encloses both seeded activities. */
  function enclosed(children: string[] = ['n_a', 'n_b']): PipelineVersion {
    return version({ containers: [{ id: 'c_1', kind: 'stage', children }] });
  }

  it('prunes the deleted id from the container that lists it', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(enclosed());
    s.getState().deleteNode('n_a');
    expect(s.getState().containers.map((c) => c.children)).toEqual([['n_b']]);
  });

  /**
   * THE REPRO, stated as the operator sees it: Save comes back.
   *
   * Asserted through `canSave`, not only through `validateCanvas`, because the
   * report in #746 is "the doc cannot be saved" — an issues array that happens
   * to be empty is the mechanism, and the button is the claim.
   */
  it('leaves a SAVABLE doc — the Save button re-enables', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(enclosed());
    s.getState().deleteNode('n_b');
    const st = s.getState();
    const issues = validateCanvas(st.nodes, st.edges, st.containers, st.loaded?.params ?? []);
    expect(issues).toEqual([]);
    expect(canSave({ saving: false, ready: true, issues })).toBe(true);
  });

  it('touches only the containers that list the id, keeping the rest by reference', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        containers: [
          { id: 'c_1', kind: 'stage', children: ['n_a'] },
          { id: 'c_2', kind: 'stage', children: ['n_b'] },
        ],
      }),
    );
    const before = s.getState().containers;
    s.getState().deleteNode('n_a');
    const after = s.getState().containers;
    expect(after.map((c) => c.children)).toEqual([[], ['n_b']]);
    // Untouched containers keep their identity. Pinned as the helper's stated
    // contract, NOT because a consumer depends on it — none does today, and an
    // earlier version of this comment claimed two that do not (a delete always
    // rebuilds `flowNodes`, so `FlowCanvas` re-derives its boxes either way).
    expect(after[1]).toBe(before[1]);
  });

  it('leaves the containers array itself by reference when nothing was pruned', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(enclosed(['n_b']));
    const before = s.getState().containers;
    s.getState().deleteNode('n_a');
    expect(s.getState().containers).toBe(before);
  });

  /**
   * The store owns its containers outright, `children` arrays included.
   *
   * The shallow `{...c}` a copy usually means is NOT enough here: it aliases
   * `c.children` into the SERVER's version object, which this store does not own.
   * The `not.toBe` on the children ARRAY is the assertion that discriminates a
   * shallow copy from a deep-enough one; a "loaded is untouched" check would pass
   * either way, because the prune is copy-on-write, so it is not made.
   */
  it('loadVersion copies the containers it seeds, children arrays included', () => {
    const s = createCanvasStore();
    const v = enclosed();
    s.getState().loadVersion(v);
    const st = s.getState();
    expect(st.containers).not.toBe(v.containers);
    expect(st.containers[0]).not.toBe(v.containers[0]);
    expect(st.containers[0]!.children).not.toBe(v.containers[0]!.children);
  });

  /**
   * Containers are WORKING state, not a view of `loaded`.
   *
   * The distinction is reachable: `rebaseLoaded` runs when the operator kept
   * editing during an in-flight save, so `loaded` becomes a server version minted
   * from the graph as it was BEFORE those edits. Deriving the boxes from `loaded`
   * would resurrect the phantom at exactly that moment — the one place the two
   * genuinely disagree.
   */
  it('rebaseLoaded does not resurrect a child the operator deleted mid-save', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(enclosed());
    s.getState().deleteNode('n_a');
    s.getState().rebaseLoaded(enclosed()); // the raced save wrote the OLD membership
    expect(s.getState().containers.map((c) => c.children)).toEqual([['n_b']]);
  });

  /**
   * A container that loses its LAST child is KEPT, not deleted with it.
   *
   * Deleting the container would be a structure write that also owns its incident
   * edges and its `exitWhen`/`items`/`maxRounds`/`timeout` config — none of it
   * re-authorable on the canvas until U23/#839 — so a cascade would destroy
   * authored structure the operator cannot get back, to save them one refused
   * save. An empty `stage` is a legal doc, so this case simply works.
   */
  it('keeps a stage that loses its last child, and the doc still saves', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(enclosed(['n_a']));
    s.getState().deleteNode('n_a');
    const st = s.getState();
    expect(st.containers.map((c) => c.children)).toEqual([[]]);
    expect(validateCanvas(st.nodes, st.edges, st.containers, [])).toEqual([]);
  });

  /**
   * Prunes ONE id, never "every child that is not a node" — the only property of
   * `pruneContainerChild` the store-level cases above do not already pin.
   *
   * A general normalise would silently repair legacy phantoms in a doc the
   * operator never touched, hiding a real defect report about a doc that arrived
   * broken (and turning `FlowCanvas`'s "announces the children it DRAWS" case
   * into a fixture that auto-heals).
   */
  it('leaves OTHER phantom children alone', () => {
    const stage: Container = { id: 'c_1', kind: 'stage', children: ['n_a', 'ghost'] };
    expect(pruneContainerChild([stage], 'n_a')[0]!.children).toEqual(['ghost']);
  });

  /**
   * The DOCUMENTED RESIDUE, pinned so the PR body's claim is not just a comment.
   *
   * An empty `loop` is refused — it re-rounds forever, resetting nothing — so
   * emptying one leaves the doc unsavable until the operator acts on the box
   * itself. That was #746's surviving trap; #748 ended it with `deleteContainer`
   * (covered by its own describe below), so this case now pins the STATE the
   * operator is in when they reach for that action, not a dead end.
   *
   * The refusal states the REAL problem ("a loop needs at least one child")
   * rather than naming a node that no longer exists — which is what makes the
   * next step obvious once there is a next step to take.
   */
  it('a loop emptied by a delete is refused for the RIGHT reason, not for a phantom', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        containers: [{ id: 'c_1', kind: 'loop', children: ['n_a'], exitWhen: '${equals(1, 1)}' }],
      }),
    );
    s.getState().deleteNode('n_a');
    const st = s.getState();
    const issues = validateCanvas(st.nodes, st.edges, st.containers, []);
    expect(issues.some((m) => m.includes('is not a node in this pipeline'))).toBe(false);
    expect(issues).toEqual([expect.stringContaining('makes no progress')]);
  });

  /**
   * The OTHER residue, and the one that is easy to claim away: a container's
   * `exitWhen`/`items` is scoped to its children, so deleting a node the
   * expression names leaves the doc unsavable on a REFERENCE error.
   *
   * Unchanged by this fix and deliberately so — repairing it means editing the
   * expression, which is container CONFIG authoring (U23/#839). Pinned here because the
   * PR body states it, and a stated residue nothing tests is just a confident
   * comment.
   */
  it('does NOT rescue a container whose exitWhen names the deleted child', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        containers: [
          {
            id: 'c_1',
            kind: 'loop',
            children: ['n_a', 'n_b'],
            exitWhen: '${equals(nodes.n_a.status, "success")}',
          },
        ],
      }),
    );
    s.getState().deleteNode('n_a');
    const st = s.getState();
    const issues = validateCanvas(st.nodes, st.edges, st.containers, []);
    expect(issues.some((m) => m.includes('is not a node in this pipeline'))).toBe(false);
    // The REFERENCE error the docstring names, not merely "some error" — an
    // `issues.length > 0` would have passed on any unrelated complaint.
    expect(issues).toEqual([expect.stringContaining('exitWhen')]);
  });
});

/**
 * #748 — deleting a CONTAINER, the affordance that ends the one-way trap.
 *
 * #746 made a container able to reach `children: []`, and then the canvas had
 * nothing that could act on one. That single gap surfaced as two failures:
 *
 *  - an emptied `loop`/`foreach` is REFUSED by `validatePipelineDoc` ("makes no
 *    progress"), `canSave` gates on it, so Save was dead and the only exit was a
 *    reload that discards every unsaved edit;
 *  - an emptied `stage` validates CLEAN, so it saved — into an immutable version,
 *    carried forward into every version after it, forever.
 *
 * `deleteNode` keeps the container deliberately (it owns edges and config no
 * other surface can re-author), and that choice is only defensible once the
 * operator can remove it themselves. This is that action.
 *
 * What it does NOT do is cascade the CHILDREN. They are real authored
 * activities; deleting the box they sit in un-groups them, it does not destroy
 * them. That is the whole reason the confirmation names what is lost (the
 * container's own config and its incident edges) and what is not.
 */
describe('canvasStore — deleteContainer (#748)', () => {
  /** A `stage` enclosing both seeded activities, wired in AND out. */
  function boxed(kind: 'stage' | 'loop' = 'stage', children: string[] = ['n_a', 'n_b']) {
    return version({
      nodes: [
        { id: 'n_a', type: 'http_request', config: {}, position: { x: 10, y: 20 } },
        { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 20 } },
        { id: 'after', type: 'http_request', config: {}, position: { x: 300, y: 20 } },
      ],
      edges: [
        { id: 'e_in', from: 'n_a', to: 'n_b', on: 'success' },
        { id: 'e_out', from: 'c_1', to: 'after', on: 'success' },
      ],
      containers: [
        kind === 'loop'
          ? { id: 'c_1', kind, children, exitWhen: '${equals(1, 1)}' }
          : { id: 'c_1', kind, children },
      ],
    });
  }

  it('removes the container', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed());
    s.getState().deleteContainer('c_1');
    expect(s.getState().containers).toEqual([]);
    expect(s.getState().dirty).toBe(true);
  });

  /**
   * The cascade, in BOTH directions.
   *
   * A container id is a legal edge endpoint — `from`/`to` are one string field
   * shared with nodes, and `connect` accepts a container — so an edge left
   * pointing at a deleted container is a DANGLING ref, exactly the class of
   * unsavable doc #746 was filed about. Matched the same way `deleteNode` does.
   */
  it('cascades the edges incident to it, whichever end it was', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          { id: 'e_src', from: 'c_1', to: 'n_b', on: 'success' },
          { id: 'e_dst', from: 'n_a', to: 'c_1', on: 'success' },
          { id: 'e_other', from: 'n_a', to: 'n_b', on: 'failure' },
        ],
        containers: [{ id: 'c_1', kind: 'stage', children: [] }],
      }),
    );
    s.getState().deleteContainer('c_1');
    expect(s.getState().edges.map((e) => e.id)).toEqual(['e_other']);
  });

  /**
   * The children SURVIVE — the property that makes this action safe to offer.
   *
   * They are un-grouped, not deleted: freed of the box they run at the top
   * level. A cascade here would make the confirmation a trap of its own, since
   * an activity's config is not recoverable either.
   */
  it('KEEPS the children as top-level activities', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed());
    s.getState().deleteContainer('c_1');
    expect(s.getState().nodes.map((n) => n.id)).toEqual(['n_a', 'n_b', 'after']);
    // ...and the edge BETWEEN two children is not incident to the container, so
    // the graph they form is intact too.
    expect(s.getState().edges.map((e) => e.id)).toEqual(['e_in']);
  });

  it('clears a selection naming an edge the cascade removed', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed());
    s.getState().select({ kind: 'edge', id: 'e_out' });
    s.getState().deleteContainer('c_1');
    expect(s.getState().selected).toEqual([]);
  });

  it('leaves a selection the delete did not touch', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed());
    s.getState().select({ kind: 'node', id: 'n_a' });
    s.getState().deleteContainer('c_1');
    expect(s.getState().selected).toEqual([{ kind: 'node', id: 'n_a' }]);
  });

  /**
   * An unknown id is a NO-OP, not a state write.
   *
   * Mirrors every other action's guard (`deleteNode`, `moveNode`, `deleteEdge`).
   * `dirty` is the assertion that matters: a store that marks itself dirty for a
   * call that changed nothing offers the operator a Save with nothing in it.
   */
  it('is a no-op for an id no container holds', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed());
    const before = s.getState().containers;
    s.getState().deleteContainer('n_a'); // a NODE id, not a container's
    s.getState().deleteContainer('nope');
    expect(s.getState().containers).toBe(before);
    expect(s.getState().dirty).toBe(false);
  });

  /**
   * SYMPTOM A, stated as the operator experiences it: Save comes back.
   *
   * Asserted through `canSave`, not only `validateCanvas`, because the report is
   * "the doc cannot be saved" — the empty issues array is the mechanism, the
   * button is the claim. This is the escape route that did not exist: emptying a
   * loop no longer strands every unsaved edit behind a reload.
   */
  it('an emptied loop can be deleted, and Save re-enables', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed('loop', ['n_a']));
    s.getState().deleteNode('n_a');
    const trapped = s.getState();
    expect(validateCanvas(trapped.nodes, trapped.edges, trapped.containers, [])).toEqual([
      expect.stringContaining('makes no progress'),
    ]);

    s.getState().deleteContainer('c_1');

    const st = s.getState();
    const issues = validateCanvas(st.nodes, st.edges, st.containers, []);
    expect(issues).toEqual([]);
    expect(canSave({ saving: false, ready: true, issues })).toBe(true);
  });

  /**
   * The COST of keeping the children, pinned rather than claimed away.
   *
   * `${item}` is scoped BY MEMBERSHIP — `validatePipelineDoc` binds `item` only
   * for nodes inside a `foreach` — so a freed child that referenced it now fails
   * validation and the doc stops saving. Deleting a populated `foreach` can
   * therefore leave the operator in the shape this ticket exists to end.
   *
   * Not fixed by cascading the children (that destroys authored activities, a
   * strictly worse trade) and not fixed by refusing the delete (that restores the
   * one-way trap). It is surfaced instead: the canvas warns for a `foreach`
   * before the confirm, and unlike the container's own config this IS
   * recoverable — the freed children are selectable and their config is editable
   * in `NodePanel`. Pinned here so the warning has something behind it, and so a
   * future change to `${item}` scoping fails a test rather than a user.
   */
  it("deleting a foreach strands its children's ${item}, and the doc stops saving", () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        nodes: [
          {
            id: 'n_a',
            type: 'http_request',
            config: { url: '${item}' },
            position: { x: 10, y: 20 },
          },
        ],
        edges: [],
        containers: [{ id: 'c_1', kind: 'foreach', children: ['n_a'], items: '${json("[1]")}' }],
      }),
    );
    expect(validateCanvas(s.getState().nodes, [], s.getState().containers, [])).toEqual([]);

    s.getState().deleteContainer('c_1');

    const st = s.getState();
    const issues = validateCanvas(st.nodes, st.edges, st.containers, []);
    // The activity itself SURVIVED — this is a scoping consequence, not a delete.
    expect(st.nodes.map((n) => n.id)).toEqual(['n_a']);
    expect(issues).toEqual([expect.stringContaining("'item' is only bound inside")]);
    expect(canSave({ saving: false, ready: true, issues })).toBe(false);
  });

  /**
   * SYMPTOM B: the empty `stage` that validated clean and so saved itself into
   * every future version. It is now removable before the save that would have
   * made it permanent.
   */
  it('an emptied stage can be removed before it is minted into a version', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(boxed('stage', ['n_a']));
    s.getState().deleteNode('n_a');
    expect(s.getState().containers.map((c) => c.children)).toEqual([[]]);
    s.getState().deleteContainer('c_1');
    expect(s.getState().containers).toEqual([]);
    const st = s.getState();
    expect(validateCanvas(st.nodes, st.edges, st.containers, [])).toEqual([]);
  });
});

/**
 * U6d — authoring container membership from the canvas.
 *
 * Until this ticket a container could only arrive with a loaded version: the
 * store could PRUNE membership (#746) and REMOVE a container (#748), but not
 * create one or move a node between them, so the only way to put a `loop` on
 * screen was to mint a version through the API.
 */
describe('canvasStore — container membership (U6d)', () => {
  const LOOP: Container = {
    id: 'loop_1',
    kind: 'loop',
    children: ['n_a'],
    exitWhen: '${equals(1, 1)}',
  };

  describe('assignContainerChild', () => {
    it('adds the node to the named container', () => {
      const out = assignContainerChild([{ id: 'c_1', kind: 'stage', children: [] }], 'n_a', 'c_1');
      expect(out[0]!.children).toEqual(['n_a']);
    });

    it('removes it from every other container in the SAME pass, so membership stays disjoint', () => {
      const out = assignContainerChild(
        [
          { id: 'c_1', kind: 'stage', children: ['n_a', 'n_b'] },
          { id: 'c_2', kind: 'stage', children: [] },
        ],
        'n_a',
        'c_2',
      );
      expect(out[0]!.children).toEqual(['n_b']);
      expect(out[1]!.children).toEqual(['n_a']);
    });

    it('un-groups the node when the target is null', () => {
      const out = assignContainerChild(
        [{ id: 'c_1', kind: 'stage', children: ['n_a'] }],
        'n_a',
        null,
      );
      expect(out[0]!.children).toEqual([]);
    });

    it('returns the SAME array when nothing changed, so a no-op edit sets no dirty flag', () => {
      const before: Container[] = [{ id: 'c_1', kind: 'stage', children: ['n_a'] }];
      expect(assignContainerChild(before, 'n_a', 'c_1')).toBe(before);
    });
  });

  describe('buildContainer', () => {
    it('builds a loop carrying its exit condition', () => {
      const out = buildContainer('loop', 'n_a', { exitWhen: '${equals(1, 1)}' });
      expect('container' in out).toBe(true);
      if (!('container' in out)) return;
      expect(out.container.kind).toBe('loop');
      expect(out.container.id.startsWith('loop_')).toBe(true);
      expect(out.container.children).toEqual(['n_a']);
      expect(out.container.exitWhen).toBe('${equals(1, 1)}');
    });

    it('omits an empty optional rather than authoring a blank string', () => {
      const out = buildContainer('stage', 'n_a', { exitWhen: '', items: '' });
      expect('container' in out).toBe(true);
      if (!('container' in out)) return;
      expect(out.container.exitWhen).toBeUndefined();
      expect(out.container.items).toBeUndefined();
    });

    it('builds a foreach carrying its items expression', () => {
      const out = buildContainer('foreach', 'n_a', { items: '${run.params.rows}' });
      expect('container' in out).toBe(true);
      if (!('container' in out)) return;
      expect(out.container.kind).toBe('foreach');
      expect(out.container.items).toBe('${run.params.rows}');
      expect(out.container.exitWhen).toBeUndefined();
    });

    /**
     * The gap the canvas's own validation cannot see. `validatePipelineDoc` runs
     * NO schema parse, and the server parses the body before reaching that gate,
     * so a non-positive or fractional `maxRounds` would clear every canvas check,
     * enable Save, and come back as a raw zod 400 with no badge naming the cause.
     */
    it('refuses a maxRounds ContainerSchema rejects, which no doc validation would catch', () => {
      for (const maxRounds of [0, -1, 1.5, Number.NaN]) {
        const out = buildContainer('loop', 'n_a', { exitWhen: '${true}', maxRounds });
        expect('error' in out).toBe(true);
      }
    });
  });

  describe('createContainer', () => {
    function loaded() {
      const s = createCanvasStore();
      s.getState().loadVersion(version());
      return s;
    }

    it('adds the container and marks the canvas dirty', () => {
      const s = loaded();
      s.getState().createContainer(LOOP);
      expect(s.getState().containers).toEqual([LOOP]);
      expect(s.getState().dirty).toBe(true);
    });

    it('takes the child out of the container that held it', () => {
      const s = loaded();
      s.getState().createContainer({ id: 'stage_1', kind: 'stage', children: ['n_a'] });
      s.getState().createContainer(LOOP);
      expect(s.getState().containers.map((c) => c.children)).toEqual([[], ['n_a']]);
    });

    it('refuses an id that collides with a NODE — the two share one namespace', () => {
      const s = loaded();
      s.getState().createContainer({ id: 'n_a', kind: 'stage', children: ['n_b'] });
      expect(s.getState().containers).toEqual([]);
      expect(s.getState().dirty).toBe(false);
    });

    it('refuses an id that collides with an existing container', () => {
      const s = loaded();
      s.getState().createContainer(LOOP);
      s.getState().createContainer({ ...LOOP, children: ['n_b'] });
      expect(s.getState().containers).toHaveLength(1);
    });

    it('refuses a child that is not a current node — a phantom authored fresh', () => {
      const s = loaded();
      s.getState().createContainer({ id: 'stage_1', kind: 'stage', children: ['n_ghost'] });
      expect(s.getState().containers).toEqual([]);
    });

    it('refuses a childless container, so a loop can never be born empty', () => {
      const s = loaded();
      s.getState().createContainer({ id: 'stage_1', kind: 'stage', children: [] });
      expect(s.getState().containers).toEqual([]);
    });

    it('refuses a container ContainerSchema rejects', () => {
      const s = loaded();
      s.getState().createContainer({ ...LOOP, maxRounds: 0 });
      expect(s.getState().containers).toEqual([]);
    });
  });

  describe('setNodeContainer', () => {
    function withLoop() {
      const s = createCanvasStore();
      s.getState().loadVersion(version({ containers: [LOOP] }));
      return s;
    }

    it('moves a node in', () => {
      const s = withLoop();
      s.getState().setNodeContainer('n_b', 'loop_1');
      expect(s.getState().containers[0]!.children).toEqual(['n_a', 'n_b']);
      expect(s.getState().dirty).toBe(true);
    });

    it('moves a node out', () => {
      const s = withLoop();
      s.getState().setNodeContainer('n_a', null);
      expect(s.getState().containers[0]!.children).toEqual([]);
      expect(s.getState().dirty).toBe(true);
    });

    it('is a no-op for a node that is not on the canvas', () => {
      const s = withLoop();
      s.getState().setNodeContainer('n_ghost', 'loop_1');
      expect(s.getState().containers[0]!.children).toEqual(['n_a']);
      expect(s.getState().dirty).toBe(false);
    });

    it('is a no-op for a container that does not exist', () => {
      const s = withLoop();
      s.getState().setNodeContainer('n_b', 'loop_missing');
      expect(s.getState().containers[0]!.children).toEqual(['n_a']);
      expect(s.getState().dirty).toBe(false);
    });

    it('does not mark the canvas dirty when the node is already there', () => {
      const s = withLoop();
      s.getState().setNodeContainer('n_a', 'loop_1');
      expect(s.getState().dirty).toBe(false);
    });

    /**
     * The edit is APPLIED, not refused, even though the doc is now unsavable —
     * see `containerRules`. Refusing it would make containerising an already
     * wired `a → b` impossible, and the same control reverses it.
     */
    it('applies an edit that leaves the doc invalid, and the badge reports it', () => {
      const s = withLoop();
      s.getState().setNodeContainer('n_b', 'loop_1');
      s.getState().setNodeContainer('n_a', null);
      const st = s.getState();
      const issues = validateCanvas(st.nodes, st.edges, st.containers, st.loaded?.params ?? []);
      expect(st.containers[0]!.children).toEqual(['n_b']);
      expect(issues.some((i) => i.includes('crosses a container boundary'))).toBe(true);
      expect(canSave({ saving: false, ready: true, issues })).toBe(false);
    });
  });

  describe('updateContainer (U23)', () => {
    function withLoop() {
      const s = createCanvasStore();
      s.getState().loadVersion(version({ containers: [LOOP] }));
      return s;
    }

    it('replaces the container and marks the canvas dirty', () => {
      const s = withLoop();
      s.getState().updateContainer('loop_1', { ...LOOP, exitWhen: '${equals(2, 2)}' });
      expect(s.getState().containers[0]!.exitWhen).toBe('${equals(2, 2)}');
      expect(s.getState().dirty).toBe(true);
    });

    it('no-ops on an unknown id', () => {
      const s = withLoop();
      const before = s.getState().containers;
      s.getState().updateContainer('nope', { ...LOOP, id: 'nope', exitWhen: '${equals(2, 2)}' });
      expect(s.getState().containers).toBe(before);
      expect(s.getState().dirty).toBe(false);
    });

    /**
     * Re-applying an identical container must not mark the canvas dirty —
     * `setNodeContainer`'s rule, for its reason: an unchanged graph that reports
     * itself as edited is how an unsaved-changes prompt loses the operator's
     * trust. Reachable by opening the panel and pressing Apply without typing.
     */
    it('does not dirty the canvas on an unchanged container', () => {
      const s = withLoop();
      s.getState().updateContainer('loop_1', { ...LOOP });
      expect(s.getState().dirty).toBe(false);
    });

    /**
     * The reviewer's case (PR #860): the comparison must not depend on key
     * ORDER. A container rebuilt with its keys in a different sequence is the
     * same container, and reporting it as an edit marks the canvas dirty on an
     * Apply that changed nothing.
     */
    it('treats a key-reordered container as unchanged', () => {
      const s = withLoop();
      const reordered = {
        exitWhen: LOOP.exitWhen,
        children: LOOP.children,
        kind: LOOP.kind,
        id: LOOP.id,
      } as Container;
      expect(Object.keys(reordered)).not.toEqual(Object.keys(LOOP));
      s.getState().updateContainer('loop_1', reordered);
      expect(s.getState().dirty).toBe(false);
    });

    /** …while a container differing only in a VALUE is still an edit. */
    it('still sees a change that only a value carries', () => {
      const s = withLoop();
      s.getState().updateContainer('loop_1', { ...LOOP, timeout: 30 });
      expect(s.getState().dirty).toBe(true);
    });

    /**
     * The non-vacuous half. `Container`'s TypeScript type is WIDER than
     * `ContainerSchema`'s runtime constraint — `maxRounds: number` admits 0 and
     * 1.5, which `.int().positive()` refuses — so `safeParse` on the INPUT is a
     * real check, unlike re-parsing the store's own output, which could never
     * fail. A refusal must leave the array byte-identical, not half-applied.
     */
    it.each([
      ['maxRounds: 0', { maxRounds: 0 }],
      ['maxRounds: 1.5', { maxRounds: 1.5 }],
      ['timeout: -1', { timeout: -1 }],
      ['batchCount: 51', { batchCount: 51 }],
    ])('refuses %s without half-applying it', (_label, patch) => {
      const s = withLoop();
      const before = s.getState().containers;
      s.getState().updateContainer('loop_1', { ...LOOP, ...patch } as Container);
      expect(s.getState().containers).toBe(before);
      expect(s.getState().dirty).toBe(false);
    });

    /**
     * `createContainer` stores `parsed.data`, which is safe for a container it
     * just built. An EDIT is different: `ContainerSchema` is a plain `z.object`,
     * so it STRIPS unknown keys, and storing the parse result would silently
     * drop whatever a git-imported or API-authored container carries that this
     * schema version does not know about. Validate the input, store the input.
     */
    it('keeps a key the schema does not know rather than stripping it', () => {
      const s = withLoop();
      const carried = { ...LOOP, exitWhen: '${equals(2, 2)}', futureField: 'keep me' };
      s.getState().updateContainer('loop_1', carried as Container);
      expect(s.getState().containers[0]).toEqual(carried);
    });

    /**
     * `id` and `children` are STRUCTURAL, owned by other affordances. A config
     * panel that could rewrite them would strand the id's other readers, or
     * author a membership the disjointness rules never saw — so both are
     * refused outright rather than merged.
     */
    it.each([
      ['a rename', { id: 'loop_renamed' }],
      ['a kind change', { kind: 'stage' }],
      ['a membership ADD', { children: ['n_a', 'n_b', 'n_c'] }],
      ['a membership REMOVAL', { children: ['n_a'] }],
      ['a membership EMPTYING', { children: [] }],
      ['a membership REORDER', { children: ['n_b', 'n_a'] }],
    ])('refuses %s — that is not a config edit', (_label, patch) => {
      const s = createCanvasStore();
      s.getState().loadVersion(version({ containers: [{ ...LOOP, children: ['n_a', 'n_b'] }] }));
      const before = s.getState().containers;
      s.getState().updateContainer('loop_1', {
        ...before[0]!,
        timeout: 30,
        ...patch,
      } as Container);
      expect(s.getState().containers).toBe(before);
    });

    it('leaves every other container untouched', () => {
      const s = createCanvasStore();
      const stage: Container = { id: 'stage_1', kind: 'stage', children: ['n_b'] };
      s.getState().loadVersion(version({ containers: [LOOP, stage] }));
      s.getState().updateContainer('loop_1', { ...LOOP, timeout: 30 });
      expect(s.getState().containers[1]).toEqual(stage);
    });
  });

  describe('a container selection (U23)', () => {
    function selected() {
      const s = createCanvasStore();
      s.getState().loadVersion(version({ containers: [LOOP] }));
      s.getState().select({ kind: 'container', id: 'loop_1' });
      return s;
    }

    /**
     * React Flow never sees a container (the change seam filters container ids
     * out), so it can never emit the deselect that clears every other kind.
     * Deleting the container therefore has to clear the selection itself, or
     * the panel is left editing a container that no longer exists.
     */
    it('is cleared when that container is deleted', () => {
      const s = selected();
      s.getState().deleteContainer('loop_1');
      expect(s.getState().selected).toEqual([]);
    });

    it('survives the deletion of a DIFFERENT container', () => {
      const s = createCanvasStore();
      s.getState().loadVersion(
        version({ containers: [LOOP, { id: 'stage_1', kind: 'stage', children: ['n_b'] }] }),
      );
      s.getState().select({ kind: 'container', id: 'loop_1' });
      s.getState().deleteContainer('stage_1');
      expect(s.getState().selected).toEqual([{ kind: 'container', id: 'loop_1' }]);
    });

    /**
     * `nextSelection` speaks for React Flow, which knows nothing about
     * containers. A node's deselect arriving while a container is selected must
     * not clear it — that batch is emitted for every element on every click.
     */
    it('is not cleared by a node deselect', () => {
      const s = selected();
      expect(nextSelection(s.getState().selected, { kind: 'node', id: 'n_a' }, false)).toEqual([
        { kind: 'container', id: 'loop_1' },
      ]);
    });
  });
});

describe('canvasStore — params/outputs as WORKING state (U16)', () => {
  it('seeds both from the loaded version', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        params: [{ name: 'topic', type: 'string', required: true }],
        outputs: [{ name: 'result', type: 'string' }],
      }),
    );
    expect(s.getState().params).toEqual([{ name: 'topic', type: 'string', required: true }]);
    expect(s.getState().outputs).toEqual([{ name: 'result', type: 'string' }]);
  });

  it('loadVersion(null) leaves both empty', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    expect(s.getState().params).toEqual([]);
    expect(s.getState().outputs).toEqual([]);
  });

  /**
   * The store must never write through into the SERVER's version object.
   *
   * A param's `default` is `z.unknown()`, so a `json` param's can nest
   * arbitrarily — which makes this a DEEPER copy than the containers seed needs
   * (`children` is a flat string array, so one level covers it). A `{ ...p }`
   * spread would leave `default` aliased and this test red.
   */
  it('deep-copies a nested default rather than aliasing the loaded version', () => {
    const s = createCanvasStore();
    const v = version({
      params: [{ name: 'cfg', type: 'json', required: false, default: { nested: { n: 1 } } }],
    });
    s.getState().loadVersion(v);

    const stored = s.getState().params[0]!.default as { nested: { n: number } };
    stored.nested.n = 99;

    const original = v.params[0]!.default as { nested: { n: number } };
    expect(original.nested.n).toBe(1);
  });

  it('addParam appends a uniquely-named optional row and marks the canvas dirty', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    expect(s.getState().dirty).toBe(false);

    s.getState().addParam();
    s.getState().addParam();

    const names = s.getState().params.map((p) => p.name);
    expect(new Set(names).size).toBe(2);
    expect(s.getState().dirty).toBe(true);
  });

  it('updateParam replaces the row AT THAT INDEX and leaves its siblings alone', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        params: [
          { name: 'a', type: 'string', required: false },
          { name: 'b', type: 'string', required: false },
        ],
      }),
    );
    s.getState().updateParam(1, { name: 'renamed', type: 'number', required: true });

    expect(s.getState().params.map((p) => p.name)).toEqual(['a', 'renamed']);
    expect(s.getState().params[1]!.type).toBe('number');
  });

  it('updateParam can REMOVE the default key, not merely blank it', () => {
    // `resolveRunParams` reads the default with `hasOwnProperty`, so
    // `default: undefined` means "the default is undefined" rather than "there
    // is no default". A whole-row replacement is what makes the key removable.
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({ params: [{ name: 'a', type: 'string', required: false, default: 'x' }] }),
    );
    s.getState().updateParam(0, { name: 'a', type: 'string', required: false });
    expect('default' in s.getState().params[0]!).toBe(false);
  });

  it('removeParam drops exactly one row', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        params: [
          { name: 'a', type: 'string', required: false },
          { name: 'b', type: 'string', required: false },
          { name: 'c', type: 'string', required: false },
        ],
      }),
    );
    s.getState().removeParam(1);
    expect(s.getState().params.map((p) => p.name)).toEqual(['a', 'c']);
  });

  it('outputs get the same add/update/remove treatment', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());

    s.getState().addOutput();
    expect(s.getState().outputs).toHaveLength(1);

    s.getState().updateOutput(0, { name: 'result', type: 'json', optional: true });
    expect(s.getState().outputs[0]!).toEqual({ name: 'result', type: 'json', optional: true });

    s.getState().removeOutput(0);
    expect(s.getState().outputs).toEqual([]);
  });

  it('every contract action marks the canvas dirty', () => {
    const acts: ((s: ReturnType<typeof createCanvasStore>) => void)[] = [
      (s) => s.getState().addParam(),
      (s) => s.getState().updateParam(0, { name: 'z', type: 'string', required: false }),
      (s) => s.getState().removeParam(0),
      (s) => s.getState().addOutput(),
      (s) => s.getState().updateOutput(0, { name: 'z', type: 'string' }),
      (s) => s.getState().removeOutput(0),
    ];
    for (const act of acts) {
      const s = createCanvasStore();
      s.getState().loadVersion(
        version({
          params: [{ name: 'a', type: 'string', required: false }],
          outputs: [{ name: 'o', type: 'string' }],
        }),
      );
      expect(s.getState().dirty).toBe(false);
      act(s);
      expect(s.getState().dirty).toBe(true);
    }
  });

  it('loadVersion RESETS working contract edits — a reload discards them', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().addParam();
    s.getState().addOutput();

    s.getState().loadVersion(version());
    expect(s.getState().params).toEqual([]);
    expect(s.getState().outputs).toEqual([]);
    expect(s.getState().dirty).toBe(false);
  });

  it('rebaseLoaded does NOT clobber contract edits made during an in-flight save', () => {
    // The counterpart of the save-race check in `PipelineCanvas`: a rebase
    // repoints `loaded` and must leave the working contract exactly as the
    // operator left it.
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().addParam();
    const edited = s.getState().params;

    s.getState().rebaseLoaded(version({ version: 2, params: [] }));
    expect(s.getState().params).toBe(edited);
  });
});

/**
 * U6e — authoring and editing a BACK-EDGE.
 *
 * The engine has implemented back-edges since P2c (`fireBackEdges`: bounce
 * counters, reset bodies, a `capped` failure) and the save gate has validated
 * them just as long, but nothing on the canvas could create one. These pin the
 * two halves that close that: `connect` authoring the back shape, and
 * `updateEdgeBounces` editing the cap afterwards.
 */
describe('canvasStore — back-edges (U6e)', () => {
  /** `n_a → n_b`, so `n_b →back n_a` is the ordinary retry loop. */
  function loaded() {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    return s;
  }

  it('connect authors the back shape, with a cap that keeps the doc SAVABLE', () => {
    const s = loaded();
    s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
    const authored = s.getState().edges.find((e) => e.from === 'n_b');
    expect(authored?.back).toBe(true);
    expect(authored?.maxBounces).toBe(DEFAULT_MAX_BOUNCES);
    // The whole point of the default: an edge that cannot be saved the instant
    // it is drawn is the #748/U16 trap, and a version is immutable.
    expect(EdgeSchema.safeParse(authored).success).toBe(true);
    const st = s.getState();
    expect(validateCanvas(st.nodes, st.edges, st.containers, st.params)).toEqual([]);
  });

  it('connect still REFUSES a back candidate the save gate would refuse', () => {
    const s = loaded();
    // The doc is `n_a -> n_b`, so a back-edge must run `n_b -> n_a`. The
    // reverse of that (`n_a -> n_b` with `back: true`) fails the ancestry rule:
    // `n_b` leads nowhere, so there is no loop for it to close.
    s.getState().connect('n_a', 'n_b', { on: 'failure' }, { back: true });
    expect(s.getState().edges.some((e) => e.back === true)).toBe(false);
  });

  it('a forward connect is unchanged — no stray back/maxBounces', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version({ edges: [] }));
    s.getState().connect('n_a', 'n_b', { on: 'success' });
    const authored = s.getState().edges[0];
    expect(authored).not.toHaveProperty('back');
    expect(authored).not.toHaveProperty('maxBounces');
  });

  describe('updateEdgeBounces', () => {
    function withBack() {
      const s = loaded();
      s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
      const id = s.getState().edges.find((e) => e.back === true)!.id;
      return { s, id };
    }

    it('sets the cap and marks the doc dirty', () => {
      const { s, id } = withBack();
      s.setState({ dirty: false });
      s.getState().updateEdgeBounces(id, 7);
      expect(s.getState().edges.find((e) => e.id === id)?.maxBounces).toBe(7);
      expect(s.getState().dirty).toBe(true);
    });

    /**
     * ZERO is allowed, deliberately. `EdgeSchema` types `maxBounces` as
     * `int().nonnegative()` and the save gate only requires it to be PRESENT,
     * so `0` is a savable value — an edge that never bounces. An editor
     * stricter than the format is the #748 trap in miniature: an imported doc
     * whose persisted value its own editor refuses to accept back.
     */
    it('accepts 0 — the format allows it, so the editor must not refuse it', () => {
      const { s, id } = withBack();
      s.getState().updateEdgeBounces(id, 0);
      expect(s.getState().edges.find((e) => e.id === id)?.maxBounces).toBe(0);
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'refuses %p, which EdgeSchema would reject',
      (bad) => {
        const { s, id } = withBack();
        s.getState().updateEdgeBounces(id, bad);
        expect(s.getState().edges.find((e) => e.id === id)?.maxBounces).toBe(DEFAULT_MAX_BOUNCES);
      },
    );

    it('refuses an edge that is not a back-edge, and an unknown id', () => {
      const { s } = withBack();
      s.getState().updateEdgeBounces('e_1', 4);
      expect(s.getState().edges.find((e) => e.id === 'e_1')).not.toHaveProperty('maxBounces');
      s.setState({ dirty: false });
      s.getState().updateEdgeBounces('nope', 4);
      expect(s.getState().dirty).toBe(false);
    });
  });

  /**
   * A retype must not drop back-ness. `retypeEdge` destructures `on`/`branch`
   * and rest-spreads the remainder, which is exactly the shape that has
   * silently dropped a field three times before — and the panel now exposes the
   * condition picker and the cap on the SAME edge, so the two controls meet.
   */
  it('retyping a back-edge keeps its back-ness and its cap', () => {
    const s = loaded();
    s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
    const id = s.getState().edges.find((e) => e.back === true)!.id;
    retype(s, id, { on: 'skipped' });
    const retyped = s.getState().edges.find((e) => e.id === id);
    expect(retyped).toMatchObject({ on: 'skipped', back: true, maxBounces: DEFAULT_MAX_BOUNCES });
  });

  /**
   * `updateEdgeBounces` re-committing the SAME cap must not dirty the doc.
   * Reachable through the panel, whose only no-op guard is a STRING compare:
   * `10.0` / ` 10` / `+10` over a stored `10` all arrive here numerically equal.
   */
  it('does not dirty the doc when the cap is re-committed unchanged', () => {
    const s = loaded();
    s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
    const id = s.getState().edges.find((e) => e.back === true)!.id;
    s.setState({ dirty: false });
    s.getState().updateEdgeBounces(id, DEFAULT_MAX_BOUNCES);
    expect(s.getState().dirty).toBe(false);
  });

  /**
   * The offer's gate answers about the EDGE's topology, NOT about whether the
   * doc will save. The first `back: true` edge flips `canReRunNodes`, disabling
   * `settled`, so an unrelated `${nodes.x.status}` ref newly fails
   * `validateRefs`. Pinned so the limitation is a documented, tested fact
   * rather than a latent surprise — and so a future change that DID make the
   * gate doc-wide has to come here and say so.
   */
  it('authoring a back-edge can invalidate an unrelated ${nodes.x.status} ref', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        nodes: [
          { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
          {
            id: 'n_b',
            type: 'llm_call',
            config: { note: '${nodes.n_a.status}' },
            position: { x: 100, y: 0 },
          },
        ],
      }),
    );
    const before = s.getState();
    expect(validateCanvas(before.nodes, before.edges, before.containers, before.params)).toEqual(
      [],
    );

    s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
    const after = s.getState();
    // The edge IS authored — the offer is not refused for this...
    expect(after.edges.some((e) => e.back === true)).toBe(true);
    // ...and the canvas badge is what says the doc no longer validates.
    const issues = validateCanvas(after.nodes, after.edges, after.containers, after.params);
    expect(issues.join('\n')).toContain('is not settled here');
    // Reversible by the same control, which is why it warns instead of refusing.
    s.getState().deleteEdge(after.edges.find((e) => e.back === true)!.id);
    const repaired = s.getState();
    expect(
      validateCanvas(repaired.nodes, repaired.edges, repaired.containers, repaired.params),
    ).toEqual([]);
  });

  /**
   * The persistence guard. `back`/`maxBounces` live on `edgeBase`, outside the
   * `on`/`branch` discriminant, which is exactly the shape that has been
   * silently dropped three times before (#746 `containers`, U16's `params`, and
   * `toVersionBody` reading `loaded`). Cheap insurance against a fourth.
   */
  it('a back-edge round-trips into the version body', () => {
    const s = loaded();
    s.getState().connect('n_b', 'n_a', { on: 'success' }, { back: true });
    const st = s.getState();
    const body = toVersionBody(
      st.nodes,
      st.edges,
      st.containers,
      st.params,
      st.outputs,
      st.loaded?.id ?? null,
    );
    const persisted = body.edges.find((e) => e.from === 'n_b');
    expect(persisted).toMatchObject({ back: true, maxBounces: DEFAULT_MAX_BOUNCES });
  });
});

describe('canvasStore — undo/redo (U17)', () => {
  /** A store opened on `version()`: two nodes, one edge, clean. */
  function opened() {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    return s;
  }

  it('undo reverses an add, redo re-applies it', () => {
    const s = opened();
    s.getState().addNode('http_request');
    expect(s.getState().nodes).toHaveLength(3);

    s.getState().undo();
    expect(s.getState().nodes).toHaveLength(2);

    s.getState().redo();
    expect(s.getState().nodes).toHaveLength(3);
  });

  it('undo reverses a delete, restoring the node AND its cascaded edges', () => {
    const s = opened();
    s.getState().deleteNode('n_a');
    expect(s.getState().nodes).toHaveLength(1);
    expect(s.getState().edges).toHaveLength(0);

    s.getState().undo();
    expect(s.getState().nodes.map((n) => n.id)).toEqual(['n_a', 'n_b']);
    expect(s.getState().edges.map((e) => e.id)).toEqual(['e_1']);
  });

  it('undo reverses a move — the position the node had before the drag', () => {
    const s = opened();
    s.getState().moveNodes([{ id: 'n_a', position: { x: 500, y: 600 } }]);
    s.getState().undo();
    expect(s.getState().nodes.find((n) => n.id === 'n_a')?.position).toEqual({ x: 10, y: 20 });
  });

  it('undo reverses a container edit, and its membership write', () => {
    const s = opened();
    const box: Container = { id: 'stage_1', kind: 'stage', children: ['n_a'] };
    s.getState().createContainer(box);
    expect(s.getState().containers).toHaveLength(1);

    s.getState().setNodeContainer('n_b', box.id);
    expect(s.getState().containers[0]!.children).toEqual(['n_a', 'n_b']);

    s.getState().undo();
    expect(s.getState().containers[0]!.children).toEqual(['n_a']);

    s.getState().undo();
    expect(s.getState().containers).toEqual([]);
  });

  it('undo reverses params and outputs', () => {
    const s = opened();
    s.getState().addParam();
    s.getState().addOutput();
    expect(s.getState().params).toHaveLength(1);
    expect(s.getState().outputs).toHaveLength(1);

    s.getState().undo();
    expect(s.getState().outputs).toEqual([]);
    expect(s.getState().params).toHaveLength(1);

    s.getState().undo();
    expect(s.getState().params).toEqual([]);
  });

  it('an undo that reaches the load point reports the canvas CLEAN again', () => {
    const s = opened();
    s.getState().addNode('http_request');
    expect(s.getState().dirty).toBe(true);

    s.getState().undo();
    expect(s.getState().dirty).toBe(false);

    s.getState().redo();
    expect(s.getState().dirty).toBe(true);
  });

  it('a REFUSED action records no history — undo reaches past it to the last real edit', () => {
    const s = opened();
    s.getState().addNode('http_request');
    const afterAdd = s.getState().nodes.length;

    // Refused: a self-loop is not a connectable candidate.
    s.getState().connect('n_a', 'n_a', { on: 'success' });
    // Refused: an index no param row holds.
    s.getState().removeParam(7);
    expect(s.getState().nodes).toHaveLength(afterAdd);

    // One undo, not three — the two refusals consumed no slot.
    s.getState().undo();
    expect(s.getState().nodes).toHaveLength(2);
    expect(s.getState().past).toHaveLength(0);
  });

  it('a move that lands back on its own origin consumes no undo slot', () => {
    const s = opened();
    s.getState().moveNodes([{ id: 'n_a', position: { x: 10, y: 20 } }]);
    expect(s.getState().past).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
  });

  it('a burst of edits to ONE param row coalesces into a single undo', () => {
    const s = opened();
    s.getState().addParam();
    const row = s.getState().params[0]!;
    // What typing a name into the param row actually does — one write per key.
    for (const name of ['c', 'cu', 'cus', 'cust']) {
      s.getState().updateParam(0, { ...row, name });
    }
    expect(s.getState().params[0]!.name).toBe('cust');

    s.getState().undo();
    // Back to the blank row the add minted, NOT to 'cus'.
    expect(s.getState().params[0]!.name).toBe(row.name);
  });

  it('coalescing is per ROW — editing a second param starts a new undo entry', () => {
    const s = opened();
    s.getState().addParam();
    s.getState().addParam();
    const first = s.getState().params[0]!;
    const second = s.getState().params[1]!;
    s.getState().updateParam(0, { ...first, name: 'aa' });
    s.getState().updateParam(1, { ...second, name: 'bb' });

    s.getState().undo();
    expect(s.getState().params[1]!.name).not.toBe('bb');
    expect(s.getState().params[0]!.name).toBe('aa');
  });

  it('coalescing is per FIELD — a second control on the same row is its own step', () => {
    const s = opened();
    s.getState().addParam();
    const row = s.getState().params[0]!;
    s.getState().updateParam(0, { ...row, name: 'customer' });
    // A different control on the SAME row. Folding this into the typing burst
    // would make one undo revert two deliberate acts.
    s.getState().updateParam(0, { ...s.getState().params[0]!, required: true });

    s.getState().undo();
    expect(s.getState().params[0]!.required).not.toBe(true);
    expect(s.getState().params[0]!.name).toBe('customer');
  });

  it('undo of a container DELETE brings back its config and its cascaded edges', () => {
    const s = opened();
    s.getState().createContainer({
      id: 'c_1',
      kind: 'loop',
      children: ['n_a'],
      exitWhen: '${equals(1, 1)}',
      maxRounds: 4,
    });
    s.getState().connect('c_1', 'n_b', { on: 'success' });
    const edgesBefore = s.getState().edges.length;

    s.getState().deleteContainer('c_1');
    expect(s.getState().containers).toEqual([]);
    expect(s.getState().edges.length).toBeLessThan(edgesBefore);

    // The docs claim "one undo brings the box, its config and its cascaded
    // edges back" — all three, not just the box.
    s.getState().undo();
    expect(s.getState().containers[0]).toMatchObject({
      id: 'c_1',
      kind: 'loop',
      exitWhen: '${equals(1, 1)}',
      maxRounds: 4,
    });
    expect(s.getState().edges).toHaveLength(edgesBefore);
  });

  it('selecting is not an edit — it records no history and does not break a burst', () => {
    const s = opened();
    s.getState().addParam();
    const row = s.getState().params[0]!;
    s.getState().updateParam(0, { ...row, name: 'aa' });
    const depth = s.getState().past.length;

    s.getState().select({ kind: 'node', id: 'n_a' });
    expect(s.getState().past).toHaveLength(depth);
    expect(s.getState().dirty).toBe(true); // unchanged by the selection

    // And it did not fork the history: undo still reaches the pre-burst row.
    s.getState().undo();
    expect(s.getState().params[0]!.name).toBe(row.name);
  });

  it('a new edit clears the redo stack', () => {
    const s = opened();
    s.getState().addNode('http_request');
    s.getState().undo();
    expect(s.getState().future).toHaveLength(1);

    s.getState().addNode('llm_call');
    expect(s.getState().future).toHaveLength(0);
    s.getState().redo();
    expect(s.getState().nodes).toHaveLength(3);
  });

  it('undo and redo on an empty stack are no-ops', () => {
    const s = opened();
    const before = s.getState().nodes;
    s.getState().undo();
    s.getState().redo();
    expect(s.getState().nodes).toBe(before);
    expect(s.getState().dirty).toBe(false);
  });

  it('loadVersion clears both stacks — a different document is not undoable', () => {
    const s = opened();
    s.getState().addNode('http_request');
    s.getState().undo();
    expect(s.getState().past).toHaveLength(0);
    expect(s.getState().future).toHaveLength(1);

    s.getState().loadVersion(version({ id: 'plv_2', version: 2 }));
    expect(s.getState().past).toEqual([]);
    expect(s.getState().future).toEqual([]);
  });

  it('the history is bounded — the oldest entry is dropped, never the newest', () => {
    const s = opened();
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      s.getState().moveNodes([{ id: 'n_a', position: { x: i + 1, y: 0 } }]);
    }
    expect(s.getState().past).toHaveLength(HISTORY_LIMIT);

    s.getState().undo();
    // The NEWEST entry survived: undo steps back exactly one move.
    expect(s.getState().nodes.find((n) => n.id === 'n_a')?.position).toEqual({
      x: HISTORY_LIMIT + 9,
      y: 0,
    });
  });

  it('an undo that removes the selected node clears the selection', () => {
    const s = opened();
    s.getState().addNode('http_request');
    const added = s.getState().nodes[2]!;
    s.getState().select({ kind: 'node', id: added.id });

    s.getState().undo();
    expect(s.getState().selected).toEqual([]);
  });

  it('an undo that leaves the selected node alone keeps the selection', () => {
    const s = opened();
    s.getState().select({ kind: 'node', id: 'n_b' });
    s.getState().moveNodes([{ id: 'n_a', position: { x: 500, y: 600 } }]);

    s.getState().undo();
    expect(s.getState().selected).toEqual([{ kind: 'node', id: 'n_b' }]);
  });

  it('an undo across a rebase reports DIRTY, because the basis moved under it', () => {
    const s = opened();
    s.getState().addNode('http_request');
    // What a save does when the operator kept editing during the request.
    s.getState().rebaseLoaded(version({ id: 'plv_2', version: 2 }));

    s.getState().undo();
    // The snapshot recorded `dirty: false` against plv_1 — but `loaded` is plv_2
    // now, so the restored graph is NOT what the server holds.
    expect(s.getState().dirty).toBe(true);
  });

  it('a snapshot shares structure with the live state rather than cloning it', () => {
    const s = opened();
    const nodesBefore = s.getState().nodes;
    s.getState().addParam();
    // The params edit did not touch `nodes`, and the snapshot holds the SAME
    // array — `docUnchanged`'s reference-equality save-race check depends on a
    // store action being the only thing that mints a fresh array.
    expect(s.getState().past[0]!.nodes).toBe(nodesBefore);
    expect(s.getState().nodes).toBe(nodesBefore);
  });
});

describe('canvasStore — duplicateNode (U21)', () => {
  /** `n_b` (the llm_call) reads `n_a`'s output, and `n_a → n_b` carries it. */
  function loaded(overrides: Partial<PipelineVersion> = {}) {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        nodes: [
          { id: 'n_a', type: 'http_request', config: {}, position: { x: 10, y: 20 } },
          {
            id: 'n_b',
            type: 'llm_call',
            config: { prompt: 'summarise ${nodes.n_a.output.body}', outputs: [] },
            connectionId: 'cn_1',
            position: { x: 100, y: 20 },
          },
        ],
        ...overrides,
      }),
    );
    return s;
  }

  it('appends a copy carrying the source type, config and bound connection', () => {
    const s = loaded();
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    expect(st.nodes).toHaveLength(3);
    const copy = st.nodes[2]!;
    expect(copy.id).not.toBe('n_b');
    expect(copy.type).toBe('llm_call');
    expect(copy.config).toEqual({ prompt: 'summarise ${nodes.n_a.output.body}', outputs: [] });
    expect(copy.connectionId).toBe('cn_1');
    expect(st.dirty).toBe(true);
  });

  it('shares no substructure with the source — editing one config cannot edit the other', () => {
    const s = loaded();
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const source = st.nodes.find((n) => n.id === 'n_b')!;
    const copy = st.nodes[2]!;
    expect(copy.config).not.toBe(source.config);
    // `config.outputs` is the array `assembleConfig` preserves BY REFERENCE, so
    // it is the substructure a shallow copy would have shared.
    expect(copy.config['outputs']).not.toBe(source.config['outputs']);
  });

  it('copies the IN-edges, so the copy keeps the upstream its ${} refs name', () => {
    const s = loaded();
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const copyId = st.nodes[2]!.id;
    const into = st.edges.filter((e) => e.to === copyId);
    expect(into).toHaveLength(1);
    expect(into[0]!.from).toBe('n_a');
    expect(into[0]!.on).toBe('success');
    // A fresh edge id — reusing the source edge's would collide.
    expect(into[0]!.id).not.toBe('e_1');
    // And the doc the copy lands in is one the SAVE GATE accepts: `validateRefs`
    // scopes `${nodes.n_a.output.body}` to the copy's upstream set, which the
    // copied in-edge is what puts `n_a` in. Without it the copy is a root, and
    // its inherited ref is refused for naming no upstream node.
    const issues = validateCanvas(st.nodes, st.edges, st.containers, st.params);
    expect(issues.filter((m) => m.includes('upstream'))).toEqual([]);
  });

  it('the inherited edge is what makes the copy saveable — without one the ref is refused', () => {
    // The premise the in-edge rule exists for, stated as a fact rather than as a
    // rationale: the SAME doc, with the copy's incoming edge removed, is one the
    // save gate refuses. `validateRefs` scopes `${nodes.a.output.body}` to the
    // copy's upstream set, and an unconnected copy has none.
    const s = loaded();
    s.getState().duplicateNode('n_b');
    const st = s.getState();
    const copyId = st.nodes[2]!.id;

    const stranded = st.edges.filter((e) => e.to !== copyId);
    const issues = validateCanvas(st.nodes, stranded, st.containers, st.params);
    expect(issues.some((m) => m.includes('upstream'))).toBe(true);
  });

  it('does NOT copy the OUT-edges — a duplicate never re-wires what is downstream', () => {
    const s = loaded({
      edges: [
        { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
        { id: 'e_2', from: 'n_b', to: 'n_a', on: 'failure' },
      ],
    });
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const copyId = st.nodes[2]!.id;
    expect(st.edges.filter((e) => e.from === copyId)).toHaveLength(0);
  });

  it('copies EVERY qualifying in-edge, not just the first one', () => {
    // A join: two upstreams feed `n_b`. The loop must consider all of them —
    // a `break` after the first would leave the copy half-fed, and half-fed is
    // the case where a ref still resolves and the graph is still wrong.
    const s = loaded({
      nodes: [
        { id: 'n_a', type: 'http_request', config: {}, position: { x: 10, y: 20 } },
        { id: 'n_c', type: 'http_request', config: {}, position: { x: 10, y: 90 } },
        { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 20 } },
      ],
      edges: [
        { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
        { id: 'e_2', from: 'n_c', to: 'n_b', on: 'success' },
      ],
    });
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const copyId = st.nodes[3]!.id;
    const froms = st.edges.filter((e) => e.to === copyId).map((e) => e.from);
    expect(froms.sort()).toEqual(['n_a', 'n_c']);
  });

  it('drops an in-edge that would cross a container boundary', () => {
    // A doc can ARRIVE holding an edge from outside a container to a node
    // inside it (`loadVersion` drops only dangling endpoints, not this), and
    // duplicating that node must not mint a second one the canvas itself would
    // refuse to draw. The rule is `connectRejection`'s, not restated here.
    const s = loaded({
      containers: [{ id: 'c_1', kind: 'stage', children: ['n_b'] }],
    });
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const copyId = st.nodes[2]!.id;
    // The copy joined the container, so its inherited edge from the OUTSIDE
    // node `n_a` now crosses the boundary and is left behind.
    expect(st.containers[0]!.children).toContain(copyId);
    expect(st.edges.filter((e) => e.to === copyId)).toHaveLength(0);
  });

  it('drops an in-edge the canvas would refuse to draw — a back-edge', () => {
    const s = loaded({
      edges: [
        { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
        { id: 'e_2', from: 'n_b', to: 'n_a', on: 'success', back: true, maxBounces: 3 },
      ],
    });
    // `n_a` has one in-edge and it is a back-edge: the copy cannot forward-reach
    // `n_b`, so the ancestry rule refuses it and it is left behind.
    s.getState().duplicateNode('n_a');

    const st = s.getState();
    const copyId = st.nodes[2]!.id;
    expect(st.edges.filter((e) => e.to === copyId)).toHaveLength(0);
  });

  it('joins the container the source is in', () => {
    const s = loaded({
      containers: [{ id: 'c_1', kind: 'stage', children: ['n_b'] }],
    });
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const copyId = st.nodes[2]!.id;
    expect(st.containers[0]!.children).toEqual(['n_b', copyId]);
  });

  it('joins no container when the source is in none', () => {
    const s = loaded({
      containers: [{ id: 'c_1', kind: 'stage', children: ['n_a'] }],
    });
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    expect(st.containers[0]!.children).toEqual(['n_a']);
  });

  it('offsets the copy, and staggers a second copy off the first', () => {
    const s = loaded();
    s.getState().duplicateNode('n_b');
    s.getState().duplicateNode('n_b');

    // Two originals plus two copies, and no two of them share a spot.
    const positions = s.getState().nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(s.getState().nodes).toHaveLength(4);
    expect(new Set(positions).size).toBe(4);
  });

  it('selects the copy, and one undo puts the doc and the selection back', () => {
    const s = loaded();
    s.getState().select({ kind: 'node', id: 'n_b' });
    s.getState().duplicateNode('n_b');

    const copyId = s.getState().nodes[2]!.id;
    expect(s.getState().selected).toEqual([{ kind: 'node', id: copyId }]);

    s.getState().undo();
    const st = s.getState();
    expect(st.nodes).toHaveLength(2);
    expect(st.edges).toHaveLength(1);
    // The restored doc no longer holds the copy, so the selection cannot survive.
    expect(st.selected).toEqual([]);
  });

  it('records exactly one history step, and clears the redo future', () => {
    const s = loaded();
    s.getState().duplicateNode('n_b');
    s.getState().undo();
    expect(s.getState().future).toHaveLength(1);

    s.getState().duplicateNode('n_a');
    expect(s.getState().future).toHaveLength(0);
    expect(s.getState().past).toHaveLength(1);
  });

  it('refuses an unknown id without consuming an undo slot', () => {
    const s = loaded();
    const before = s.getState();
    s.getState().duplicateNode('n_missing');

    const st = s.getState();
    expect(st.nodes).toBe(before.nodes);
    expect(st.past).toHaveLength(0);
    expect(st.dirty).toBe(false);
  });

  it('the copy survives serialization — a saved version carries both nodes', () => {
    const s = loaded();
    s.getState().duplicateNode('n_b');

    const st = s.getState();
    const body = toVersionBody(st.nodes, st.edges, st.containers, st.params, st.outputs, null);
    expect(body.nodes).toHaveLength(3);
    expect(body.nodes.filter((n) => n.type === 'llm_call')).toHaveLength(2);
  });
});

describe('canvasStore — multi-selection (U21 #935)', () => {
  const nodeA = { kind: 'node', id: 'n_a' } as const;
  const nodeB = { kind: 'node', id: 'n_b' } as const;
  const edge1 = { kind: 'edge', id: 'e_1' } as const;
  const box = { kind: 'container', id: 'loop_1' } as const;

  describe('sameSelectionSet', () => {
    it('compares membership, not order — a reordered batch is the same selection', () => {
      expect(sameSelectionSet([nodeA, nodeB], [nodeB, nodeA])).toBe(true);
      expect(sameSelectionSet([], [])).toBe(true);
      expect(sameSelectionSet([nodeA], [nodeA, nodeB])).toBe(false);
      expect(sameSelectionSet([nodeA], [nodeB])).toBe(false);
      // Same id, different kind — parted by kind, exactly as `sameSelection` is.
      expect(sameSelectionSet([{ kind: 'node', id: 'x' }], [{ kind: 'edge', id: 'x' }])).toBe(
        false,
      );
    });
  });

  describe('singleSelection', () => {
    it('is the member when there is EXACTLY one, and null otherwise', () => {
      expect(singleSelection([])).toBeNull();
      expect(singleSelection([nodeA])).toEqual(nodeA);
      // Two selected is not "the first one selected" — the property panel edits
      // one subject, and picking a winner would silently edit an arbitrary node.
      expect(singleSelection([nodeA, nodeB])).toBeNull();
    });
  });

  describe('nextSelection folds a React Flow batch into a SET', () => {
    it('accumulates a marquee — every node in the box joins the selection', () => {
      const afterA = nextSelection([], nodeA, true);
      expect(nextSelection(afterA, nodeB, true)).toEqual([nodeA, nodeB]);
    });

    it('a deselect removes only its own member, leaving the rest', () => {
      expect(nextSelection([nodeA, nodeB], nodeA, false)).toEqual([nodeB]);
      // …down to the last one, which empties the set rather than leaving it
      // holding an element React Flow has just said is no longer selected.
      expect(nextSelection([nodeA], nodeA, false)).toEqual([]);
    });

    it('still folds the single-click batch to just the clicked node', () => {
      // The batch React Flow emits on a plain click: the clicked node selected,
      // then a deselect for every other node AND every edge. #737's guard was
      // needed because a single slot could not tell "clear me" from "clear the
      // others"; a set can, so the fold lands on A without a special case.
      const batch: [{ kind: 'node' | 'edge'; id: string }, boolean][] = [
        [nodeA, true],
        [nodeB, false],
        [edge1, false],
      ];
      const settled = batch.reduce<Selection[]>(
        (current, [target, selected]) => nextSelection(current, target, selected),
        [edge1],
      );
      expect(settled).toEqual([nodeA]);
    });

    it('returns the SAME array when nothing changes — the render-loop guard', () => {
      // Identity, not deep equality: a fresh-but-equal array on every one of the
      // N changes in a batch re-renders the canvas, which re-derives the node
      // array, which makes RF report the selection again (#737's cycle).
      const current = [nodeA, nodeB];
      expect(nextSelection(current, nodeA, true)).toBe(current);
      expect(nextSelection(current, edge1, false)).toBe(current);
    });
  });

  describe('containerExclusive — enforced by setSelection, the one writer', () => {
    it('drops the container when anything else is selected', () => {
      // A container is not a React Flow selection at all (`selectable: false`),
      // so a set holding one alongside nodes would carry a member group-move
      // cannot move and RF cannot deselect. The NODES win: the only way to reach
      // a mixed set is to select one while a container was still standing.
      expect(containerExclusive([box, nodeA])).toEqual([nodeA]);
      expect(containerExclusive([nodeA, box, edge1])).toEqual([nodeA, edge1]);
    });

    it('keeps ONE container when that is all there is', () => {
      expect(containerExclusive([box])).toEqual([box]);
      expect(containerExclusive([box, { kind: 'container', id: 'loop_2' }])).toEqual([box]);
    });

    it('returns the same array untouched when there is no container', () => {
      const clean = [nodeA, nodeB];
      expect(containerExclusive(clean)).toBe(clean);
      expect(containerExclusive([])).toEqual([]);
    });

    it('holds through the STORE, not just the helper', () => {
      const s = createCanvasStore();
      s.getState().setSelection([box, nodeA]);
      expect(s.getState().selected).toEqual([nodeA]);
    });
  });

  describe('setSelection', () => {
    it('is idempotent BY VALUE — an equal set does not write', () => {
      const s = createCanvasStore();
      s.getState().setSelection([nodeA, nodeB]);
      const before = s.getState();
      s.getState().setSelection([nodeB, nodeA]);
      expect(s.getState()).toBe(before);
      expect(s.getState().selected).toBe(before.selected);
    });

    it('select(sel) and select(null) still mean "just this one" and "none"', () => {
      const s = createCanvasStore();
      s.getState().setSelection([nodeA, nodeB]);
      s.getState().select(edge1);
      expect(s.getState().selected).toEqual([edge1]);
      s.getState().select(null);
      expect(s.getState().selected).toEqual([]);
    });
  });

  describe('moveNodes', () => {
    function loaded() {
      const s = createCanvasStore();
      s.getState().loadVersion(version());
      return s;
    }

    it('moves the whole group and records ONE undo entry', () => {
      const s = loaded();
      s.getState().moveNodes([
        { id: 'n_a', position: { x: 11, y: 21 } },
        { id: 'n_b', position: { x: 111, y: 21 } },
      ]);

      expect(s.getState().past).toHaveLength(1);
      expect(s.getState().nodes.map((n) => n.position)).toEqual([
        { x: 11, y: 21 },
        { x: 111, y: 21 },
      ]);

      // The whole gesture comes back in one press — the point of batching. Per
      // node it would take two, and the first press would leave the group
      // half-moved, a state the operator never authored.
      s.getState().undo();
      expect(s.getState().nodes.map((n) => n.position)).toEqual([
        { x: 10, y: 20 },
        { x: 100, y: 20 },
      ]);
    });

    it('records nothing when no member actually moved', () => {
      const s = loaded();
      const before = s.getState();
      s.getState().moveNodes([
        { id: 'n_a', position: { x: 10, y: 20 } },
        { id: 'n_b', position: { x: 100, y: 20 } },
      ]);
      expect(s.getState().nodes).toBe(before.nodes);
      expect(s.getState().past).toHaveLength(0);
      expect(s.getState().dirty).toBe(false);
    });

    it('ignores an id that names no current node', () => {
      const s = loaded();
      s.getState().moveNodes([
        { id: 'n_gone', position: { x: 5, y: 5 } },
        { id: 'n_a', position: { x: 11, y: 21 } },
      ]);
      expect(s.getState().past).toHaveLength(1);
      expect(s.getState().nodes).toHaveLength(2);
      expect(s.getState().nodes[0]!.position).toEqual({ x: 11, y: 21 });
    });
  });

  describe('deleteSelection', () => {
    function loaded() {
      const s = createCanvasStore();
      s.getState().loadVersion(
        version({
          nodes: [
            { id: 'n_a', type: 'http_request', config: {}, position: { x: 10, y: 20 } },
            { id: 'n_b', type: 'llm_call', config: {}, position: { x: 100, y: 20 } },
            { id: 'n_c', type: 'http_request', config: {}, position: { x: 200, y: 20 } },
          ],
          edges: [
            { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
            { id: 'e_2', from: 'n_b', to: 'n_c', on: 'success' },
          ],
        }),
      );
      return s;
    }

    it('removes every selected node, cascades their edges, in ONE undo entry', () => {
      const s = loaded();
      s.getState().setSelection([
        { kind: 'node', id: 'n_a' },
        { kind: 'node', id: 'n_b' },
      ]);
      s.getState().deleteSelection();

      const st = s.getState();
      expect(st.nodes.map((n) => n.id)).toEqual(['n_c']);
      // e_1 is incident to both, e_2 to one — a cascade, not a selected edge.
      expect(st.edges).toHaveLength(0);
      expect(st.past).toHaveLength(1);
      expect(st.selected).toEqual([]);

      s.getState().undo();
      expect(s.getState().nodes).toHaveLength(3);
      expect(s.getState().edges).toHaveLength(2);
    });

    it('deletes a connected node and its edge together — ONE press brings both back', () => {
      // The pre-existing split this fire closes: React Flow's own Backspace path
      // fires the edge removals and the node removals as two separate callbacks,
      // so the store recorded two entries and one undo restored the node while
      // leaving its edge deleted. One gesture is one entry.
      const s = loaded();
      s.getState().select({ kind: 'node', id: 'n_b' });
      s.getState().deleteSelection();
      expect(s.getState().past).toHaveLength(1);

      s.getState().undo();
      expect(s.getState().nodes).toHaveLength(3);
      expect(s.getState().edges.map((e) => e.id)).toEqual(['e_1', 'e_2']);
    });

    it('removes a selected EDGE without touching its endpoints', () => {
      const s = loaded();
      s.getState().setSelection([{ kind: 'edge', id: 'e_1' }]);
      s.getState().deleteSelection();

      const st = s.getState();
      expect(st.nodes).toHaveLength(3);
      expect(st.edges.map((e) => e.id)).toEqual(['e_2']);
    });

    it('prunes container membership for every deleted node (#746)', () => {
      const s = loaded();
      s.getState().createContainer({ id: 'stage_1', kind: 'stage', children: ['n_a', 'n_b'] });
      s.getState().setSelection([
        { kind: 'node', id: 'n_a' },
        { kind: 'node', id: 'n_b' },
      ]);
      s.getState().deleteSelection();

      expect(s.getState().containers[0]!.children).toEqual([]);
    });

    it('never deletes a CONTAINER — that stays the confirm-gated affordance (#748)', () => {
      const s = loaded();
      s.getState().createContainer({ id: 'stage_1', kind: 'stage', children: ['n_a'] });
      s.getState().select({ kind: 'container', id: 'stage_1' });
      const before = s.getState();
      s.getState().deleteSelection();

      const st = s.getState();
      expect(st.containers).toHaveLength(1);
      expect(st.nodes).toHaveLength(3);
      // A refusal consumes no undo slot — a dead undo press is how undo loses trust.
      expect(st.past).toBe(before.past);
      expect(st.dirty).toBe(before.dirty);
    });

    it('is a no-op on an empty selection', () => {
      const s = loaded();
      const before = s.getState();
      s.getState().deleteSelection();
      expect(s.getState().nodes).toBe(before.nodes);
      expect(s.getState().past).toHaveLength(0);
    });
  });
});
