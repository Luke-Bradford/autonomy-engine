import { describe, expect, it } from 'vitest';
import type { Container } from '@autonomy-studio/shared';
import {
  CANVAS_CHROME_INSET,
  CONTAINER_GAP,
  CONTAINER_HEADER_HEIGHT,
  CONTAINER_PADDING,
  EMPTY_CONTAINER_SIZE,
  REVEAL_MARGIN,
  appearedIds,
  containerRects,
  emptyContainerIds,
  liveNodeRects,
  revealTransform,
  containerHandles,
  usableExtent,
  type Rect,
} from './containerLayout';
import type { NodeHandle } from '@xyflow/react';
import { encodeCondition, HANDLE_SIZE, sourcePortOffset } from './ports';

function rect(x: number, y: number, width = 150, height = 50): Rect {
  return { x, y, width, height };
}
function stage(id: string, children: string[]): Container {
  return { id, kind: 'stage', children };
}

describe('containerRects — the box a container is drawn as', () => {
  it('encloses its children, with padding and room for the header', () => {
    const nodes = new Map([
      ['a', rect(100, 100)],
      ['b', rect(300, 220)],
    ]);
    const box = containerRects([stage('s', ['a', 'b'])], nodes).get('s');
    expect(box).toBeDefined();
    // Left/top back off by the padding, and the top by the header band as well,
    // so the label never sits on top of the highest child.
    expect(box!.x).toBe(100 - CONTAINER_PADDING);
    expect(box!.y).toBe(100 - CONTAINER_PADDING - CONTAINER_HEADER_HEIGHT);
    // Right/bottom clear the furthest child by the same padding.
    expect(box!.x + box!.width).toBe(300 + 150 + CONTAINER_PADDING);
    expect(box!.y + box!.height).toBe(220 + 50 + CONTAINER_PADDING);
  });

  it('encloses a single child just the same', () => {
    const nodes = new Map([['a', rect(0, 0, 120, 40)]]);
    const box = containerRects([stage('s', ['a'])], nodes).get('s')!;
    expect(box.x).toBe(-CONTAINER_PADDING);
    expect(box.width).toBe(120 + 2 * CONTAINER_PADDING);
    expect(box.height).toBe(40 + 2 * CONTAINER_PADDING + CONTAINER_HEADER_HEIGHT);
  });

  /**
   * FIRST-declared-wins, delegated to `containerMembership` — the same SSOT the
   * reducer and the save gate resolve ownership with (#492). Drawing a
   * doubly-listed child inside BOTH boxes would put the canvas in a third
   * position no other part of the system holds.
   */
  it('draws a doubly-listed child in the FIRST container only', () => {
    const nodes = new Map([
      ['a', rect(100, 100)],
      ['b', rect(600, 100)],
    ]);
    const boxes = containerRects([stage('s', ['a']), stage('t', ['a', 'b'])], nodes);
    // 's' owns 'a', so 't' is sized from 'b' alone and does not stretch back to it.
    expect(boxes.get('s')!.x).toBe(100 - CONTAINER_PADDING);
    expect(boxes.get('t')!.x).toBe(600 - CONTAINER_PADDING);
  });

  /**
   * A child id with no node is an invalid doc the gate already reports
   * ("is not a node in this pipeline"). The canvas still has to draw the
   * container, so the phantom is skipped rather than being allowed to poison the
   * arithmetic.
   */
  it('ignores a child id that is not on the canvas', () => {
    const nodes = new Map([['a', rect(100, 100)]]);
    const box = containerRects([stage('s', ['a', 'ghost'])], nodes).get('s')!;
    expect(box.x).toBe(100 - CONTAINER_PADDING);
    expect(Number.isFinite(box.width)).toBe(true);
    expect(box.width).toBe(150 + 2 * CONTAINER_PADDING);
  });

  describe('a container with no drawable children', () => {
    /**
     * An empty `stage` is a VALID doc — only `loop` and `foreach` carry a
     * zero-child refusal — and a container is a legal EDGE ENDPOINT, so declining
     * to render one would silently drop its edges (the very defect U6c fixes).
     * It therefore gets a real box. The arithmetic must be explicit: a min/max
     * over no children yields ±Infinity, which as an RF node position renders
     * garbage.
     */
    it('gets a finite fallback box placed clear of the graph', () => {
      const nodes = new Map([
        ['a', rect(0, 0)],
        ['b', rect(300, 400)],
      ]);
      const box = containerRects([stage('empty', [])], nodes).get('empty')!;
      expect(Number.isFinite(box.x)).toBe(true);
      expect(Number.isFinite(box.y)).toBe(true);
      expect(box.width).toBe(EMPTY_CONTAINER_SIZE.width);
      expect(box.height).toBe(EMPTY_CONTAINER_SIZE.height);
      // Clear of every node: it starts to the RIGHT of the content bounds.
      expect(box.x).toBeGreaterThanOrEqual(300 + 150 + CONTAINER_GAP);
    });

    it('stacks two empty containers instead of overlapping them', () => {
      const nodes = new Map([['a', rect(0, 0)]]);
      const boxes = containerRects([stage('e1', []), stage('e2', [])], nodes);
      const one = boxes.get('e1')!;
      const two = boxes.get('e2')!;
      expect(two.y).toBeGreaterThanOrEqual(one.y + one.height);
      expect(one.x).toBe(two.x);
    });

    it('is deterministic — the same input twice gives the same box', () => {
      const nodes = new Map([['a', rect(10, 20)]]);
      const once = containerRects([stage('e', [])], nodes).get('e')!;
      const twice = containerRects([stage('e', [])], nodes).get('e')!;
      expect(once).toEqual(twice);
    });

    it('places one on an EMPTY canvas without producing NaN', () => {
      const box = containerRects([stage('e', [])], new Map()).get('e')!;
      expect(Number.isNaN(box.x)).toBe(false);
      expect(Number.isNaN(box.y)).toBe(false);
      expect(Number.isFinite(box.width)).toBe(true);
    });

    it('counts a container whose only children are phantoms as empty', () => {
      const nodes = new Map([['a', rect(0, 0)]]);
      const box = containerRects([stage('s', ['ghost'])], nodes).get('s')!;
      expect(box.width).toBe(EMPTY_CONTAINER_SIZE.width);
    });
  });

  it('returns a box for every container, in document order', () => {
    const nodes = new Map([['a', rect(0, 0)]]);
    const boxes = containerRects([stage('s', ['a']), stage('t', [])], nodes);
    expect([...boxes.keys()]).toEqual(['s', 't']);
  });

  /**
   * `childCount` counts what the box is DRAWN from, never `children.length`.
   *
   * The box and the accessible label are two statements about the same thing, so
   * they have to come from one set. Taken from the raw array they disagree exactly
   * when it matters: an empty fallback box announcing "2 activities" tells a
   * screen-reader user the opposite of what a sighted one sees.
   */
  describe('childCount — what the box announces', () => {
    it('counts the children it actually encloses', () => {
      const nodes = new Map([
        ['a', rect(0, 0)],
        ['b', rect(200, 0)],
      ]);
      expect(containerRects([stage('s', ['a', 'b'])], nodes).get('s')!.childCount).toBe(2);
    });

    it('does NOT count a phantom child, which is not in the box', () => {
      const nodes = new Map([['a', rect(0, 0)]]);
      expect(containerRects([stage('s', ['a', 'ghost'])], nodes).get('s')!.childCount).toBe(1);
    });

    it('reports zero for a container whose every child is a phantom', () => {
      const nodes = new Map([['other', rect(0, 0)]]);
      const box = containerRects([stage('s', ['gone', 'also_gone'])], nodes).get('s')!;
      // The box is the empty FALLBACK here, so a count of 2 would caption an
      // empty box with the children it no longer draws.
      expect(box.width).toBe(EMPTY_CONTAINER_SIZE.width);
      expect(box.childCount).toBe(0);
    });

    it('does NOT count a child a FIRST-wins earlier container already claimed', () => {
      const nodes = new Map([
        ['a', rect(0, 0)],
        ['b', rect(400, 0)],
      ]);
      const boxes = containerRects([stage('s', ['a']), stage('t', ['a', 'b'])], nodes);
      expect(boxes.get('s')!.childCount).toBe(1);
      // 't' lists two children and draws one: 'a' belongs to 's'.
      expect(boxes.get('t')!.childCount).toBe(1);
    });
  });
});

/**
 * #785 — the pan that makes an emptied box reachable.
 *
 * `containerRects` puts a box it cannot derive a size from OUTSIDE the content
 * bounds, and a fitted viewport ends flush WITH those bounds, so the box lands
 * reliably just off-screen and `onlyRenderVisibleElements` culls it out of the
 * DOM entirely. Since the box carries the container's only delete control, the
 * escape from an emptied container was unreachable without a pan the operator
 * was never told to make.
 *
 * The geometry stays where it is — moving the fallback INSIDE the content bounds
 * would draw the box over activities it does not contain, which is exactly the
 * lie this module's header comment exists to avoid. The viewport moves instead.
 */
describe('revealTransform — the minimum pan that brings a box on screen', () => {
  const W = 1000;
  const H = 600;
  /** Flow (0,0) at screen (0,0), unscaled: screen coords == flow coords. */
  const IDENTITY = [0, 0, 1] as const;

  it('returns null when the box is already fully inside the viewport', () => {
    expect(revealTransform([rect(100, 100)], IDENTITY, W, H)).toBeNull();
  });

  it('returns null for no boxes at all', () => {
    expect(revealTransform([], IDENTITY, W, H)).toBeNull();
  });

  /**
   * Visible is visible. The margin governs where a box LANDS once a pan is
   * warranted, not whether one is warranted — a box flush against the edge is
   * readable and clickable, so nudging it would be movement the operator did not
   * ask for and cannot explain.
   */
  it('returns null for a box flush against the edge, rather than nudging it clear', () => {
    expect(revealTransform([rect(0, 0, W, H)], IDENTITY, W, H)).toBeNull();
  });

  /**
   * React Flow reports 0x0 until it has measured the pane. "Nothing is visible"
   * and "I cannot tell what is visible" are different answers, and panning
   * against an unmeasured viewport would fling the canvas somewhere arbitrary on
   * first paint. The caller's effect re-runs when the measurement lands.
   */
  it('refuses to pan against an unmeasured viewport', () => {
    const off = [rect(9000, 9000, 220, 120)];
    expect(revealTransform(off, IDENTITY, 0, 0)).toBeNull();
    expect(revealTransform(off, IDENTITY, W, 0)).toBeNull();
  });

  it('pans LEFT by exactly the right-edge overflow plus the margin', () => {
    const next = revealTransform([rect(1200, 100, 220, 120)], IDENTITY, W, H);
    // right edge 1420 has to reach 1000 - 24 = 976, so dx = -444.
    expect(next).toEqual({ x: W - REVEAL_MARGIN - 1420, y: 0, zoom: 1 });
  });

  it('pans RIGHT until the left edge reaches the margin', () => {
    const next = revealTransform([rect(-300, 100, 220, 120)], IDENTITY, W, H);
    expect(next).toEqual({ x: REVEAL_MARGIN + 300, y: 0, zoom: 1 });
  });

  it('pans UP by exactly the bottom-edge overflow plus the margin', () => {
    const next = revealTransform([rect(100, 800, 220, 120)], IDENTITY, W, H);
    // bottom edge 920 has to reach 600 - 24 = 576, so dy = -344.
    expect(next).toEqual({ x: 0, y: H - REVEAL_MARGIN - 920, zoom: 1 });
  });

  it('pans DOWN until the top edge reaches the margin', () => {
    const next = revealTransform([rect(100, -100, 220, 120)], IDENTITY, W, H);
    expect(next).toEqual({ x: 0, y: REVEAL_MARGIN + 100, zoom: 1 });
  });

  it('pans on BOTH axes at once', () => {
    const next = revealTransform([rect(1200, 800, 220, 120)], IDENTITY, W, H);
    expect(next).toEqual({
      x: W - REVEAL_MARGIN - 1420,
      y: H - REVEAL_MARGIN - 920,
      zoom: 1,
    });
  });

  it('adds to the CURRENT transform rather than replacing it', () => {
    // Already panned: flow x=1200 is at screen 700, which is in view; flow
    // y=800 is at screen 600, which is not.
    const next = revealTransform([rect(1200, 800, 220, 120)], [-500, -200, 1], W, H);
    expect(next).toEqual({ x: -500, y: -200 + (H - REVEAL_MARGIN - 720), zoom: 1 });
  });

  it('measures the box in SCREEN space, so zoom scales both position and size', () => {
    const next = revealTransform([rect(600, 100, 220, 120)], [0, 0, 2], W, H);
    // At zoom 2 the box occupies screen 1200..1640. Getting 1640 to 976 needs
    // dx = -664 — a value only reachable if BOTH the position and the size were
    // scaled. Ignoring either gives -64 or -444.
    expect(next).toEqual({ x: -664, y: 0, zoom: 2 });
  });

  it('never changes the zoom, only the translation', () => {
    const next = revealTransform([rect(1200, 100, 220, 120)], [0, 0, 1.75], W, H);
    expect(next!.zoom).toBe(1.75);
  });

  it('reveals the UNION when several boxes appear at once', () => {
    const next = revealTransform(
      [rect(1200, 100, 220, 120), rect(1400, 300, 220, 120)],
      IDENTITY,
      W,
      H,
    );
    // The union's right edge is 1620, not the first box's 1420.
    expect(next).toEqual({ x: W - REVEAL_MARGIN - 1620, y: 0, zoom: 1 });
  });

  /**
   * The over-sized cases decide WHICH edge wins, and the answer is the same on
   * both axes: the TOP-LEFT corner. The header band carries the delete control
   * (`CONTAINER_HEADER_HEIGHT` is added to the TOP padding only), so a box too
   * tall to fit must be clipped at the BOTTOM — clipping the top would hide the
   * very control the reveal exists to expose.
   */
  it('aligns the LEFT edge to the margin when the union is wider than the viewport', () => {
    const next = revealTransform([rect(1200, 100, 2000, 120)], IDENTITY, W, H);
    expect(next).toEqual({ x: REVEAL_MARGIN - 1200, y: 0, zoom: 1 });
  });

  it('aligns the TOP edge to the margin when the union is taller than the viewport', () => {
    const next = revealTransform([rect(100, 900, 220, 2000)], IDENTITY, W, H);
    expect(next).toEqual({ x: 0, y: REVEAL_MARGIN - 900, zoom: 1 });
  });
});

/**
 * `liveNodeRects` — the canvas holds nodes twice, and one copy is a render stale.
 *
 * A store mutation lands one render before the reconcile effect rebuilds React
 * Flow's view array, so for that render the view still carries a node the doc has
 * dropped. The empty-container FALLBACK is placed relative to the union of all
 * node rects, so a phantom in that union puts the box somewhere it will not
 * settle — and the #785 reveal reads that position exactly once, in exactly that
 * render, and is never re-run to correct it.
 */
describe('liveNodeRects — dropping a view node the doc no longer has', () => {
  it('keeps the rects the doc still has', () => {
    const view = new Map([
      ['a', rect(0, 0)],
      ['b', rect(200, 0)],
    ]);
    const live = liveNodeRects(view, new Set(['a', 'b']));
    expect([...live.keys()]).toEqual(['a', 'b']);
    expect(live.get('a')).toEqual(rect(0, 0));
  });

  it('drops a rect for a node the doc has dropped', () => {
    const view = new Map([
      ['a', rect(0, 0)],
      ['gone', rect(200, 0)],
    ]);
    expect([...liveNodeRects(view, new Set(['a'])).keys()]).toEqual(['a']);
  });

  it('does not mutate the map it was given', () => {
    const view = new Map([['gone', rect(0, 0)]]);
    liveNodeRects(view, new Set());
    expect(view.size).toBe(1);
  });

  /**
   * The failure this exists to stop, composed end to end.
   *
   * `child` is the graph's rightmost node and the container's only member. The
   * render in which it is deleted from the doc still has it in the view array, so
   * WITHOUT the filter the emptied box is placed clear of `child`'s old position
   * — thousands of pixels from where the next render puts it, which is where the
   * reveal pans to and then never corrects.
   */
  it('places an emptied box clear of the LIVE content, not of a phantom', () => {
    const view = new Map([
      ['keep', rect(0, 0)],
      ['child', rect(2000, 0)],
    ]);
    const doc = new Set(['keep']);
    const box = containerRects([stage('c_1', [])], liveNodeRects(view, doc)).get('c_1')!;
    expect(box.x).toBe(150 + CONTAINER_GAP);
    // What the phantom would have produced, stated so the test names the defect.
    expect(box.x).not.toBe(2000 + 150 + CONTAINER_GAP);
    // And it is the position the NEXT render settles on, so the box never jumps.
    const settled = containerRects([stage('c_1', [])], new Map([['keep', rect(0, 0)]])).get('c_1')!;
    expect(box).toEqual(settled);
  });
});

/**
 * The reveal's TRIGGER, extracted from the effect so it can be tested.
 *
 * Both bugs the pre-PR review caught were in that effect, and jsdom cannot help:
 * React Flow reports a 0x0 pane until its ResizeObserver runs, so a mounted "did
 * it pan" test would be vacuous by construction. Keeping the decisions pure moves
 * them somewhere a test can reach.
 */
describe('the reveal trigger', () => {
  function box(childCount: number) {
    return { x: 0, y: 0, width: 220, height: 120, childCount };
  }

  describe('emptyContainerIds', () => {
    it('names the containers drawn as the empty fallback, and only those', () => {
      const boxes = new Map([
        ['full', box(2)],
        ['empty', box(0)],
        ['one', box(1)],
      ]);
      expect([...emptyContainerIds(boxes)]).toEqual(['empty']);
    });

    it('is empty when there are no containers at all', () => {
      expect(emptyContainerIds(new Map()).size).toBe(0);
    });
  });

  describe('appearedIds', () => {
    /* The mount case. A container empty from LOAD was framed by React Flow's
       `fitView`, which fits every rendered node including the box; calling that
       an appearance would pan the canvas on every page load. */
    it('reports NOTHING on the first observation, however many are empty', () => {
      expect(appearedIds(null, new Set(['a', 'b']))).toEqual([]);
    });

    it('reports an id that has just become empty', () => {
      expect(appearedIds(new Set(['a']), new Set(['a', 'b']))).toEqual(['b']);
    });

    it('reports nothing when the set has not changed', () => {
      expect(appearedIds(new Set(['a']), new Set(['a']))).toEqual([]);
    });

    /* A container that was deleted, or that gained a child, LEFT the set. That is
       not a transition into emptiness and must not pan anything. */
    it('ignores an id that has left the set', () => {
      expect(appearedIds(new Set(['a', 'b']), new Set(['a']))).toEqual([]);
    });

    it('reports several at once when one delete empties more than one', () => {
      expect(appearedIds(new Set(), new Set(['a', 'b']))).toEqual(['a', 'b']);
    });
  });

  describe('usableExtent', () => {
    /* The MiniMap and Controls are drawn INSIDE the pane with `pointer-events:
       all`. A box landed flush against the bottom-right would be revealed with
       its delete control — top-right of the box — underneath the minimap: still
       unclickable, which is #785's trap intact. */
    it('excludes the strips canvas chrome is drawn over', () => {
      expect(usableExtent(1400, 900)).toEqual({
        width: 1400 - CANVAS_CHROME_INSET.right,
        height: 900 - CANVAS_CHROME_INSET.bottom,
      });
    });

    it('yields to the reveal on a pane too small to inset, keeping half of each axis', () => {
      // 300 - 215 = 85px of usable width could not hold a 220px box at all, and
      // `revealTransform` would then pan it somewhere useless. A partly-covered
      // box beats an invisible one.
      expect(usableExtent(300, 200)).toEqual({ width: 150, height: 100 });
    });

    it('never returns a negative extent, even for a pane smaller than the chrome', () => {
      const { width, height } = usableExtent(40, 30);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);
    });
  });
});

/**
 * #1066 — a container's STATED port bounds, in both fan states.
 *
 * Untested until now, and it is the one piece of geometry in this file with no
 * second opinion anywhere. An activity's handle positions are MEASURED from the
 * DOM, so a mistake there is self-correcting the moment React Flow re-measures;
 * a container's are taken verbatim by `parseHandles` and RF resets a derived
 * node to unmeasured on every render, so whatever this function says is where
 * every container edge attaches, forever. The e2e proves the gesture; these pin
 * the arithmetic the gesture rests on.
 */
describe('containerHandles — the stated port bounds of a derived box', () => {
  const ports = (['success', 'failure', 'completion', 'skipped'] as const).map((on) => ({
    id: encodeCondition({ on }),
    label: on,
    condition: { on } as const,
    orphaned: false,
  }));
  /* The vertical CENTRE of a stated handle, in the same units React Flow reads
     it in. `NodeHandle` types every dimension as optional, so a handle that
     stated no geometry at all would silently centre on zero — `?? NaN` makes
     that arrive as a failed assertion instead of as a plausible number. */
  const centreOf = (h: NodeHandle) => (h.y ?? NaN) + (h.height ?? NaN) / 2;
  const sources = (fanned: boolean) =>
    containerHandles(200, 300, ports, fanned).filter((h) => h.type === 'source');

  it('collapses every source port onto the box MIDDLE at rest', () => {
    const centres = sources(false).map(centreOf);
    expect(centres).toHaveLength(ports.length);
    /* ONE point, and it is the middle — not merely "all equal". An off-centre
       stack would still read as one point while every edge left the box at the
       wrong height, which is invisible until compared against the fanned case. */
    for (const centre of centres) expect(centre).toBe(300 / 2);
  });

  it('fans them to the SAME offsets the rendered dot uses', () => {
    /* Against `sourcePortOffset` rather than against copied numbers: the whole
       reason the offset is a shared function is that a container's stated `y`
       and the stylesheet's `--port-offset` must not be two opinions. Restating
       the arithmetic here would pass for a formula that had drifted. */
    expect(sources(true).map(centreOf)).toEqual(
      ports.map((_, i) => 300 / 2 + sourcePortOffset(i, ports.length)),
    );
  });

  it('leaves the TARGET port alone in both states', () => {
    /* Only the outgoing column fans. A target that moved with it would drag
       every INCOMING edge to a new height for the duration of a hover — and
       nothing in the ticket, the CSS or the e2e would notice, because they all
       watch the source side. */
    const target = (fanned: boolean) =>
      containerHandles(200, 300, ports, fanned).find((h) => h.type === 'target')!;
    expect(centreOf(target(false))).toBe(300 / 2);
    expect(target(true)).toEqual(target(false));
  });

  it('keeps every port on its own edge, whatever the fan is doing', () => {
    for (const fanned of [false, true]) {
      const handles = containerHandles(200, 300, ports, fanned);
      for (const h of handles) {
        // The dot is centred ON the border, so its box starts half a dot outside.
        expect(h.x).toBe(h.type === 'target' ? -HANDLE_SIZE / 2 : 200 - HANDLE_SIZE / 2);
      }
    }
  });
});
