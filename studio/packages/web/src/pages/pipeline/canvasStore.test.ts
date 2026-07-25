import { describe, expect, it } from 'vitest';
import { EdgeSchema, PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { createCanvasStore, nextSelection, sameSelection } from './canvasStore';

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

describe('canvasStore', () => {
  it('loadVersion(null) is the empty first-run state', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    const st = s.getState();
    expect(st.loaded).toBeNull();
    expect(st.nodes).toEqual([]);
    expect(st.edges).toEqual([]);
    expect(st.selected).toBeNull();
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

  it('addNode refuses a structural-call type (execute_pipeline) — config rides node.call, #425', () => {
    // `execute_pipeline`'s settings live in `node.call`, not `node.config`, so the
    // generic config-form path here would author a call-less, un-saveable node.
    // Call-node authoring is #425; until then the store refuses it, like an unknown
    // type — and the palette hides its button (see PipelineCanvas).
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('execute_pipeline');
    expect(s.getState().nodes).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
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

  it('addNode still refuses an unknown or structural-call type WITH a position', () => {
    // The position argument is not a bypass: the drop path runs the same guards
    // as the click path, so a hand-crafted drag payload cannot author garbage.
    const s = createCanvasStore();
    s.getState().loadVersion(null);
    s.getState().addNode('not_a_real_activity', { x: 10, y: 10 });
    s.getState().addNode('execute_pipeline', { x: 10, y: 10 });
    expect(s.getState().nodes).toHaveLength(0);
    expect(s.getState().dirty).toBe(false);
  });

  it('moveNode updates only the targeted node; an unknown id is a no-op', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().moveNode('n_a', { x: 999, y: 888 });
    expect(s.getState().nodes.find((n) => n.id === 'n_a')!.position).toEqual({ x: 999, y: 888 });
    expect(s.getState().nodes.find((n) => n.id === 'n_b')!.position).toEqual({ x: 100, y: 20 });
    const before = s.getState().nodes;
    s.getState().moveNode('nope', { x: 1, y: 1 });
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
    expect(st.selected).toBeNull();
    expect(st.dirty).toBe(true);
  });

  it('deleteEdge removes the edge and clears a selection pointing at it', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().select({ kind: 'edge', id: 'e_1' });
    s.getState().deleteEdge('e_1');
    expect(s.getState().edges).toHaveLength(0);
    expect(s.getState().selected).toBeNull();
  });

  it('updateEdgeCondition changes the `on` outcome of the targeted edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().updateEdgeCondition('e_1', { on: 'completion' });
    expect(s.getState().edges[0]!.on).toBe('completion');
    expect(s.getState().dirty).toBe(true);
  });

  /**
   * The other direction of the same rewrite, authorable from the canvas as of
   * U6a: the `branch` key is REQUIRED on a business edge, so setting one must
   * add it rather than leave an `on:'branch'` edge that fails `EdgeSchema`.
   */
  it('updateEdgeCondition sets the business `branch` key when retyping TO a branch', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().updateEdgeCondition('e_1', { on: 'branch', branch: 'true' });

    const edge = s.getState().edges[0]!;
    expect(edge).toMatchObject({ on: 'branch', branch: 'true' });
    expect(() => EdgeSchema.parse(edge)).not.toThrow();
  });

  it('updateEdgeCondition rewrites the routing key when moving between branch arms', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({ edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' }] }),
    );
    s.getState().updateEdgeCondition('e_1', { on: 'branch', branch: 'false' });
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
  it('updateEdgeCondition REFUSES a retype that would duplicate another edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'success' },
          { id: 'e_2', from: 'n_a', to: 'n_b', on: 'failure' },
        ],
      }),
    );
    s.getState().updateEdgeCondition('e_2', { on: 'success' });

    expect(s.getState().edges.find((e) => e.id === 'e_2')!.on).toBe('failure'); // unchanged
    expect(s.getState().dirty).toBe(false);
  });

  /** The same guard on the business arm — two arms differ only by routing key. */
  it('updateEdgeCondition REFUSES a retype onto an occupied branch arm', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' },
          { id: 'e_2', from: 'n_a', to: 'n_b', on: 'branch', branch: 'false' },
        ],
      }),
    );
    s.getState().updateEdgeCondition('e_2', { on: 'branch', branch: 'true' });
    expect(s.getState().edges.find((e) => e.id === 'e_2')).toMatchObject({ branch: 'false' });
  });

  /** ...but a no-op retype to the edge's OWN condition must not self-collide. */
  it('updateEdgeCondition allows a retype to the edge’s own current condition', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().updateEdgeCondition('e_1', { on: 'success' });
    expect(s.getState().edges[0]!.on).toBe('success');
  });

  /**
   * The collision guard must use the ENGINE's edge identity, which includes the
   * `branch` label. Both arms of one `if` may legitimately target one node (the
   * `stableEdgeKey` doc names an approval's "redo" arm alongside its forward
   * arm), and they share `(from, to, 'branch')` — so a key without the label
   * would refuse the second arm as a duplicate of the first.
   */
  it('updateEdgeCondition ALLOWS a second branch arm between the same pair of nodes', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
          { id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' },
          { id: 'e_2', from: 'n_a', to: 'n_b', on: 'success' },
        ],
      }),
    );
    s.getState().updateEdgeCondition('e_2', { on: 'branch', branch: 'false' });
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
  it('updateEdgeCondition drops the business `branch` key when retyping a branch edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [{ id: 'e_1', from: 'n_a', to: 'n_b', on: 'branch', branch: 'true' }],
      }),
    );
    s.getState().updateEdgeCondition('e_1', { on: 'success' });

    const edge = s.getState().edges[0]!;
    expect(edge.on).toBe('success');
    expect(edge).not.toHaveProperty('branch');
    // The retyped edge must still be a VALID member of the union.
    expect(() => EdgeSchema.parse(edge)).not.toThrow();
  });

  // The same retype must preserve the shared `edgeBase` fields — dropping
  // `branch` must not drop the back-edge cap along with it.
  it('updateEdgeCondition preserves back/maxBounces when retyping a branch back-edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(
      version({
        edges: [
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
    s.getState().updateEdgeCondition('e_1', { on: 'failure' });

    const edge = s.getState().edges[0]!;
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

  it('nextSelection takes any select, and clears ONLY on the current selection', () => {
    expect(nextSelection(null, nodeA, true)).toEqual(nodeA);
    expect(nextSelection(edge1, nodeA, true)).toEqual(nodeA);
    expect(nextSelection(nodeA, nodeA, false)).toBeNull();
    expect(nextSelection(null, nodeA, false)).toBeNull();
  });

  it('nextSelection IGNORES the deselect of anything that is not selected', () => {
    // The batch React Flow actually emits when node A is clicked: A selected,
    // then a deselect for every other node AND every edge. Folding the batch in
    // order must land on A, not null — an unguarded clear would open the property
    // panel and shut it again in the same tick.
    const batch: [{ kind: 'node' | 'edge'; id: string }, boolean][] = [
      [nodeA, true],
      [nodeB, false],
      [edge1, false],
    ];
    const settled = batch.reduce<ReturnType<typeof nextSelection>>(
      (current, [target, selected]) => nextSelection(current, target, selected),
      edge1,
    );
    expect(settled).toEqual(nodeA);
  });

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
    expect(s.getState().selected).toEqual(edge1);
    s.getState().select(null);
    expect(s.getState().selected).toBeNull();
  });
});
