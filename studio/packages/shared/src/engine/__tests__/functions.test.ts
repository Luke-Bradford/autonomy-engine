import { describe, expect, it } from 'vitest';
import type { Edge, EdgeOn, Node, Param, PipelineVersion, SubstitutionContext } from '../types.js';
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

function edge(from: string, to: string, on: EdgeOn): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on, back: false };
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

  it('resolves OWN properties only — never through the prototype chain', () => {
    // `in` would hand back a real host function as resolved node config.
    for (const path of ['item.constructor', 'item.toString', 'item.__proto__']) {
      expect(() => substitute(`\${map(params.rows, ${path})}`, rows)).toThrow(/has no field/);
    }
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

  it('equals() agrees with the ordering fns about -0', () => {
    // Object.is(-0, 0) is false, which would contradict greaterOrEquals AND
    // lessOrEquals both answering true for the same pair.
    expect(substitute('${equals(mul(-1, 0), 0)}', ctx())).toBe(true);
    expect(substitute('${greaterOrEquals(mul(-1, 0), 0)}', ctx())).toBe(true);
    expect(substitute('${lessOrEquals(mul(-1, 0), 0)}', ctx())).toBe(true);
  });

  it('names the actual value when a non-finite number is rejected', () => {
    // NaN/Infinity are `typeof 'number'` but the `number` sig requires FINITE,
    // so a naive typeName gives the baffling "must be a number, got number".
    const c = ctx({ params: { nan: NaN, inf: Infinity } });
    expect(() => substitute('${add(params.nan, 1)}', c)).toThrow(/got NaN/);
    expect(() => substitute('${add(params.inf, 1)}', c)).toThrow(/got Infinity/);
  });

  it('float() rejects radix prefixes (no implicit reinterpretation)', () => {
    expect(() => substitute("${float('0x10')}", ctx())).toThrow(SubstituteError);
    expect(substitute("${float('4.5')}", ctx())).toBe(4.5);
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

  // E5a ships the date fns that take an EXPLICIT timestamp — all pure. The three
  // the spec's line-75 list names but that are NOT here each fail a
  // non-negotiable, and their absence is pinned so re-adding one is a deliberate
  // act with a decision behind it, not an accident.
  it('has no utcNow — it needs a dispatch stamp that does not exist yet (E5b)', () => {
    expect(listFunctions()).not.toContain('utcNow');
  });

  it('has no ticks — it cannot be exact in a float (E5a deviation)', () => {
    expect(listFunctions()).not.toContain('ticks');
  });

  it('has no convertTimeZone — host tzdata would break replay (E5a deviation)', () => {
    expect(listFunctions()).not.toContain('convertTimeZone');
  });

  it('no date fn reads a clock — every one takes an explicit timestamp', () => {
    // The catalog is pure, so the SAME call must yield the SAME value forever.
    // A clock read would make these two differ (or drift on replay).
    const c = ctx({ params: { t: '2026-07-15T10:30:00.000Z' } });
    expect(substitute('${addDays(params.t, 1)}', c)).toBe(substitute('${addDays(params.t, 1)}', c));
    // ...and there is no zero-arg date fn to read one WITH.
    for (const fn of ['addDays', 'formatDateTime', 'startOfDay', 'dayOfWeek']) {
      expect(() => substitute(`\${${fn}()}`, ctx())).toThrow(SubstituteError);
    }
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

  it('split() bounds the result BEFORE allocating', () => {
    const s = 'x'.repeat(MAX_ARRAY_ELEMENTS + 1);
    expect(() => substitute("${split(params.s, '')}", ctx({ params: { s } }))).toThrow(
      /too large|cap/i,
    );
  });

  it('bounds the TOTAL work of one field, not just each array', () => {
    // Every array here sits exactly AT the per-array cap, so every per-array
    // check passes while 10^8 elements are materialised. Only the
    // per-evaluation budget can see the product.
    expect(() =>
      substitute(
        `\${length(map(range(0, ${MAX_ARRAY_ELEMENTS}), range(0, ${MAX_ARRAY_ELEMENTS})))}`,
        ctx(),
      ),
    ).toThrow(/too many array elements/i);
  });

  it('bounds array CONSUMPTION, not just materialisation', () => {
    // `sum()` scans a near-cap array and returns a SCALAR. Charging only
    // array-shaped results of CALLS would let these scan 10k elements each while
    // spending nothing — the budget would bound allocation, not work.
    const at = Array.from({ length: MAX_ARRAY_ELEMENTS }, (_, i) => i);
    const c = ctx({ params: { a: at, b: at, c: at } });
    expect(substitute('${add(sum(params.a), sum(params.b))}', c)).toBe(99_990_000);
    // ...and a re-resolved array inside a lambda is quadratic: `b` is resolved
    // once PER ELEMENT of `a`, which is 10^6 elements of real work.
    const k = Array.from({ length: 1000 }, (_, i) => i);
    expect(() =>
      substitute('${count(params.a, contains(params.b, item))}', ctx({ params: { a: k, b: k } })),
    ).toThrow(/too many array elements/i);
  });

  it('does NOT cap the fns that allocate nothing — they are the escape hatch', () => {
    // An over-cap array must stay inspectable, or the author cannot write the
    // guard that avoids the cap, and take/skip cannot bring it back under.
    const c = ctx({ params: { big: Array.from({ length: MAX_ARRAY_ELEMENTS + 1 }, (_, i) => i) } });
    expect(substitute('${length(params.big)}', c)).toBe(MAX_ARRAY_ELEMENTS + 1);
    expect(substitute('${empty(params.big)}', c)).toBe(false);
    expect(substitute('${first(params.big)}', c)).toBe(0);
    expect(substitute('${length(take(params.big, 3))}', c)).toBe(3);
    expect(substitute('${length(map(take(params.big, 3), item))}', c)).toBe(3);
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
  // The fixture must be a REACHABLE-but-NOT-GUARANTEED ref, or this pins
  // nothing: an unknown node id fails on the "does not name an upstream node"
  // branch, which fires whether or not the checker is soft. `a --failure--> h
  // --success--> d` is the discriminating shape — `a` runs on every path to `d`
  // but only SUCCEEDS on paths where `d` is unreachable, so `guaranteed[a] = ∅`
  // and the soft path is the only thing that could accept it.
  const notGuaranteed = (prompt: string) =>
    validateRefs(
      doc(
        [node('a', {}), node('h', {}), node('d', { prompt })],
        [edge('a', 'h', 'failure'), edge('h', 'd', 'success')],
      ),
    ).join('\n');

  it('still rejects a non-guaranteed output inside a short-circuiting and()', () => {
    // INTENTIONAL false-reject, and the load-bearing one: the checker cannot
    // know arg0 is `false`, so relaxing it would equally accept
    // `and(true, nodes.a.output.v)` — a doc that saves clean and THROWS at run
    // with no escape hatch. Same reasoning as E3's status rule.
    expect(notGuaranteed('${and(false, nodes.a.output.v)}')).toMatch(/wrap it in default/);
    expect(notGuaranteed('${or(true, nodes.a.output.v)}')).toMatch(/wrap it in default/);
    expect(notGuaranteed("${if(false, nodes.a.output.v, 'x')}")).toMatch(/wrap it in default/);
  });

  it('...while default() — and ONLY default() — still opens the soft path', () => {
    expect(notGuaranteed('${default(nodes.a.output.v, "fb")}')).toBe('');
    expect(substitute("${default(nodes.missing.output.x, 'fb')}", ctx())).toBe('fb');
  });
});

// ===========================================================================
// Per-family representative coverage
// ===========================================================================

// ===========================================================================
// #6 E5a — the date fns. Every one takes an EXPLICIT timestamp and works in
// UTC, so the whole family is pure: no clock, no host timezone, no tzdata.
// `${run.startedAt}` (E3) is the run-stable source; `utcNow()` is E5b.
// ===========================================================================

describe('E5a date fns — parsing is STRICT', () => {
  const T = '2026-07-15T10:30:00.000Z';

  it('rejects what `new Date()` would silently guess at', () => {
    // Each of these PARSES under `new Date(...)`, which is exactly the problem:
    // its non-ISO handling is implementation-defined, so a doc that resolved one
    // way on one engine could resolve another way on the next — the replay
    // hazard spec #6 line 20 forbids. We parse ourselves and refuse instead.
    for (const bad of [
      'July 4, 2026', // impl-defined free text
      '2026-07-15T10:30:00', // no offset: `new Date` reads this as LOCAL time
      '2026-07-15', // date-only: no time of day
      '2026-13-01T00:00:00Z', // month 13
      '2026-02-30T00:00:00Z', // never existed
      'now',
      '',
    ]) {
      expect(() => substitute('${addDays(params.t, 1)}', ctx({ params: { t: bad } }))).toThrow(
        SubstituteError,
      );
    }
  });

  it('accepts Z and a numeric offset, and normalises to UTC', () => {
    expect(substitute('${addDays(params.t, 0)}', ctx({ params: { t: T } }))).toBe(T);
    // +01:00 is one hour AHEAD of UTC, so the instant is 09:30Z.
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00+01:00' } })),
    ).toBe('2026-07-15T09:30:00.000Z');
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00-0500' } })),
    ).toBe('2026-07-15T15:30:00.000Z');
  });

  it('PRESERVES milliseconds — `${run.startedAt}` carries them', () => {
    // The driver stamps `run.started.startedAt` from the run row via
    // `toISOString()`, so it always has 3 fractional digits. Rounding them off
    // here would make `addDays(run.startedAt, 0)` != `run.startedAt`.
    const c = ctx({ run: { startedAt: '2026-07-15T10:30:00.872Z' } });
    expect(substitute('${addDays(run.startedAt, 0)}', c)).toBe('2026-07-15T10:30:00.872Z');
  });

  it('truncates sub-millisecond precision rather than refusing it', () => {
    // Real APIs emit microseconds (RFC3339 allows any number of digits) and a
    // Date is millisecond-resolution, so refusing these would make the date fns
    // unusable on an ordinary HTTP output. The loss is at the representation's
    // limit and is documented.
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00.872999Z' } })),
    ).toBe('2026-07-15T10:30:00.872Z');
  });

  it('enforces the representable range on INPUT, not just on a result', () => {
    // `\d{4}` admits year 0000, which is outside the documented 0001-9999 range.
    // Only the fns that RENDER a timestamp pass through the result check, so the
    // range has to be enforced at the parse boundary or it holds for `addDays`
    // and silently does not for `dayOfWeek`/`formatDateTime`.
    const y0 = ctx({ params: { t: '0000-01-01T00:00:00Z' } });
    expect(() => substitute('${addDays(params.t, 1)}', y0)).toThrow(/range/i);
    expect(() => substitute('${dayOfWeek(params.t)}', y0)).toThrow(/range/i);
    expect(() => substitute("${formatDateTime(params.t, 'yyyy-MM-dd')}", y0)).toThrow(/range/i);
    // The boundary years themselves are representable.
    expect(
      substitute('${dayOfWeek(params.t)}', ctx({ params: { t: '0001-01-01T00:00:00Z' } })),
    ).toBe(1);
    expect(
      substitute(
        "${formatDateTime(params.t, 'yyyy')}",
        ctx({ params: { t: '9999-12-31T23:59:59.999Z' } }),
      ),
    ).toBe('9999');
  });

  it('gets the CENTURY leap rule right (not just the /4 rule)', () => {
    // 1900 is NOT a leap year (divisible by 100, not by 400); 2000 IS. A bare
    // `y % 4 === 0` passes every other date test in this file.
    expect(() =>
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '1900-02-29T00:00:00Z' } })),
    ).toThrow(/day that does not exist/);
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2000-02-29T00:00:00Z' } })),
    ).toBe('2000-02-29T00:00:00.000Z');
  });

  it('applies the MINUTES of a half-hour offset, not just the hours', () => {
    // India (+05:30), Chatham (+12:45) and friends. Dropping the minutes term
    // leaves every whole-hour offset correct, so it hides in plain sight.
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00+01:30' } })),
    ).toBe('2026-07-15T09:00:00.000Z');
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00+05:30' } })),
    ).toBe('2026-07-15T05:00:00.000Z');
  });

  it('pads a SHORT fractional second — `.1` is 100ms, not 1ms', () => {
    // ISO fractions are decimal, so `.1` = 100ms. Reading the digits as an
    // integer would make `.1Z` one millisecond.
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00.1Z' } })),
    ).toBe('2026-07-15T10:30:00.100Z');
    expect(
      substitute('${addDays(params.t, 0)}', ctx({ params: { t: '2026-07-15T10:30:00.12Z' } })),
    ).toBe('2026-07-15T10:30:00.120Z');
  });

  it('throws on a null `${run.startedAt}` instead of coercing it', () => {
    // `RunState.startedAt` is nullable — it folds to null for a pre-E3 log. The
    // throw is loud and correct; coercing null to the epoch would be a silent lie.
    expect(() =>
      substitute('${addDays(run.startedAt, 1)}', ctx({ run: { startedAt: null } })),
    ).toThrow(SubstituteError);
  });
});

describe('E5a date fns — arithmetic', () => {
  const T = '2026-07-15T10:30:00.000Z';
  const c = ctx({ params: { t: T } });

  it('adds each unit', () => {
    expect(substitute('${addDays(params.t, 1)}', c)).toBe('2026-07-16T10:30:00.000Z');
    expect(substitute('${addHours(params.t, 2)}', c)).toBe('2026-07-15T12:30:00.000Z');
    expect(substitute('${addMinutes(params.t, 15)}', c)).toBe('2026-07-15T10:45:00.000Z');
    expect(substitute('${addSeconds(params.t, 30)}', c)).toBe('2026-07-15T10:30:30.000Z');
  });

  it('subtracts on a negative interval, and composes', () => {
    expect(substitute('${addDays(params.t, -1)}', c)).toBe('2026-07-14T10:30:00.000Z');
    // Fns compose because every one returns the same ISO shape it accepts.
    expect(substitute('${addHours(addDays(params.t, 1), 2)}', c)).toBe('2026-07-16T12:30:00.000Z');
  });

  it('crosses a month/year boundary', () => {
    expect(
      substitute('${addDays(params.t, 1)}', ctx({ params: { t: '2026-12-31T23:00:00.000Z' } })),
    ).toBe('2027-01-01T23:00:00.000Z');
  });

  it('rejects a fractional interval', () => {
    // `addDays(t, 0.5)` reads as "half a day" but would silently truncate;
    // `addHours(t, 12)` says it exactly.
    expect(() => substitute('${addDays(params.t, 0.5)}', c)).toThrow(SubstituteError);
  });

  it('refuses to run off the end of time', () => {
    // A raw `toISOString()` on an out-of-range Date throws `RangeError: Invalid
    // time value`, which would surface as a baffling "function 'addDays' failed".
    expect(() => substitute('${addDays(params.t, 1000000000000)}', c)).toThrow(/out of range/i);
  });

  it('addToTime/subtractFromTime take a unit, and reject an unknown one', () => {
    expect(substitute("${addToTime(params.t, 1, 'Week')}", c)).toBe('2026-07-22T10:30:00.000Z');
    expect(substitute("${addToTime(params.t, 1, 'Year')}", c)).toBe('2027-07-15T10:30:00.000Z');
    expect(substitute("${subtractFromTime(params.t, 2, 'Hour')}", c)).toBe(
      '2026-07-15T08:30:00.000Z',
    );
    expect(() => substitute("${addToTime(params.t, 1, 'Fortnight')}", c)).toThrow(SubstituteError);
    // Case-sensitive: one spelling per unit, like every other closed set here.
    expect(() => substitute("${addToTime(params.t, 1, 'week')}", c)).toThrow(SubstituteError);
  });

  it('CLAMPS a month add to the end of a short month', () => {
    // Jan 31 + 1 Month has no exact answer. .NET's AddMonths clamps to the last
    // valid day (Feb 28/29); naive ms arithmetic would overflow into March.
    const jan31 = ctx({ params: { t: '2026-01-31T12:00:00.000Z' } });
    expect(substitute("${addToTime(params.t, 1, 'Month')}", jan31)).toBe(
      '2026-02-28T12:00:00.000Z',
    );
    const leap = ctx({ params: { t: '2028-01-31T12:00:00.000Z' } });
    expect(substitute("${addToTime(params.t, 1, 'Month')}", leap)).toBe('2028-02-29T12:00:00.000Z');
    // Feb 29 + 1 Year clamps the same way.
    const feb29 = ctx({ params: { t: '2028-02-29T12:00:00.000Z' } });
    expect(substitute("${addToTime(params.t, 1, 'Year')}", feb29)).toBe('2029-02-28T12:00:00.000Z');
  });
});

describe('E5a date fns — truncation + fields', () => {
  const c = ctx({ params: { t: '2026-07-15T10:30:45.123Z' } });

  it('startOfDay/startOfHour/startOfMonth zero everything below the unit', () => {
    expect(substitute('${startOfDay(params.t)}', c)).toBe('2026-07-15T00:00:00.000Z');
    expect(substitute('${startOfHour(params.t)}', c)).toBe('2026-07-15T10:00:00.000Z');
    expect(substitute('${startOfMonth(params.t)}', c)).toBe('2026-07-01T00:00:00.000Z');
  });

  it('dayOfWeek is 0=Sunday (ADF parity, and what run-window.ts already uses)', () => {
    // 2026-07-15 is a Wednesday. `isWithinRunWindows` reads `getUTCDay()`, so a
    // different numbering here would ship two weekday conventions in one product.
    expect(substitute('${dayOfWeek(params.t)}', c)).toBe(3);
    expect(
      substitute('${dayOfWeek(params.t)}', ctx({ params: { t: '2026-07-19T00:00:00Z' } })),
    ).toBe(0);
  });

  it('dayOfMonth', () => {
    expect(substitute('${dayOfMonth(params.t)}', c)).toBe(15);
  });
});

describe('E5a formatDateTime — a CLOSED token set', () => {
  const c = ctx({ params: { t: '2026-07-15T10:30:45.123Z' } });

  it('formats the documented tokens', () => {
    expect(substitute("${formatDateTime(params.t, 'yyyy-MM-dd')}", c)).toBe('2026-07-15');
    expect(substitute("${formatDateTime(params.t, 'yyyy-MM-dd HH:mm:ss')}", c)).toBe(
      '2026-07-15 10:30:45',
    );
    expect(substitute("${formatDateTime(params.t, 'dd/MM/yyyy')}", c)).toBe('15/07/2026');
    // Same-character runs split, so an unpunctuated format still tokenises.
    expect(substitute("${formatDateTime(params.t, 'yyyyMMdd')}", c)).toBe('20260715');
    // `fff` round-trips the ms that `${run.startedAt}` carries.
    expect(substitute("${formatDateTime(params.t, 'HH:mm:ss.fff')}", c)).toBe('10:30:45.123');
  });

  it('zero-pads `yyyy` to 4 digits for a sub-1000 year', () => {
    // Every other year in this suite is 4 digits already, where the pad width is
    // a no-op — so a wrong width would go unnoticed and then emit a `0099` year
    // as `99`, which our own parser would refuse to read back.
    expect(
      substitute(
        "${formatDateTime(params.t, 'yyyy-MM-dd')}",
        ctx({ params: { t: '0099-07-15T10:30:00Z' } }),
      ),
    ).toBe('0099-07-15');
  });

  it('passes a NON-ASCII letter through — the token set is ASCII-only', () => {
    // `/[A-Za-z]/` does not match `年`/`м`, so they are literals. Documented as
    // such: the refusal message says "ASCII letters", because claiming "letters
    // cannot appear literally" would be false.
    expect(substitute("${formatDateTime(params.t, 'yyyy年MM月dd日')}", c)).toBe('2026年07月15日');
  });

  it('never echoes the format string in a refusal — it is a resolved value', () => {
    // Argument 2 can be a REF, so echoing the offending run would turn a
    // misrouted secret into a character-by-character oracle. `parseTs` already
    // holds this line for argument 1; the message names a POSITION instead.
    const secret = ctx({ params: { t: '2026-07-15T10:30:00Z', fmt: 'ghp_aBcDeF123' } });
    expect(() => substitute('${formatDateTime(params.t, params.fmt)}', secret)).toThrow(/position/);
    expect(() => substitute('${formatDateTime(params.t, params.fmt)}', secret)).not.toThrow(
      /ghp_|aBcDeF/,
    );
  });

  it('passes non-alphabetic characters through literally', () => {
    expect(substitute("${formatDateTime(params.t, 'dd.MM.yyyy @ HH:mm')}", c)).toBe(
      '15.07.2026 @ 10:30',
    );
    // A newline is a literal like any other: the run-scanner must not treat it
    // as a boundary that splits the tokens around it.
    expect(substitute("${formatDateTime(params.t, 'yyyy\n\nHH')}", c)).toBe('2026\n\n10');
    expect(substitute("${formatDateTime(params.t, '')}", c)).toBe('');
    expect(substitute("${formatDateTime(params.t, '-- :: ..')}", c)).toBe('-- :: ..');
  });

  it('REJECTS an unknown token rather than emitting it raw', () => {
    // `yy` is a real .NET token we do not implement. Emitting it literally would
    // hand the author "yy-07-15" and let them think it worked.
    expect(() => substitute("${formatDateTime(params.t, 'yy-MM-dd')}", c)).toThrow(SubstituteError);
    // A literal 'T' is alphabetic, so it is an unknown token, not a passthrough.
    // The ISO shape needs no formatting (values ARE ISO); assemble anything else
    // with `concat`.
    expect(() => substitute('${formatDateTime(params.t, "yyyy-MM-dd\'T\'HH:mm")}', c)).toThrow(
      SubstituteError,
    );
  });
});

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

  it('base64ToString() rejects malformed input as a clean SubstituteError', () => {
    // Each of these previously either escaped as a raw RangeError or decoded
    // silently to something the input never legitimately represented.
    for (const bad of ['97+/vw==' /* cp out of range */, 'wIA=' /* overlong C0 80 */, 'A']) {
      expect(() => substitute(`\${base64ToString('${bad}')}`, ctx())).toThrow(SubstituteError);
    }
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
