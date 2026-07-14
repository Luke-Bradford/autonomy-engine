import { describe, expect, it } from 'vitest';
import { PipelineVersionSchema, type PipelineVersion } from '@autonomy-studio/shared';
import { createCanvasStore } from './canvasStore';

function version(overrides: Partial<PipelineVersion> = {}): PipelineVersion {
  return PipelineVersionSchema.parse({
    id: 'plv_1',
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
    s.getState().connect('n_b', 'n_a', 'failure');
    expect(s.getState().edges).toHaveLength(2);
    s.getState().connect('n_b', 'n_a', 'failure'); // duplicate
    expect(s.getState().edges).toHaveLength(2);
  });

  it('connect refuses a self-loop or an endpoint that is not a node', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().connect('n_a', 'n_a', 'success'); // self
    s.getState().connect('n_a', 'ghost', 'success'); // missing endpoint
    s.getState().connect('ghost', 'n_a', 'success');
    expect(s.getState().edges).toHaveLength(1); // only the loaded edge
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

  it('updateEdgeOn changes the branch of the targeted edge', () => {
    const s = createCanvasStore();
    s.getState().loadVersion(version());
    s.getState().updateEdgeOn('e_1', 'completion');
    expect(s.getState().edges[0]!.on).toBe('completion');
    expect(s.getState().dirty).toBe(true);
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
