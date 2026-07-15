import { describe, expect, it } from 'vitest';
import type { Edge, Node, Param, PipelineVersion, SubstitutionContext } from '../types.js';
import { SubstituteError } from '../types.js';
import { MAX_ARRAY_ELEMENTS, listFunctions } from '../functions.js';
import { substitute, validateRefs } from '../params.js';

// ---------------------------------------------------------------------------
// #6 E4 — the closed function catalog. These tests pin the SPIKE-HARDENED
// decisions of spec #6, not just the happy path of each fn:
//   - the calling convention (eager args vs a lambda arg vs a lazy special)
//   - `and`/`or`/`if` SHORT-CIRCUIT at run time, while the static checker stays
//     STRICT (relaxing it would be a false-accept — see the `validateRefs` block)
//   - `item` binds ONLY inside a lambda arg
//   - INERTNESS survives the array forms (element ASTs are evaluated; a resolved
//     string is NEVER re-parsed)
//   - no implicit coercion beyond the explicit conversion fns
// ---------------------------------------------------------------------------

function ctx(over: Partial<SubstitutionContext> = {}): SubstitutionContext {
  return {
    params: over.params ?? {},
    nodeOutputs: over.nodeOutputs ?? {},
    nodeStatuses: over.nodeStatuses ?? {},
    run: over.run ?? {},
  };
}

let nodeSeq = 0;
function node(id: string, config: Record<string, unknown>): Node {
  nodeSeq += 1;
  return { id, type: 'agent_task', config, position: { x: nodeSeq, y: 0 } };
}

function doc(
  nodes: Node[],
  edges: Edge[],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers: [] };
}

// ===========================================================================
// The calling convention: short-circuit (RUN-TIME ONLY)
// ===========================================================================

describe('and/or/if — short-circuit', () => {
  it('and() short-circuits: a false first arg protects an absent node output', () => {
    // Eager variadic evaluation would THROW here (the spike's finding).
    expect(substitute('${and(false, nodes.missing.output.x)}', ctx())).toBe(false);
  });

  it('or() short-circuits: a true first arg protects an absent node output', () => {
    expect(substitute('${or(true, nodes.missing.output.x)}', ctx())).toBe(true);
  });

  it('and()/or() still evaluate later args when not short-circuited', () => {
    expect(substitute('${and(true, false)}', ctx())).toBe(false);
    expect(substitute('${or(false, true)}', ctx())).toBe(true);
    expect(() => substitute('${and(true, nodes.missing.output.x)}', ctx())).toThrow(
      SubstituteError,
    );
  });

  it('and()/or() reject a non-boolean arg (no implicit coercion)', () => {
    expect(() => substitute("${and('x', true)}", ctx())).toThrow(/boolean/i);
    expect(() => substitute('${or(1, true)}', ctx())).toThrow(/boolean/i);
  });

  it('if() evaluates ONLY the taken branch', () => {
    expect(substitute("${if(true, 'a', nodes.missing.output.x)}", ctx())).toBe('a');
    expect(substitute("${if(false, nodes.missing.output.x, 'b')}", ctx())).toBe('b');
  });

  it('if() requires a boolean condition', () => {
    expect(() => substitute("${if('yes', 'a', 'b')}", ctx())).toThrow(/boolean/i);
  });
});

// ===========================================================================
// `item` — bound ONLY inside a lambda arg
// ===========================================================================

describe('item scoping', () => {
  const rows = ctx({
    params: {
      rows: [
        { sku: 'a', score: 9 },
        { sku: 'b', score: 3 },
      ],
      nums: [1, 5, 9],
    },
  });

  it('filter() binds ${item} over the array', () => {
    expect(substitute('${filter(params.rows, greater(item.score, 5))}', rows)).toEqual([
      { sku: 'a', score: 9 },
    ]);
  });

  it('map() projects a named field', () => {
    expect(substitute('${map(params.rows, item.sku)}', rows)).toEqual(['a', 'b']);
  });

  it('binds a BARE ${item} for a scalar array', () => {
    expect(substitute('${filter(params.nums, greater(item, 4))}', rows)).toEqual([5, 9]);
    expect(substitute('${map(params.nums, item)}', rows)).toEqual([1, 5, 9]);
  });

  it('a top-level ${item} is a hard error at RUN time', () => {
    expect(() => substitute('${item.score}', rows)).toThrow(/item/i);
    expect(() => substitute('${item}', rows)).toThrow(/item/i);
  });

  it('does NOT leak ${item} to a sibling arg of the same call', () => {
    expect(() => substitute('${concat(map(params.nums, item), item)}', rows)).toThrow(/item/i);
  });

  it('a top-level ${item} is a SAVE-time error', () => {
    const errs = validateRefs(doc([node('a', { prompt: '${item.score}' })], []));
    expect(errs.join('\n')).toMatch(/item/i);
  });

  it('${item} inside a lambda arg is accepted at SAVE time', () => {
    const errs = validateRefs(
      doc(
        [node('a', { prompt: '${map(params.rows, item.sku)}' })],
        [],
        [{ name: 'rows', type: 'json', required: true }],
      ),
    );
    expect(errs).toEqual([]);
  });

  it('${item[0]} is refused (E7 owns [] addressing)', () => {
    expect(() => substitute('${map(params.nums, item[0])}', rows)).toThrow(/E7|\[\]/);
  });
});

// ===========================================================================
// INERTNESS — the no-injection guarantee must survive the array forms
// ===========================================================================

describe('inertness', () => {
  it('map()/filter() never re-parse a resolved string', () => {
    const c = ctx({ params: { rows: ['${params.secret}', 'plain'], secret: 'LEAKED' } });
    // The element's TEXT is data. It must be emitted literally, never resolved.
    expect(substitute('${map(params.rows, item)}', c)).toEqual(['${params.secret}', 'plain']);
    expect(substitute('${first(params.rows)}', c)).toBe('${params.secret}');
  });

  it('json() output is DATA, never rescanned', () => {
    const c = ctx({ params: { blob: '{"a":"${params.secret}"}', secret: 'LEAKED' } });
    expect(substitute('${json(params.blob)}', c)).toEqual({ a: '${params.secret}' });
  });

  it('there is no expr()/eval() escape hatch', () => {
    expect(listFunctions()).not.toContain('expr');
    expect(listFunctions()).not.toContain('eval');
  });
});

// ===========================================================================
// No implicit coercion (spec #6 Non-goals)
// ===========================================================================

describe('no implicit coercion', () => {
  it('add() rejects a string arg rather than coercing it', () => {
    expect(() => substitute("${add('2', 3)}", ctx())).toThrow(/number/i);
    expect(substitute('${add(2, 3)}', ctx())).toBe(5);
  });

  it('equals() is strict identity — never coercing', () => {
    expect(substitute("${equals(1, '1')}", ctx())).toBe(false);
    expect(substitute('${equals(1, 1)}', ctx())).toBe(true);
    expect(substitute("${equals('a', 'a')}", ctx())).toBe(true);
  });

  it('concat() IS contractually string-coercing (ADF parity)', () => {
    expect(substitute("${concat('n=', 42, true)}", ctx())).toBe('n=42true');
  });
});

// ===========================================================================
// Determinism / replay safety
// ===========================================================================

describe('purity', () => {
  it('has NO non-deterministic function (guid removed in v1)', () => {
    expect(listFunctions()).not.toContain('guid');
    expect(listFunctions()).not.toContain('rand');
  });

  it('has no date fn yet — utcNow binds a dispatch stamp at E5', () => {
    expect(listFunctions()).not.toContain('utcNow');
  });
});

// ===========================================================================
// Resource limits — caps on both PRODUCING and CONSUMING array fns
// ===========================================================================

describe('resource limits', () => {
  it('range() refuses to materialise an over-cap array', () => {
    expect(() => substitute(`\${range(0, ${MAX_ARRAY_ELEMENTS + 1})}`, ctx())).toThrow(
      /too large|cap/i,
    );
  });

  it('map() refuses an over-cap input array', () => {
    const big = Array.from({ length: MAX_ARRAY_ELEMENTS + 1 }, (_, i) => i);
    expect(() => substitute('${map(params.big, item)}', ctx({ params: { big } }))).toThrow(
      /too large|cap/i,
    );
  });
});

// ===========================================================================
// The flagship judge-gate aggregate (spec #6 Round-2 C2)
// ===========================================================================

describe('the judge-gate aggregate flow', () => {
  it('evaluates the spec"s flagship expression to a boolean', () => {
    const c = ctx({
      nodeOutputs: {
        each: {
          results: [
            { sku: 'a', score: 9 },
            { sku: 'b', score: 8 },
            { sku: 'c', score: 8 },
            { sku: 'd', score: 4 },
          ],
        },
      },
    });
    // avg = 7.25 >= 7 AND count(score >= 8) = 3 >= 3  ->  true
    const expr =
      '${and(greaterOrEquals(avg(map(nodes.each.output.results, item.score)), 7), ' +
      'greaterOrEquals(count(nodes.each.output.results, greaterOrEquals(item.score, 8)), 3))}';
    expect(substitute(expr, c)).toBe(true);
  });

  it('count() is arity-overloaded: count(arr) and count(arr, predicate)', () => {
    const c = ctx({ params: { nums: [1, 5, 9] } });
    expect(substitute('${count(params.nums)}', c)).toBe(3);
    expect(substitute('${count(params.nums, greater(item, 4))}', c)).toBe(2);
  });

  it('sum()/avg() aggregate over an array of numbers', () => {
    const c = ctx({ params: { nums: [1, 5, 9] } });
    expect(substitute('${sum(params.nums)}', c)).toBe(15);
    expect(substitute('${avg(params.nums)}', c)).toBe(5);
  });
});

// ===========================================================================
// E3 loop-closer: `${nodes.x.status}` becomes a USABLE exitWhen via equals()
// ===========================================================================

describe('E3 loop-closer', () => {
  it('equals() turns a status into the boolean exitWhen needs', () => {
    const c = ctx({ nodeStatuses: { check: 'success' } });
    expect(substitute("${equals(nodes.check.status, 'success')}", c)).toBe(true);
    expect(substitute("${equals(nodes.check.status, 'failure')}", c)).toBe(false);
  });
});

// ===========================================================================
// The static checker STAYS STRICT — laziness is a RUN-TIME property only
// ===========================================================================

describe('validateRefs — laziness does NOT relax the static checker', () => {
  it('still rejects a non-guaranteed output inside a short-circuiting and()', () => {
    // INTENTIONAL false-reject. The checker cannot know arg0 is `false`, so
    // relaxing this would equally accept `and(true, nodes.a.output.v)` — which
    // throws at run with NO escape hatch. Same reasoning as E3's status rule.
    const errs = validateRefs(doc([node('b', { prompt: '${and(false, nodes.a.output.v)}' })], []));
    expect(errs.join('\n')).toMatch(/nodes\.a\.output\.v/);
  });

  it('default() still rescues a missing node output in its first arg', () => {
    expect(substitute("${default(nodes.missing.output.x, 'fb')}", ctx())).toBe('fb');
  });
});

// ===========================================================================
// Per-family representative coverage
// ===========================================================================

describe('catalog families', () => {
  it('string fns', () => {
    expect(substitute("${toUpper('ab')}", ctx())).toBe('AB');
    // ADF semantics: substring(text, startIndex, LENGTH) — not (start, end).
    expect(substitute("${substring('hello', 1, 3)}", ctx())).toBe('ell');
    expect(substitute("${substring('hello', 3)}", ctx())).toBe('lo');
    expect(substitute("${replace('a-b', '-', '+')}", ctx())).toBe('a+b');
    expect(substitute("${split('a,b', ',')}", ctx())).toEqual(['a', 'b']);
    expect(substitute("${startsWith('hello', 'he')}", ctx())).toBe(true);
    expect(substitute("${indexOf('hello', 'l')}", ctx())).toBe(2);
  });

  it('collection fns', () => {
    const c = ctx({ params: { xs: [1, 2, 3] } });
    expect(substitute('${length(params.xs)}', c)).toBe(3);
    expect(substitute('${empty(params.xs)}', c)).toBe(false);
    expect(substitute('${contains(params.xs, 2)}', c)).toBe(true);
    expect(substitute('${first(params.xs)}', c)).toBe(1);
    expect(substitute('${take(params.xs, 2)}', c)).toEqual([1, 2]);
    expect(substitute("${join(params.xs, '-')}", c)).toBe('1-2-3');
    expect(substitute('${createArray(1, 2)}', ctx())).toEqual([1, 2]);
    expect(substitute('${range(0, 3)}', ctx())).toEqual([0, 1, 2]);
  });

  it('conversion fns', () => {
    expect(substitute('${string(42)}', ctx())).toBe('42');
    expect(substitute("${int('42')}", ctx())).toBe(42);
    expect(substitute("${float('4.5')}", ctx())).toBe(4.5);
    expect(substitute("${bool('true')}", ctx())).toBe(true);
    expect(substitute("${base64('ab')}", ctx())).toBe('YWI=');
    expect(substitute("${base64ToString('YWI=')}", ctx())).toBe('ab');
    // The grammar has NO null literal (E1: literal := number | boolean | string),
    // so coalesce's null-coalescing is driven by REFS, never a written `null`.
    expect(substitute("${coalesce(params.missing, 'x')}", ctx({ params: { missing: null } }))).toBe(
      'x',
    );
    // ...and it is NARROWER than default(): '' and false are values, not absences.
    expect(substitute("${coalesce(params.blank, 'x')}", ctx({ params: { blank: '' } }))).toBe('');
    expect(substitute("${default(params.blank, 'x')}", ctx({ params: { blank: '' } }))).toBe('x');
  });

  it('base64 round-trips UTF-8 (the engine has no Buffer/btoa)', () => {
    const c = ctx({ params: { s: 'héllo — 日本 🎉' } });
    expect(substitute('${base64ToString(base64(params.s))}', c)).toBe('héllo — 日本 🎉');
    expect(() => substitute("${base64ToString('not base64!')}", ctx())).toThrow(SubstituteError);
  });

  it('math fns', () => {
    expect(substitute('${sub(5, 2)}', ctx())).toBe(3);
    expect(substitute('${mul(5, 2)}', ctx())).toBe(10);
    expect(substitute('${div(10, 2)}', ctx())).toBe(5);
    expect(substitute('${mod(5, 2)}', ctx())).toBe(1);
    expect(substitute('${min(5, 2)}', ctx())).toBe(2);
    expect(substitute('${max(5, 2)}', ctx())).toBe(5);
  });

  it('div() by zero is a loud error, never Infinity', () => {
    expect(() => substitute('${div(1, 0)}', ctx())).toThrow(SubstituteError);
  });
});
