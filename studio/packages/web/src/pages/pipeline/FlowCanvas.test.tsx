import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { PipelineVersionSchema } from '@autonomy-studio/shared';
import { fakeDataTransfer } from '../../testing/fakeDataTransfer';
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

/** A `DataTransfer` stand-in — see `testing/fakeDataTransfer.ts` for why the
 * protected-mode distinction matters and why it is defined once. */
function dataTransfer(entries: Record<string, string>, protectedMode = false): DataTransfer {
  return fakeDataTransfer({ data: entries, protectedMode });
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
  return { store, container, surface: surface!, chrome: chrome! };
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
   * What THIS layer uniquely decides is whether the event is default-prevented,
   * so that is what these specs assert alongside "no node".
   *
   * They deliberately do NOT try to pin the payload RULES (which types are
   * authorable). Asserting only "no node was added" would test nothing here:
   * `canvasStore.addNode` refuses an unknown and a structural-call type on its
   * own, so replacing the whole payload check with a raw `getData()` leaves
   * every node count identical (verified by mutation — it survived). Those rules
   * are pinned where they are observable, in `activityDnd.test.ts`.
   *
   * The line these specs DO draw is between two different kinds of refusal:
   *  - a drag that is NOT OURS is left alone — un-cancelled, so the browser
   *    still does whatever it would have done with a dropped file or link;
   *  - a drag that IS ours but is unauthorable is CLAIMED and then ignored,
   *    because `dragover` already promised to accept it. Bailing without
   *    cancelling would hand a drop we invited back to the browser's default
   *    action — and `types` being a list, a drag carrying our MIME alongside
   *    `text/uri-list` would navigate the page away from an unsaved graph.
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

  it('CLAIMS a drop it invited but cannot author — an uncatalogued type', () => {
    const { store, surface } = mountCanvas();
    const prevented = !fireEvent.drop(surface, {
      dataTransfer: activityDrag('not_an_activity'),
      clientX: 0,
    });
    expect(store.getState().nodes).toHaveLength(0);
    // Claimed, NOT handed back to the browser — see the block comment above.
    expect(prevented).toBe(true);
  });

  it('CLAIMS a drop naming the structural-call activity, and authors nothing (#4 A9 / #425)', () => {
    const { store, surface } = mountCanvas();
    const prevented = !fireEvent.drop(surface, {
      dataTransfer: activityDrag('execute_pipeline'),
      clientX: 0,
    });
    expect(store.getState().nodes).toHaveLength(0);
    expect(prevented).toBe(true);
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

  it('does NOT claim a drop on the chrome, even carrying our own payload', () => {
    // The chrome guard runs BEFORE the claim, so a drop over the minimap is
    // never invited in the first place — `dragover` refused it too.
    const { store, chrome } = mountCanvas();
    const prevented = !fireEvent.drop(chrome, {
      dataTransfer: activityDrag('http_request'),
      clientX: 0,
      clientY: 0,
    });
    expect(store.getState().nodes).toHaveLength(0);
    expect(prevented).toBe(false);
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

/**
 * U6c — the DERIVED container node, at the wiring level.
 *
 * What jsdom can see is which nodes the canvas hands React Flow and what they
 * carry; what it cannot see is any of the geometry, because it measures every
 * element as 0×0 and resolves no cascade. So the box's size, its enclosure of its
 * children and — the defect that shipped once — whether an edge with a container
 * endpoint actually renders are all `e2e/container-rendering.spec.ts`'s to prove.
 * These specs cover the half that is cheap here and awkward there: that a loaded
 * container reaches the canvas at all, and that it is NOT in the domain graph.
 */
describe('FlowCanvas container rendering (U6c)', () => {
  function withContainer(
    containers: Array<{ id: string; kind: 'stage' | 'loop' | 'foreach'; children: string[] }> = [
      { id: 'c_1', kind: 'stage', children: ['n_a', 'n_b'] },
    ],
  ) {
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
          { id: 'n_a', type: 'http_request', config: {}, position: { x: 0, y: 0 } },
          { id: 'n_b', type: 'http_request', config: {}, position: { x: 0, y: 160 } },
        ],
        edges: [],
        containers,
        catalogVersion: 1,
        createdAt: 1,
      }),
    );
    const { container } = render(
      <ReactFlowProvider>
        <FlowCanvas store={store} />
      </ReactFlowProvider>,
    );
    return { store, container };
  }

  /** The element React Flow owns for a node — where a node's aria props land. */
  function nodeWrapper(container: HTMLElement, id: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    expect(el, `no rendered node ${id}`).not.toBeNull();
    return el!;
  }

  it('renders a loaded container as its own node type, labelled by KIND', () => {
    const { container } = withContainer();
    const box = container.querySelector('.flow-container');
    expect(box).not.toBeNull();
    // The word, not a colour or a shape — the same one `connectRules` refuses a
    // boundary crossing by, so a refusal points at something on screen.
    expect(box!.querySelector('.flow-container-label')?.textContent).toBe('stage');
  });

  /**
   * The accessible name goes on the element React Flow owns, via the node's
   * `ariaRole`/`ariaLabel`, not on this component's inner `<div>`.
   *
   * On the inner div the name sat on a `pointer-events: none` child of a wrapper
   * that — a container being non-focusable — carried no role at all, while RF
   * still wrote its unconditional `aria-roledescription="node"` there. So the box
   * announced itself on one element and was described on another.
   */
  it('puts the accessible name and role on the node element React Flow renders', () => {
    const { container } = withContainer();
    const wrapper = nodeWrapper(container, 'c_1');
    expect(wrapper.getAttribute('role')).toBe('group');
    expect(wrapper.getAttribute('aria-label')).toBe('stage container, 2 activities');
    // And NOT on the inner div, which cannot be reached or focused.
    expect(container.querySelector('.flow-container')!.hasAttribute('aria-label')).toBe(false);
  });

  /**
   * What is announced is what is DRAWN — the count comes from the box, not from
   * `container.children.length`.
   *
   * The two disagree whenever a listed child is not in the box: a phantom (its
   * node deleted, the id still listed — reachable today, since `deleteNode` does
   * not prune `containers[].children`) or a child a FIRST-wins earlier container
   * already claimed. Counting the raw array captions the box with children it does
   * not contain.
   */
  it('announces the children it DRAWS, not the ids it lists', () => {
    const { container } = withContainer([{ id: 'c_1', kind: 'stage', children: ['n_a', 'ghost'] }]);
    expect(nodeWrapper(container, 'c_1').getAttribute('aria-label')).toBe(
      'stage container, 1 activity',
    );
  });

  /**
   * Containers are handed to React Flow FIRST, which is what puts the box behind
   * the activities it encloses.
   *
   * Order is the whole mechanism: with React Flow's basic z-index mode an
   * unselected activity resolves to the same z as the container's explicit
   * `zIndex: 0`, so the tie is broken by the order of the `nodes` prop, which RF
   * emits verbatim. Cheap to state here and red the moment the spread flips.
   *
   * (The change-seam filter that keeps container changes out of the domain store
   * is deliberately NOT tested — `moveNode`/`deleteNode` both early-return on an
   * unknown id, so removing the filter changes nothing observable today. It is
   * documented at the seam as a guard for U6d, when it starts to matter, rather
   * than pinned by a test that cannot fail.)
   */
  it('hands the container to React Flow before its children, so it paints behind', () => {
    const { container } = withContainer();
    const ids = [...container.querySelectorAll('.react-flow__node')].map((n) =>
      n.getAttribute('data-id'),
    );
    expect(ids).toEqual(['c_1', 'n_a', 'n_b']);
  });

  /**
   * A container whose id COLLIDES with a node's must not make that node inert.
   *
   * Nodes and containers share one id namespace. `validateDoc` refuses a
   * collision, but that gate is advisory and write-path only, so a version
   * written before it still loads. When it does, RF's Map-keyed `nodeLookup`
   * keeps the LAST entry for the id — the activity — so every change RF reports
   * for that id belongs to a node that IS in the store. Filtering it by id alone
   * dropped all of them: the node could not be selected, moved or deleted, which
   * is to say the operator could not edit the doc back out of the collision.
   */
  it('does not swallow changes for an ACTIVITY that shares a container id', () => {
    const { store, container } = withContainer([{ id: 'n_a', kind: 'stage', children: ['n_b'] }]);
    fireEvent.click(nodeWrapper(container, 'n_a'));
    expect(store.getState().selected).toEqual({ kind: 'node', id: 'n_a' });
  });
});
