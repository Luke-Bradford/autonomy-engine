import { describe, expect, it } from 'vitest';
import { PipelineVersionSchema } from '@autonomy-studio/shared';
import { createCanvasStore } from './canvasStore';
import { runCanvasCommand } from './canvasCommands';

/**
 * #1477 OR29 — the one implementation behind ⌘C/⌘X/⌘D/⌘V/⌫ and the canvas
 * context menu. The store rules each command calls are `canvasStore.test.ts`'s;
 * what is pinned here is what each command reports, because the keystroke
 * `preventDefault`s on `taken` and the page shows `notice`.
 */
function seeded() {
  const store = createCanvasStore();
  store.getState().loadVersion(
    PipelineVersionSchema.parse({
      id: 'plv_1',
      resourceId: 'res_plv1',
      pipelineId: 'pl_1',
      version: 1,
      params: [],
      outputs: [],
      nodes: [
        { id: 'a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
        { id: 'b', type: 'http_request', config: {}, position: { x: 300, y: 0 } },
        { id: 'in_box', type: 'http_request', config: {}, position: { x: 0, y: 300 } },
      ],
      edges: [{ id: 'e_ab', from: 'a', to: 'b', on: 'success' }],
      containers: [{ id: 'c_1', kind: 'stage', children: ['in_box'] }],
      catalogVersion: 1,
      createdAt: 1,
    }),
  );
  return store;
}

describe('runCanvasCommand (#1477)', () => {
  it('leaves copy, cut, duplicate and delete UNTAKEN with nothing selected, so the browser keeps ⌘C', () => {
    const store = seeded();
    for (const cmd of ['copy', 'cut', 'duplicate', 'delete'] as const) {
      expect(runCanvasCommand(store, 'pl_1', cmd), cmd).toEqual({ taken: false });
    }
    expect(store.getState().nodes.map((n) => n.id)).toEqual(['a', 'b', 'in_box']);
  });

  it('copies, then pastes, an activity and says so', () => {
    const store = seeded();
    store.getState().select({ kind: 'node', id: 'a' });
    expect(runCanvasCommand(store, 'pl_1', 'copy')).toEqual({
      taken: true,
      notice: 'Copied 1 activity.',
    });
    expect(runCanvasCommand(store, 'pl_1', 'paste')).toEqual({
      taken: true,
      notice: 'Pasted 1 activity.',
    });
    expect(store.getState().nodes).toHaveLength(4);
  });

  it('cuts an activity, and its edge with it, in one undo entry', () => {
    const store = seeded();
    store.getState().select({ kind: 'node', id: 'b' });
    const before = store.getState().past.length;
    expect(runCanvasCommand(store, 'pl_1', 'cut')).toEqual({ taken: true, notice: 'Cut 1 activity.' });
    expect(store.getState().nodes.map((n) => n.id)).toEqual(['a', 'in_box']);
    expect(store.getState().edges).toEqual([]);
    expect(store.getState().past.length).toBe(before + 1);
  });

  it('deletes the selection silently, in one undo entry', () => {
    const store = seeded();
    store.getState().setSelection([
      { kind: 'node', id: 'a' },
      { kind: 'node', id: 'b' },
    ]);
    const before = store.getState().past.length;
    expect(runCanvasCommand(store, 'pl_1', 'delete')).toEqual({ taken: true, notice: null });
    expect(store.getState().nodes.map((n) => n.id)).toEqual(['in_box']);
    expect(store.getState().past.length).toBe(before + 1);
  });

  it('duplicates activities and counts them', () => {
    const store = seeded();
    store.getState().setSelection([
      { kind: 'node', id: 'a' },
      { kind: 'node', id: 'b' },
    ]);
    expect(runCanvasCommand(store, 'pl_1', 'duplicate')).toEqual({
      taken: true,
      notice: 'Duplicated 2 activities.',
    });
    expect(store.getState().nodes).toHaveLength(5);
  });

  it('refuses to cut a container, by name of the key that copies it', () => {
    const store = seeded();
    store.getState().select({ kind: 'container', id: 'c_1' });
    expect(runCanvasCommand(store, 'pl_1', 'cut')).toEqual({
      taken: true,
      notice: 'A container cannot be cut. Copy it with ⌘C.',
    });
    expect(store.getState().containers.map((c) => c.id)).toEqual(['c_1']);
  });

  it('copies and duplicates a container by its label', () => {
    const store = seeded();
    store.getState().select({ kind: 'container', id: 'c_1' });
    expect(runCanvasCommand(store, 'pl_1', 'copy')).toEqual({ taken: true, notice: 'Copied Stage 1.' });
    expect(runCanvasCommand(store, 'pl_1', 'duplicate')).toEqual({
      taken: true,
      notice: 'Duplicated Stage 1.',
    });
    expect(store.getState().containers).toHaveLength(2);
  });
});
