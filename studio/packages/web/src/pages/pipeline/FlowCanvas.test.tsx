import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { FlowCanvas } from './FlowCanvas';
import { ACTIVITY_DND_MIME } from './activityDnd';
import { createCanvasStore } from './canvasStore';

/**
 * The DROP half of U5's drag-and-drop, unit-tested.
 *
 * jsdom paints nothing and measures everything as zero, so what these specs
 * CANNOT check is where the node lands under a real zoom/pan — that is the e2e's
 * job. What they CAN check, and what an e2e would cover only awkwardly, is the
 * routing: which drags the canvas accepts, which it refuses, and that a refusal
 * is a genuine no-op rather than a node authored somewhere unhelpful.
 */

/**
 * A `DataTransfer` stand-in, since jsdom implements none.
 *
 * `protectedMode` reproduces the HTML drag-data store's behaviour during
 * `dragenter`/`dragover`: `types` is readable, `getData()` returns `''`. Without
 * it a `dragover` gate written against the payload would pass here and reject
 * every real drag in a browser.
 */
function dataTransfer(entries: Record<string, string>, protectedMode = false): DataTransfer {
  const data = new Map(Object.entries(entries));
  return {
    types: [...data.keys()],
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    getData: (format: string) => (protectedMode ? '' : (data.get(format) ?? '')),
    setData: (format: string, value: string) => data.set(format, value),
  } as unknown as DataTransfer;
}

/** An activity drag, as the toolbox arms it. */
function activityDrag(type: string, protectedMode = false): DataTransfer {
  return dataTransfer({ [ACTIVITY_DND_MIME]: type }, protectedMode);
}

function mountCanvas() {
  const store = createCanvasStore();
  store.getState().loadVersion(null);
  const { container } = render(
    <ReactFlowProvider>
      <FlowCanvas store={store} />
    </ReactFlowProvider>,
  );
  const surface = container.querySelector('.react-flow__pane');
  const chrome = container.querySelector('.react-flow__minimap');
  // Both must exist, or a spec below would pass by dispatching into nothing.
  expect(surface).not.toBeNull();
  expect(chrome).not.toBeNull();
  return { store, surface: surface!, chrome: chrome! };
}

describe('FlowCanvas drop target (U5)', () => {
  it('authors a node when an activity drag is dropped on the canvas surface', () => {
    const { store, surface } = mountCanvas();
    fireEvent.drop(surface, { dataTransfer: activityDrag('http_request'), clientX: 0, clientY: 0 });
    expect(store.getState().nodes).toHaveLength(1);
    expect(store.getState().nodes[0]!.type).toBe('http_request');
  });

  it('IGNORES a drop on the canvas chrome (minimap/controls), which is not a placement', () => {
    // React Flow spreads `onDrop` onto its OUTER wrapper, and the MiniMap,
    // Controls and attribution all render inside it via its `Panel` primitive.
    // Without the guard, releasing over the minimap authors a node at whatever
    // flow position sits under that screen corner — somewhere the operator never
    // pointed at.
    const { store, chrome } = mountCanvas();
    fireEvent.drop(chrome, { dataTransfer: activityDrag('http_request'), clientX: 0, clientY: 0 });
    expect(store.getState().nodes).toHaveLength(0);
    expect(store.getState().dirty).toBe(false);
  });

  /**
   * A drop this canvas does not own must be left ALONE, not merely made
   * ineffective — so each case below asserts `preventDefault` was NOT called as
   * well as "no node".
   *
   * The second half is the load-bearing one. Asserting only "no node" does not
   * test this layer at all: `canvasStore.addNode` refuses an unknown and a
   * structural-call type on its own, so replacing the whole payload check with a
   * raw `getData()` leaves the node count identical and the assertion green
   * (verified by mutation). Whether the event is default-prevented is the one
   * thing only THIS layer decides — and it is the thing the operator sees, since
   * swallowing a file drag means the browser silently does nothing with it.
   */
  it('leaves a foreign drag alone — a dropped file or text selection is not ours', () => {
    const { store, surface } = mountCanvas();
    const prevented = !fireEvent.drop(surface, {
      dataTransfer: dataTransfer({ 'text/plain': 'http_request' }),
      clientX: 0,
      clientY: 0,
    });
    expect(store.getState().nodes).toHaveLength(0);
    expect(prevented).toBe(false);
  });

  it('leaves a payload naming a type the catalog does not have alone', () => {
    const { store, surface } = mountCanvas();
    const prevented = !fireEvent.drop(surface, {
      dataTransfer: activityDrag('not_an_activity'),
      clientX: 0,
    });
    expect(store.getState().nodes).toHaveLength(0);
    expect(prevented).toBe(false);
  });

  it('leaves a payload naming the structural-call activity alone (#4 A9 / #425)', () => {
    const { store, surface } = mountCanvas();
    const prevented = !fireEvent.drop(surface, {
      dataTransfer: activityDrag('execute_pipeline'),
      clientX: 0,
    });
    expect(store.getState().nodes).toHaveLength(0);
    expect(prevented).toBe(false);
  });

  it('CLAIMS a drop it does own, so the browser does not also act on it', () => {
    const { surface } = mountCanvas();
    const prevented = !fireEvent.drop(surface, {
      dataTransfer: activityDrag('http_request'),
      clientX: 0,
      clientY: 0,
    });
    expect(prevented).toBe(true);
  });

  it('accepts the drag on dragover — preventDefault is what makes it a drop target', () => {
    const { surface } = mountCanvas();
    const dt = activityDrag('http_request', /* protectedMode */ true);
    const accepted = !fireEvent.dragOver(surface, { dataTransfer: dt });
    // `fireEvent` returns false when the event was default-prevented.
    expect(accepted).toBe(true);
    expect(dt.dropEffect).toBe('copy');
  });

  it('does NOT accept a foreign drag on dragover, so the browser keeps its own behaviour', () => {
    // Calling preventDefault unconditionally would make the canvas swallow every
    // file/link/text drag released over it — silently doing nothing instead of
    // letting the browser do its default thing.
    const { surface } = mountCanvas();
    const dt = dataTransfer({ Files: '' }, true);
    const accepted = !fireEvent.dragOver(surface, { dataTransfer: dt });
    expect(accepted).toBe(false);
    expect(dt.dropEffect).toBe('none');
  });

  it('does NOT accept a drag held over the canvas chrome', () => {
    const { chrome } = mountCanvas();
    const dt = activityDrag('http_request', true);
    const accepted = !fireEvent.dragOver(chrome, { dataTransfer: dt });
    // The same predicate gates both, so the operator gets the browser's "no drop"
    // cursor over the minimap rather than an invitation to drop there.
    expect(accepted).toBe(false);
  });
});
