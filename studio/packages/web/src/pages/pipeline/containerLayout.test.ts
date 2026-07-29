import { describe, expect, it } from 'vitest';
import type { Container } from '@autonomy-studio/shared';
import {
  CONTAINER_GAP,
  CONTAINER_HEADER_HEIGHT,
  CONTAINER_PADDING,
  EMPTY_CONTAINER_SIZE,
  containerRects,
  type Rect,
} from './containerLayout';

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
