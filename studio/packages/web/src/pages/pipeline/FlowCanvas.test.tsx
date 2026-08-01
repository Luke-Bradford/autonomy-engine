import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
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

  it('renders a loaded container as its own node type, labelled by its NAME', () => {
    const { container } = withContainer();
    const box = container.querySelector('.flow-container');
    expect(box).not.toBeNull();
    // Words, not a colour or a shape — and since #883 the WITHIN-KIND ORDINAL,
    // the same text `connectRules` refuses a boundary crossing by and the same
    // text the membership picker offers, so all three name one rectangle.
    expect(box!.querySelector('.flow-container-label')?.textContent).toBe('stage 1');
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
    expect(wrapper.getAttribute('aria-label')).toBe('stage 1 container, 2 activities');
    // And NOT on the inner div, which cannot be reached or focused.
    expect(container.querySelector('.flow-container')!.hasAttribute('aria-label')).toBe(false);
  });

  /**
   * What is announced is what is DRAWN — the count comes from the box, not from
   * `container.children.length`.
   *
   * The two disagree whenever a listed child is not in the box: a phantom (an id
   * listed as a child that is not a node in the doc) or a child a FIRST-wins
   * earlier container already claimed. Counting the raw array captions the box
   * with children it does not contain.
   *
   * `deleteNode` prunes membership as of #746, so a phantom is no longer
   * something the CANVAS can create — but it is still reachable, which is why
   * this test stands: a version minted before the write gate, an import, or a
   * git checkout can all arrive with one, and the prune is deliberately confined
   * to the id the operator just deleted rather than normalising the whole doc
   * (which would silently repair — and hide — exactly those).
   */
  it('announces the children it DRAWS, not the ids it lists', () => {
    const { container } = withContainer([{ id: 'c_1', kind: 'stage', children: ['n_a', 'ghost'] }]);
    expect(nodeWrapper(container, 'c_1').getAttribute('aria-label')).toBe(
      'stage 1 container, 1 activity',
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

/**
 * #748 — the container's own delete affordance, in its header band.
 *
 * WHY a button on the box rather than select-then-property-panel, which is how
 * every other element on this canvas is edited: a container cannot be made
 * `selectable`. React Flow writes `pointer-events: all` on the wrapper of a
 * selectable node, and a container's wrapper spans a REGION of the canvas
 * containing other interactive things — it would then eat every pane click aimed
 * at the space between its children (mutation-proven in
 * `e2e/container-rendering.spec.ts`, 'the box does not swallow gestures aimed
 * through it'). So the box stays inert and one small control inside it opts back
 * IN to hit-testing, exactly as the container's edge handles already do.
 *
 * The confirmation is asserted in BOTH directions. A destructive action gated on
 * a dialog whose "cancel" is never tested is a coin-flip: the operator's only
 * protection against losing a container's `exitWhen`/`items`/`maxRounds`/
 * `timeout` (there is no undo) is that declining really does nothing.
 */
describe('FlowCanvas container delete (#748)', () => {
  afterEach(() => vi.restoreAllMocks());

  function withBoxedGraph(kind: 'stage' | 'loop' | 'foreach' = 'stage') {
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
          { id: 'after', type: 'http_request', config: {}, position: { x: 400, y: 0 } },
        ],
        edges: [{ id: 'e_out', from: 'c_1', to: 'after', on: 'success' }],
        containers: [
          kind === 'loop'
            ? { id: 'c_1', kind, children: ['n_a'], exitWhen: '${equals(1, 1)}' }
            : kind === 'foreach'
              ? { id: 'c_1', kind, children: ['n_a'], items: '${json("[1,2]")}' }
              : { id: 'c_1', kind, children: ['n_a'] },
        ],
        catalogVersion: 1,
        createdAt: 1,
      }),
    );
    const { container } = render(
      <ReactFlowProvider>
        <FlowCanvas store={store} />
      </ReactFlowProvider>,
    );
    const box = container.querySelector<HTMLElement>('.react-flow__node[data-id="c_1"]');
    expect(box, 'no rendered container c_1').not.toBeNull();
    return { store, box: box! };
  }

  /**
   * Named by KIND, so the accessible name says which box is going — the same
   * word the label already shows and the same one `connectRules` refuses a
   * boundary crossing by.
   */
  it('offers a delete control named for the container, ordinal and all', () => {
    const { box } = withBoxedGraph('loop');
    expect(within(box).getByRole('button', { name: 'Delete loop 1 container' })).toBeTruthy();
  });

  it('deletes the container, and its incident edges, once confirmed', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { store, box } = withBoxedGraph();
    fireEvent.click(within(box).getByRole('button', { name: 'Delete stage 1 container' }));
    const st = store.getState();
    expect(st.containers).toEqual([]);
    expect(st.edges).toEqual([]);
    // The child is un-grouped, NOT deleted with the box it sat in.
    expect(st.nodes.map((n) => n.id)).toEqual(['n_a', 'after']);
  });

  it('does nothing at all when the confirmation is declined', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { store, box } = withBoxedGraph();
    fireEvent.click(within(box).getByRole('button', { name: 'Delete stage 1 container' }));
    const st = store.getState();
    expect(st.containers.map((c) => c.id)).toEqual(['c_1']);
    expect(st.edges.map((e) => e.id)).toEqual(['e_out']);
    expect(st.dirty).toBe(false);
  });

  /**
   * The confirmation states what is LOST and what is KEPT.
   *
   * Pinned because the asymmetry is the whole safety argument for offering the
   * action: the config goes and cannot come back, the activities stay. A dialog
   * that said only "are you sure?" would leave the operator guessing whether
   * they are about to delete their nodes.
   */
  it('warns that the config goes and the activities stay', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { box } = withBoxedGraph('loop');
    fireEvent.click(within(box).getByRole('button', { name: 'Delete loop 1 container' }));
    const message = confirm.mock.calls[0]![0] as string;
    // #883 — the ORDINAL, not a bare `toContain('loop')` that a bare-kind dialog
    // would also satisfy. Naming the button "Delete loop 1 container" and then
    // asking "Delete this loop container?" would relocate the half-named split
    // rather than close it, and with two loops the dialog would not say which.
    expect(message).toContain('Delete this loop 1 container?');
    expect(message).toMatch(/activities.*kept|kept.*activities/i);
    expect(message).toMatch(/cannot be undone/i);
  });

  /**
   * A `foreach` is warned about SPECIFICALLY, because for that kind "the
   * activities are kept" is true but misleading.
   *
   * `${item}` is scoped by MEMBERSHIP — only nodes inside a `foreach` have it in
   * scope — so un-grouping a child that references it turns every reference into
   * a validation error and the doc stops saving (pinned end-to-end in
   * `canvasStore.test.ts`, 'deleting a foreach strands its children's ${item}').
   * That is the same shape of trap this ticket exists to end, so springing it
   * silently would be the fix re-introducing the bug in a new place.
   *
   * The `loop`/`stage` half of the assertion is what stops the warning becoming
   * boilerplate on every kind, which would make it invisible.
   */
  it('warns that a foreach un-groups its children out of ${item} scope', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { box } = withBoxedGraph('foreach');
    fireEvent.click(within(box).getByRole('button', { name: 'Delete foreach 1 container' }));
    expect(confirm.mock.calls[0]![0] as string).toContain('${item}');
  });

  it('does NOT warn about ${item} for a kind that never scoped it', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { box } = withBoxedGraph('loop');
    fireEvent.click(within(box).getByRole('button', { name: 'Delete loop 1 container' }));
    expect(confirm.mock.calls[0]![0] as string).not.toContain('${item}');
  });

  /**
   * #840 — the delete's ROUTING consequence, on the fixture that produces it for
   * the reason easiest to miss. This graph AUTHORS an edge (`c_1 → after`), so
   * nothing is inferred for it; the cascade removes that edge along with the box,
   * which leaves the doc edge-less and starts inferring a chain over node order.
   * A comparison short-circuited on "the doc has authored edges" would report
   * nothing here, which is why `routingChangeBetween` refuses that guard.
   */
  it('warns that deleting the box leaves routing INFERRED, when the cascade empties the edges', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { box } = withBoxedGraph();
    fireEvent.click(within(box).getByRole('button', { name: 'Delete stage 1 container' }));
    const message = confirm.mock.calls[0]![0] as string;
    expect(message).toContain('no authored edges');
    expect(message).toContain('one sequence');
    // The destruction half is still its own sentence — the two are composed, not
    // merged into one vaguer warning.
    expect(message).toMatch(/cannot be undone/i);
  });

  /**
   * The negative half, and it must be a delete that genuinely leaves routing
   * alone — not merely one that leaves another container standing, which DOES
   * change the walk by moving the deleted box's children to the top level. Here a
   * second authored edge survives the cascade, so routing stays authored on both
   * sides and there is nothing to say.
   */
  it('says nothing about routing when an authored edge survives the cascade', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
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
          { id: 'after', type: 'http_request', config: {}, position: { x: 400, y: 0 } },
          { id: 'last', type: 'http_request', config: {}, position: { x: 800, y: 0 } },
        ],
        edges: [
          { id: 'e_out', from: 'c_1', to: 'after', on: 'success' },
          { id: 'e_keep', from: 'after', to: 'last', on: 'success' },
        ],
        containers: [{ id: 'c_1', kind: 'stage', children: ['n_a'] }],
        catalogVersion: 1,
        createdAt: 1,
      }),
    );
    const { container } = render(
      <ReactFlowProvider>
        <FlowCanvas store={store} />
      </ReactFlowProvider>,
    );
    const box = container.querySelector<HTMLElement>('.react-flow__node[data-id="c_1"]')!;
    fireEvent.click(within(box).getByRole('button', { name: 'Delete stage 1 container' }));
    const message = confirm.mock.calls[0]![0] as string;
    expect(message).not.toContain('inferred');
    expect(message).not.toContain('one sequence');
  });
});

/**
 * #788 — an edge-less doc runs as an implicit SEQUENCE, and says so.
 *
 * `effectiveEdges` synthesizes a success chain over node array order whenever a
 * doc authors no edges, so deleting every edge does not remove routing — it
 * replaces it with a line. Engine semantics are unchanged here (that was the
 * operator's call on #788); what changes is that the canvas stops leaving the
 * topology to be inferred from an array length.
 */
describe('FlowCanvas implicit-chain advisory (#788)', () => {
  /** A node in a fixture graph: an id, or an id paired with the activity TYPE
   *  whose catalog title the advisory will name it by (#878). */
  type Spec = string | { id: string; type: string };

  function withGraph(
    nodeSpecs: Spec[],
    edges: Array<{ id: string; from: string; to: string; on: string }> = [],
    containers: Array<{ id: string; kind: 'stage' | 'loop' | 'foreach'; children: string[] }> = [],
    /** `reversed` lays the graph out bottom-to-top, so ARRAY order and VISUAL
     *  order disagree — see the test that uses it. */
    layout: 'inOrder' | 'reversed' = 'inOrder',
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
        nodes: nodeSpecs.map((spec, i) => ({
          id: typeof spec === 'string' ? spec : spec.id,
          type: typeof spec === 'string' ? 'http_request' : spec.type,
          config: {},
          position: { x: 0, y: (layout === 'reversed' ? nodeSpecs.length - 1 - i : i) * 160 },
        })),
        edges,
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
    return { store, container, advisory: container.querySelector('.canvas-advisory') };
  }

  it('names the synthesized run order for an edge-less graph', () => {
    const { advisory } = withGraph(['a', { id: 'b', type: 'llm_call' }, 'c']);
    expect(advisory).not.toBeNull();
    /* #878 — the activities are named the way their BOXES are, not by the doc
       ids, which appear nowhere on the canvas. Two `http_request` nodes take
       their ordinals, so the sentence names three distinguishable things. */
    expect(advisory!.textContent).toContain('HTTP Request 1 → LLM Call 1 → HTTP Request 2');
    expect(advisory!.textContent).not.toContain('a → b → c');
  });

  /**
   * The COST, not just the shape. The ticket is not "the canvas looks unrouted",
   * it is that a re-save mints an inferred topology into a version that can never
   * be edited afterwards — so the panel has to name saving, or it is describing a
   * curiosity rather than warning about a consequence.
   */
  it('says what saving will do with the inferred routing', () => {
    expect(withGraph(['a', 'b']).advisory!.textContent).toContain('Saving mints');
  });

  /**
   * The TYPES differ deliberately. `activityLabels` numbers in document order, so
   * a fixture of three same-type activities reads "HTTP Request 1 → 2 → 3" for
   * EVERY array order — an assertion that cannot fail. Distinct kinds put the
   * identity of each position back into the sentence.
   */
  it('reports ARRAY order, not id order — that is what the chain is built from', () => {
    const { advisory } = withGraph([{ id: 'c', type: 'llm_call' }, 'a', 'b']);
    expect(advisory!.textContent).toContain('LLM Call 1 → HTTP Request 1 → HTTP Request 2');
  });

  /**
   * The order is `nodes` ARRAY order, which is the order activities were added —
   * it has nothing to do with where they sit on the canvas. Laying the graph out
   * bottom-to-top makes the two disagree, which is the only way to catch copy
   * that says "in canvas order" (it did, until this test): every other fixture
   * here places nodes in array order, so the two are indistinguishable in them.
   */
  it('reports array order even when the LAYOUT runs the other way', () => {
    const { advisory } = withGraph(['a', 'b', { id: 'c', type: 'llm_call' }], [], [], 'reversed');
    expect(advisory!.textContent).toContain('HTTP Request 1 → HTTP Request 2 → LLM Call 1');
    expect(advisory!.textContent).toContain('the order they were added');
    expect(advisory!.textContent).not.toContain('canvas order');
  });

  it('is absent once the graph authors an edge — nothing is being inferred', () => {
    const { advisory } = withGraph(
      ['a', 'b', 'c'],
      [{ id: 'e1', from: 'a', to: 'c', on: 'success' }],
    );
    expect(advisory).toBeNull();
  });

  it('is absent for a single node — there is no sequence to warn about', () => {
    expect(withGraph(['a']).advisory).toBeNull();
    expect(withGraph([]).advisory).toBeNull();
  });

  /**
   * The advisory has to survive the graph it describes being large, or it stops
   * being an advisory and becomes an occlusion — a panel listing forty ids across
   * the canvas is worse than the silence it replaces.
   */
  it('truncates a long chain rather than covering the canvas with it', () => {
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];
    const { advisory } = withGraph(ids);
    expect(advisory!.textContent).toContain(
      'HTTP Request 1 → HTTP Request 2 → HTTP Request 3 → HTTP Request 4 → HTTP Request 5 → HTTP Request 6',
    );
    expect(advisory!.textContent).not.toContain('HTTP Request 7');
    expect(advisory!.textContent).toContain('+2 more');
  });

  /**
   * Reachable, and the case a naive advisory LIES about. `nodes` is flat, so the
   * synthesized chain crosses the container boundary — and the walk then discards
   * exactly those edges, leaving `a` and the stage as parallel roots. Measured:
   * `topIncoming` is `{a: [], c_1: []}`. So the panel must still appear (routing
   * IS being inferred, which is the thing worth knowing) and must NOT name an
   * order, because the only order it could name is the wrong one.
   */
  it('shows for an edge-less graph with containers, WITHOUT claiming an order', () => {
    const { advisory } = withGraph(['a', 'b'], [], [{ id: 'c_1', kind: 'stage', children: ['b'] }]);
    expect(advisory).not.toBeNull();
    expect(advisory!.textContent).toContain('inferred');
    expect(advisory!.textContent).toContain('Saving mints');
    expect(advisory!.textContent).not.toContain('a → b');
    expect(advisory!.textContent).not.toContain('run in one sequence');
  });

  /**
   * #840 — it names the parallel roots it previously only alluded to.
   *
   * `a` and the stage are the two things that start; `b` is INSIDE the stage and
   * must not be listed beside it, because that is the very "these all run
   * together" reading the partition exists to correct. Both are named by their
   * within-kind ordinal — `activityLabels` for the activity (#878),
   * `containerLabels` for the container — which is the text each one's box
   * carries.
   */
  it('names the parallel roots, and does not list a container’s child among them', () => {
    const { advisory } = withGraph(['a', 'b'], [], [{ id: 'c_1', kind: 'stage', children: ['b'] }]);
    expect(advisory!.textContent).toContain('2 things start in parallel');
    /* #878 — the ACTIVITY root is named the same way the container root already
       was, so the sentence no longer mixes a name with a raw doc id. */
    expect(advisory!.textContent).toContain('HTTP Request 1, stage 1');
    expect(advisory!.textContent).not.toContain('c_1');
  });

  /**
   * #878, the render half — and the half that makes every message above
   * actionable. An advisory naming "HTTP Request 2" is worth nothing if the two
   * rectangles on screen both read "HTTP Request": the operator can read the
   * sentence and still not know which box it means. This is the same cost #883
   * records for the container ordinal, which is NOT drawn; an activity's
   * box label has nowhere else to live, so it is drawn here.
   */
  it('draws the identifying name on the box, not the bare kind', () => {
    const { container } = withGraph(['a', { id: 'b', type: 'llm_call' }, 'c']);
    const titles = [...container.querySelectorAll('.flow-node strong')].map((e) => e.textContent);
    expect(titles).toEqual(['HTTP Request 1', 'LLM Call 1', 'HTTP Request 2']);
  });

  /**
   * ONE root is a real shape, not a corner: dropping the FIRST activity into a
   * container makes the container the only thing that starts, because the
   * synthesized `a → b` now targets a child and is discarded, leaving `b` gated
   * on the stage. The sentence must not read "1 that start in parallel" — that is
   * ungrammatical AND claims a parallelism that is not there.
   */
  it('does not claim parallelism when exactly one thing starts', () => {
    const { advisory } = withGraph(['a', 'b'], [], [{ id: 'c_1', kind: 'stage', children: ['a'] }]);
    expect(advisory!.textContent).toContain('It starts at stage 1.');
    expect(advisory!.textContent).not.toContain('in parallel');
    expect(advisory!.textContent).toContain('Saving mints');
  });

  /**
   * The partitioned arm truncates like the chain arm does, and for the same
   * reason: a panel that names forty roots across the top of the canvas has
   * stopped being an advisory and become an occlusion. Seven empty stages plus
   * the first activity is eight roots — `b` is gated by `a`, every stage is a
   * root because nothing precedes it.
   */
  it('truncates a long root list rather than growing without bound', () => {
    const stages = Array.from({ length: 7 }, (_, i) => ({
      id: `c_${i + 1}`,
      kind: 'stage' as const,
      children: [],
    }));
    const { advisory } = withGraph(['a', 'b'], [], stages);
    expect(advisory!.textContent).toContain('8 things start in parallel');
    expect(advisory!.textContent).toContain('+2 more');
    // The 7th and 8th roots are summarised, not spelled out.
    expect(advisory!.textContent).not.toContain('stage 7');
  });

  /**
   * The page already runs two polite regions (the toolbox's empty-results line
   * and the validation badges) and one assertive one (the refusal). This advisory
   * is none of them: it is a standing description of the graph, and yet another
   * announcer firing on every edge deletion would make the canvas hostile to a
   * screen reader. See the component for the cost that leaves open.
   */
  it('is not a live region — the page already has several', () => {
    const { advisory } = withGraph(['a', 'b']);
    expect(advisory!.getAttribute('aria-live')).toBeNull();
    expect(advisory!.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});
