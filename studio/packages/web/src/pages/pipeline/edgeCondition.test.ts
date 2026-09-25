import { describe, expect, it } from 'vitest';
import { MaxBouncesSchema, stableEdgeKey, type Edge } from '@autonomy-studio/shared';
import {
  conditionOf,
  decodeConditionValue,
  edgeAriaLabel,
  edgeLabel,
  edgeVariantClass,
  encodeCondition,
  isMaxBounces,
  OPERATIONAL_CONDITIONS,
  authoringEdgeKey,
  completionSibling,
  overlappingOutcomes,
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
    expect(taken.get('op:failure')).toBe('already used by another edge');
  });

  it('never reports the edge’s OWN condition — a no-op retype is not a collision', () => {
    expect([...takenConditions([subject], subject).keys()]).toEqual([]);
  });

  it('ignores an identically-conditioned edge between a DIFFERENT pair', () => {
    const taken = takenConditions(
      [subject, { id: 'e2', from: 'a', to: 'c', on: 'failure' }],
      subject,
    );
    expect([...taken.keys()]).toEqual([]);
  });

  it('reports a branch arm by its routing key', () => {
    const taken = takenConditions(
      [subject, { id: 'e2', from: 'a', to: 'b', on: 'branch', branch: 'true' }],
      subject,
    );
    expect([...taken.keys()]).toEqual(['branch:true']);
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
    expect([...takenConditions([subject, backEdge], subject).keys()]).toEqual([]);
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

/**
 * #1064 — one intent, one edge. `success` + `failure` between the same two
 * activities IS `completion` (the reducer ORs edges from one predecessor), so
 * a candidate that re-states an outcome the pair already routes on is refused.
 */
describe('overlappingOutcomes', () => {
  const held = (...ons: Array<'success' | 'failure' | 'completion' | 'skipped'>) => new Set(ons);

  it('refuses success or failure beside a completion edge', () => {
    expect(overlappingOutcomes(held('completion'), { on: 'success' })).toEqual(['completion']);
    expect(overlappingOutcomes(held('completion'), { on: 'failure' })).toEqual(['completion']);
  });

  it('refuses completion beside success, failure, or both — naming each', () => {
    expect(overlappingOutcomes(held('success'), { on: 'completion' })).toEqual(['success']);
    expect(overlappingOutcomes(held('failure'), { on: 'completion' })).toEqual(['failure']);
    expect(overlappingOutcomes(held('success', 'failure'), { on: 'completion' })).toEqual([
      'success',
      'failure',
    ]);
  });

  it('leaves success + failure legal — each is a narrower intent', () => {
    expect(overlappingOutcomes(held('success'), { on: 'failure' })).toEqual([]);
    expect(overlappingOutcomes(held('failure'), { on: 'success' })).toEqual([]);
  });

  /** A skip is NOT a completion (`EdgeOnSchema`), so it overlaps nothing. */
  it('never involves skipped, in either direction', () => {
    expect(
      overlappingOutcomes(held('success', 'failure', 'completion'), { on: 'skipped' }),
    ).toEqual([]);
    expect(overlappingOutcomes(held('skipped'), { on: 'completion' })).toEqual([]);
    expect(overlappingOutcomes(held('skipped'), { on: 'success' })).toEqual([]);
  });

  it('never involves a business branch', () => {
    expect(
      overlappingOutcomes(held('success', 'completion'), { on: 'branch', branch: 'completion' }),
    ).toEqual([]);
  });
});

describe('takenConditions — #1064 overlap', () => {
  const subject: Edge = { id: 'e1', from: 'a', to: 'b', on: 'success' };

  it('disables success and failure beside a completion edge, with the reason', () => {
    const completion: Edge = { id: 'e2', from: 'a', to: 'b', on: 'completion' };
    const skip: Edge = { id: 'e1', from: 'a', to: 'b', on: 'skipped' };
    const taken = takenConditions([skip, completion], skip);
    expect(taken.get('op:success')).toBe('already covered by the completion edge');
    expect(taken.get('op:failure')).toBe('already covered by the completion edge');
    // The duplicate reason wins for the condition another edge literally holds.
    expect(taken.get('op:completion')).toBe('already used by another edge');
    expect(taken.has('op:skipped')).toBe(false);
  });

  it('disables completion beside a failure sibling, naming it', () => {
    const failure: Edge = { id: 'e2', from: 'a', to: 'b', on: 'failure' };
    expect(takenConditions([subject, failure], subject).get('op:completion')).toBe(
      'would repeat the failure edge',
    );
  });

  it('names BOTH siblings when a skipped edge sits beside success and failure', () => {
    const skip: Edge = { id: 'e0', from: 'a', to: 'b', on: 'skipped' };
    const failure: Edge = { id: 'e2', from: 'a', to: 'b', on: 'failure' };
    expect(takenConditions([skip, subject, failure], skip).get('op:completion')).toBe(
      'would repeat the success and failure edges',
    );
  });

  /** Retyping the ONLY edge of a pair is widening it, not overlapping it. */
  it('lets a lone success edge widen to completion', () => {
    expect(takenConditions([subject], subject).has('op:completion')).toBe(false);
  });

  it('ignores an overlapping edge between a different pair', () => {
    const elsewhere: Edge = { id: 'e2', from: 'a', to: 'c', on: 'completion' };
    expect(takenConditions([subject, elsewhere], subject).size).toBe(0);
  });

  /**
   * Back-edges are exempt: `fireBackEdges` bounces each one on its OWN counter
   * under its own `maxBounces`, so a success back-edge beside a completion one
   * is not the same intent spelled twice.
   */
  it('exempts back-edges, on either side of the comparison', () => {
    const back = (id: string, on: Edge['on']): Edge =>
      ({ id, from: 'a', to: 'b', on, back: true, maxBounces: 2 }) as Edge;
    expect(takenConditions([subject, back('e2', 'completion')], subject).size).toBe(0);
    const backSubject = back('e1', 'success');
    const fwdCompletion: Edge = { id: 'e2', from: 'a', to: 'b', on: 'completion' };
    expect(takenConditions([backSubject, fwdCompletion], backSubject).size).toBe(0);
    expect(
      takenConditions([backSubject, back('e2', 'completion')], backSubject).has('op:success'),
    ).toBe(false);
  });
});

describe('completionSibling', () => {
  const success: Edge = { id: 'e1', from: 'a', to: 'b', on: 'success' };
  const failure: Edge = { id: 'e2', from: 'a', to: 'b', on: 'failure' };

  it('finds the partner of a success/failure pair, from either side', () => {
    expect(completionSibling([success, failure], success)?.id).toBe('e2');
    expect(completionSibling([success, failure], failure)?.id).toBe('e1');
  });

  it('is null with no partner, across a different pair, or for a back-edge', () => {
    expect(completionSibling([success], success)).toBeNull();
    const elsewhere: Edge = { ...failure, to: 'c' };
    expect(completionSibling([success, elsewhere], success)).toBeNull();
    const backFailure = { ...failure, back: true, maxBounces: 1 } as Edge;
    expect(completionSibling([success, backFailure], success)).toBeNull();
  });

  /** Retyping onto `completion` there would duplicate the completion edge. */
  it('is null when the pair ALREADY holds a completion edge beside the two', () => {
    const completion: Edge = { id: 'e3', from: 'a', to: 'b', on: 'completion' };
    expect(completionSibling([success, failure, completion], success)).toBeNull();
    expect(completionSibling([success, failure, completion], failure)).toBeNull();
  });

  it('is null for an edge that is not success or failure', () => {
    const completion: Edge = { id: 'e3', from: 'a', to: 'b', on: 'completion' };
    expect(completionSibling([success, failure, completion], completion)).toBeNull();
  });
});
