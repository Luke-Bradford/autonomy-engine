import { describe, expect, it } from 'vitest';
import { MaxBouncesSchema, stableEdgeKey, type Edge, type Node } from '@autonomy-studio/shared';
import {
  branchOptionsFor,
  conditionOf,
  decodeConditionValue,
  edgeAriaLabel,
  edgeLabel,
  edgeVariantClass,
  encodeCondition,
  isMaxBounces,
  OPERATIONAL_CONDITIONS,
  authoringEdgeKey,
  takenConditions,
} from './edgeCondition';

const opEdge = (on: 'success' | 'failure' | 'completion' | 'skipped'): Edge => ({
  id: 'e1',
  from: 'a',
  to: 'b',
  on,
});
const branchEdge = (branch: string): Edge => ({
  id: 'e1',
  from: 'a',
  to: 'b',
  on: 'branch',
  branch,
});
const node = (id: string, type: string, config: Record<string, unknown> = {}): Node => ({
  id,
  type,
  config,
  position: { x: 0, y: 0 },
});

describe('edgeLabel', () => {
  it('labels an operational edge by its outcome', () => {
    expect(edgeLabel(opEdge('success'))).toBe('success');
    expect(edgeLabel(opEdge('skipped'))).toBe('skipped');
  });

  /**
   * The U19 debt this ticket discharges: `label: e.on` rendered every branch
   * edge as the literal string "branch", dropping the `true`/`false`/case key
   * that IS its routing decision — so a two-armed `if` showed two identical
   * labels and the canvas could not say which arm went where.
   */
  it('labels a branch edge by its ROUTING KEY, not the literal "branch"', () => {
    expect(edgeLabel(branchEdge('true'))).toBe('true');
    expect(edgeLabel(branchEdge('needs-changes'))).toBe('needs-changes');
    expect(edgeLabel(branchEdge('true'))).not.toBe('branch');
  });
});

describe('edgeVariantClass', () => {
  it('gives each condition its own variant class', () => {
    const classes = [
      edgeVariantClass(opEdge('success')),
      edgeVariantClass(opEdge('failure')),
      edgeVariantClass(opEdge('completion')),
      edgeVariantClass(opEdge('skipped')),
      edgeVariantClass(branchEdge('true')),
    ];
    expect(new Set(classes).size).toBe(5);
  });

  /** Every branch arm shares ONE neutral hue — the label distinguishes them. */
  it('gives every branch arm the same class regardless of routing key', () => {
    expect(edgeVariantClass(branchEdge('true'))).toBe(edgeVariantClass(branchEdge('false')));
  });

  it('names the class after the condition so the CSS rule cannot drift', () => {
    expect(edgeVariantClass(opEdge('failure'))).toBe('edge-variant-failure');
    expect(edgeVariantClass(branchEdge('false'))).toBe('edge-variant-branch');
  });
});

/**
 * React Flow renders an edge as `role="img"` (or `group` when focusable) with
 * `aria-label` defaulting to `Edge from X to Y` — under either role the SVG
 * `<text>` label is NOT exposed. So without this, colour is the only channel
 * carrying the outcome, which the epic's "non-color status labels" criterion
 * forbids.
 */
describe('edgeAriaLabel', () => {
  it('names the endpoints AND the outcome', () => {
    expect(edgeAriaLabel(opEdge('failure'))).toBe('Edge from a to b, on failure');
  });

  it('names a branch edge by its routing key, marked as a branch', () => {
    expect(edgeAriaLabel(branchEdge('true'))).toBe("Edge from a to b, on branch 'true'");
  });
});

describe('condition encode/decode', () => {
  /**
   * A `switch` case label is an arbitrary string — `validateSwitchConfig`
   * reserves only `default` — so `cases: ['success']` is a legal doc. Untagged
   * option values would then emit two `<option value="success">`, one meaning
   * `{on:'success'}` and one meaning `{on:'branch',branch:'success'}`, and the
   * change handler could not tell them apart: picking the business branch would
   * silently author the operational outcome.
   */
  it('keeps an operational value distinct from a branch label that collides with it', () => {
    const op = encodeCondition({ on: 'success' });
    const br = encodeCondition({ on: 'branch', branch: 'success' });
    expect(op).not.toBe(br);
    expect(decodeConditionValue(op)).toEqual({ on: 'success' });
    expect(decodeConditionValue(br)).toEqual({ on: 'branch', branch: 'success' });
  });

  it('round-trips every operational condition', () => {
    for (const on of OPERATIONAL_CONDITIONS) {
      expect(decodeConditionValue(encodeCondition({ on }))).toEqual({ on });
    }
  });

  /** A case label may contain the delimiter; only the FIRST one splits. */
  it('round-trips a branch label containing the tag delimiter', () => {
    const c = { on: 'branch', branch: 'a:b:c' } as const;
    expect(decodeConditionValue(encodeCondition(c))).toEqual(c);
  });

  it('refuses a value that is not a tagged condition', () => {
    expect(decodeConditionValue('success')).toBeNull();
    expect(decodeConditionValue('')).toBeNull();
    expect(decodeConditionValue('op:not-an-outcome')).toBeNull();
    expect(decodeConditionValue('branch:')).toBeNull();
  });

  it('reads the condition back off an edge', () => {
    expect(conditionOf(opEdge('completion'))).toEqual({ on: 'completion' });
    expect(conditionOf(branchEdge('false'))).toEqual({ on: 'branch', branch: 'false' });
  });
});

describe('takenConditions', () => {
  const subject: Edge = { id: 'e1', from: 'a', to: 'b', on: 'success' };

  it('reports the conditions other edges between the same pair hold', () => {
    const taken = takenConditions(
      [subject, { id: 'e2', from: 'a', to: 'b', on: 'failure' }],
      subject,
    );
    expect([...taken]).toEqual(['op:failure']);
  });

  it('never reports the edge’s OWN condition — a no-op retype is not a collision', () => {
    expect([...takenConditions([subject], subject)]).toEqual([]);
  });

  it('ignores an identically-conditioned edge between a DIFFERENT pair', () => {
    const taken = takenConditions(
      [subject, { id: 'e2', from: 'a', to: 'c', on: 'failure' }],
      subject,
    );
    expect([...taken]).toEqual([]);
  });

  it('reports a branch arm by its routing key', () => {
    const taken = takenConditions(
      [subject, { id: 'e2', from: 'a', to: 'b', on: 'branch', branch: 'true' }],
      subject,
    );
    expect([...taken]).toEqual(['branch:true']);
  });

  /**
   * The engine excludes `back` from `stableEdgeKey` safely, because it only ever
   * keys BACK edges by it. A forward edge and a back edge sharing
   * `(from, to, on, branch)` are two distinct, unambiguously runnable edges — so
   * the AUTHORING key adds `back`, and refusing to author them would refuse
   * something legal.
   */
  it('does NOT treat a back-edge as taking a forward edge’s condition', () => {
    const backEdge: Edge = {
      id: 'e2',
      from: 'a',
      to: 'b',
      on: 'failure',
      back: true,
      maxBounces: 3,
    };
    expect([...takenConditions([subject, backEdge], subject)]).toEqual([]);
  });

  /**
   * ANTI-DRIFT with the engine. The authoring key IS `stableEdgeKey` plus
   * `back`, so for edges that agree on `back` the two must agree exactly — a
   * change to the engine's edge identity must not silently leave the picker
   * disabling the wrong options.
   */
  it('agrees with the engine’s stableEdgeKey whenever `back` matches', () => {
    const pairs: Array<[Edge, Edge]> = [
      [
        { id: 'x', from: 'a', to: 'b', on: 'success' },
        { id: 'y', from: 'a', to: 'b', on: 'success' },
      ],
      [
        { id: 'x', from: 'a', to: 'b', on: 'branch', branch: 'true' },
        { id: 'y', from: 'a', to: 'b', on: 'branch', branch: 'false' },
      ],
      [
        { id: 'x', from: 'a', to: 'b', on: 'success' },
        { id: 'y', from: 'a', to: 'c', on: 'success' },
      ],
    ];
    for (const [p, q] of pairs) {
      expect(authoringEdgeKey(p) === authoringEdgeKey(q)).toBe(
        stableEdgeKey(p) === stableEdgeKey(q),
      );
    }
  });
});

describe('branchOptionsFor', () => {
  it('offers an `if`s two arms in a stable order', () => {
    expect(branchOptionsFor(node('n1', 'if'))).toEqual(['true', 'false']);
  });

  /**
   * CONFIG order, not sorted: the list mirrors the author's own `cases` array,
   * so the picker reads in the same order as the config they just edited.
   * `default` comes last because it is the implicit fallthrough, not a case.
   */
  it('offers a `switch`s configured cases plus the implicit default, in config order', () => {
    expect(branchOptionsFor(node('n1', 'switch', { cases: ['b', 'a'] }))).toEqual([
      'b',
      'a',
      'default',
    ]);
  });

  /**
   * `undefined` ("this source can never emit a branch") is NOT the empty set
   * ("it branches, but declares nothing"): the first must hide the branch
   * group, the second must show it empty. Collapsing them would offer a branch
   * group on an `http_request`.
   */
  it('returns null for a source that is not a branching activity', () => {
    expect(branchOptionsFor(node('n1', 'http_request'))).toBeNull();
  });

  /** An edge whose source was deleted, or is a CONTAINER id (a legal edge
   * endpoint), has no `Node` to ask — degrade, never throw. */
  it('returns null for an absent source node', () => {
    expect(branchOptionsFor(undefined)).toBeNull();
  });
});

/**
 * U6e — a back-edge is the one edge whose DIRECTION contradicts its arrowhead:
 * it points at a step that already ran. Both labels have to say so, because the
 * canvas encodes it in no other channel (no hue, no dash — see `FlowCanvas`).
 */
describe('back-edge labelling', () => {
  const back = (extra: Partial<Edge> = {}): Edge =>
    ({ id: 'e', from: 'b', to: 'a', on: 'success', back: true, maxBounces: 3, ...extra }) as Edge;

  it('marks back-ness and the cap in the visual label', () => {
    expect(edgeLabel(back())).toBe('↺ success ×3');
  });

  it('keeps the branch key as the label for a back-edge off a branching node', () => {
    expect(edgeLabel(back({ on: 'branch', branch: 'retry' }))).toBe('↺ retry ×3');
  });

  it('leaves a forward edge untouched', () => {
    expect(edgeLabel({ id: 'e', from: 'a', to: 'b', on: 'success' } as Edge)).toBe('success');
  });

  /**
   * The `↺ … ×N` glyph is not readable text, and RF does not expose the SVG
   * label under its own role anyway — so the aria-label is the ONLY place a
   * screen reader learns this edge loops, and how far.
   */
  it('spells back-ness and the cap in the aria-label', () => {
    expect(edgeAriaLabel(back())).toBe('Edge from b to a, back-edge on success, up to 3 bounces');
  });

  it.each([
    [0, true],
    [1, true],
    [10_000, true],
    [-1, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    // Beyond zod's safe-integer ceiling: accepted by a hand-rolled
    // `Number.isInteger(n) && n >= 0`, refused by the schema.
    [1e16, false],
  ])('isMaxBounces(%p) is %p, mirroring EdgeSchema', (n, expected) => {
    expect(isMaxBounces(n)).toBe(expected);
  });
});

/**
 * A back-edge with NO cap — reachable only for an imported or API-authored doc,
 * since the canvas always sets one, and refused by the save gate. Both labels
 * must report it as missing rather than inventing a value: `0` is a real and
 * DIFFERENT behaviour (an edge that never bounces), so defaulting to it would
 * state a specific cap for a doc that declares none — and would tell a screen
 * reader something the canvas does not show.
 */
describe('a back-edge with no declared cap', () => {
  const capless = { id: 'e', from: 'b', to: 'a', on: 'success', back: true } as Edge;

  it('shows the cap as unknown rather than as zero', () => {
    expect(edgeLabel(capless)).toBe('↺ success ×?');
  });

  it('says so in the aria-label, in the same terms', () => {
    expect(edgeAriaLabel(capless)).toBe(
      'Edge from b to a, back-edge on success, no bounce cap declared',
    );
  });

  it('a declared cap of ZERO is reported as the real value it is', () => {
    const zero = { ...capless, maxBounces: 0 } as Edge;
    expect(edgeLabel(zero)).toBe('↺ success ×0');
    expect(edgeAriaLabel(zero)).toBe('Edge from b to a, back-edge on success, up to 0 bounces');
  });

  /**
   * The SSOT tie: `isMaxBounces` delegates to the schema rather than restating
   * it, so a tightening of the format cannot leave this editor accepting a
   * value the write gate refuses.
   */
  it('isMaxBounces IS MaxBouncesSchema, not a second opinion about it', () => {
    for (const n of [0, 1, 3.5, -1, 10_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isMaxBounces(n)).toBe(MaxBouncesSchema.safeParse(n).success);
    }
  });
});
