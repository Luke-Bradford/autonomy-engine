import { describe, expect, it } from 'vitest';
import type { Container, Edge, EdgeOn, Node, Param, PipelineVersion } from '../types.js';
import { FUNCTIONS, assignableTo, matchesSig, sigOfDeclared, type SigType } from '../functions.js';
import { resolveRunParams, substitute, validateDoc, validateRefs } from '../params.js';

// ---------------------------------------------------------------------------
// #6 E6 — `validateRefs` TYPING. The checker infers an expression's result type
// and checks it against the type the position expects (a fn ARG, or a field).
//
// E4 declared a `ret` on every catalog entry FOR this ticket and left it unread
// ("flattening every `ret` to 'any' keeps the suite green"). E6 is where it
// becomes load-bearing, so these tests pin BOTH halves:
//   - the inference itself (what a ref/literal/call is typed as), and
//   - the two REFUSALS it powers: a mistyped fn arg, and a non-boolean exitWhen.
//
// The governing constraint is the one E3/E4 settled: a false-ACCEPT (a doc that
// saves then throws at run) is never safe, but there is NO cast function, so a
// false-REJECT on `any` has no author workaround. Hence `any` is assignable in
// BOTH directions — the check fires only where both sides are known.
// ---------------------------------------------------------------------------

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function edge(from: string, to: string, on: EdgeOn): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  params: Param[] = [],
  containers: Container[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}
const param = (name: string, type: Param['type']): Param => ({ name, type, required: true });

/** Static-check one expression sitting in a node's config. */
const refsIn = (expr: string, params: Param[] = [], producer: Node = node('a')): string =>
  validateRefs(
    doc([producer, node('d', { prompt: expr })], [edge('a', 'd', 'success')], params),
  ).join('\n');

// ===========================================================================
// The type rule itself (SSOT, shared by the static checker + the run-time one)
// ===========================================================================

describe('assignableTo — the assignability rule', () => {
  const known: SigType[] = ['string', 'number', 'boolean', 'array'];

  it('accepts an exact match', () => {
    for (const t of known) expect(assignableTo(t, t)).toBe(true);
  });

  it('rejects a known mismatch', () => {
    expect(assignableTo('string', 'boolean')).toBe(false);
    expect(assignableTo('number', 'string')).toBe(false);
    expect(assignableTo('array', 'number')).toBe(false);
  });

  // NOT symmetry for its own sake: each direction earns its keep separately.
  it('accepts `any` as the EXPECTED type (a fn arg declared `any` takes anything)', () => {
    for (const t of known) expect(assignableTo(t, 'any')).toBe(true);
  });

  it('accepts `any` as the ACTUAL type — the escape hatch, since there is no cast fn', () => {
    // A `json` param, a no-contract node output, and `${item.x}` ALL infer `any`
    // (E4: no element type). Rejecting them where a `boolean` is expected would
    // be a false-reject with no author workaround.
    for (const t of known) expect(assignableTo('any', t)).toBe(true);
  });
});

describe('sigOfDeclared — the declared vocabulary maps onto the sig vocabulary', () => {
  it('maps the scalar types straight through', () => {
    expect(sigOfDeclared('string')).toBe('string');
    expect(sigOfDeclared('number')).toBe('number');
    expect(sigOfDeclared('boolean')).toBe('boolean');
  });

  it('maps `json` to `any` — there is no array/element type (E4)', () => {
    expect(sigOfDeclared('json')).toBe('any');
  });

  it('maps `secret` to `any` — it never reaches inference (hard-rejected first)', () => {
    expect(sigOfDeclared('secret')).toBe('any');
  });
});

// ===========================================================================
// Static ARG typing — the save-time mirror of run-time `checkArgTypes`
// ===========================================================================

describe('validateRefs — function arg typing', () => {
  it('rejects a string literal where a number is expected (no implicit coercion)', () => {
    // E4 pinned the RUN-TIME throw for this (`${add('2', 3)}`); E6 is what makes
    // it visible at SAVE time rather than only when the node dispatches.
    expect(refsIn("${add('2', 3)}")).toMatch(/argument 1.*number.*got string/i);
  });

  it('rejects a string-typed REF where a boolean is expected', () => {
    // `${nodes.a.status}` resolves to the string 'success' — the exact defect
    // spec #6 hands to E6 ("the string-where-boolean-expected rejection").
    expect(refsIn('${and(nodes.a.status, true)}')).toMatch(/argument 1.*boolean.*got string/i);
  });

  it('rejects a mistyped param ref against a declared param type', () => {
    expect(refsIn('${not(params.name)}', [param('name', 'string')])).toMatch(
      /argument 1.*boolean.*got string/i,
    );
  });

  it('rejects a mistyped node-output ref against the producer’s declared type', () => {
    const producer = node('a', { outputs: [{ name: 'text', type: 'string' }] });
    expect(refsIn('${not(nodes.a.output.text)}', [], producer)).toMatch(
      /argument 1.*boolean.*got string/i,
    );
  });

  it('types a CALL by its declared `ret` (nested calls type-check through)', () => {
    // `length` → number, so it satisfies `greater`'s numeric position, while
    // `concat` → string does not satisfy `not`'s boolean.
    expect(refsIn("${greater(length('abc'), 2)}")).toBe('');
    expect(refsIn("${not(concat('a', 'b'))}")).toMatch(/argument 1.*boolean.*got string/i);
  });

  it('checks the VARIADIC tail against the last declared arg type', () => {
    expect(refsIn("${and(true, true, 'nope')}")).toMatch(/argument 3.*boolean.*got string/i);
  });

  it('accepts a correctly-typed expression (no false-reject)', () => {
    expect(refsIn("${and(equals(nodes.a.status, 'success'), true)}")).toBe('');
    expect(refsIn('${add(1, 2)}')).toBe('');
  });
});

// ===========================================================================
// `any` is the escape hatch — the false-REJECT direction, pinned
// ===========================================================================

describe('validateRefs — `any` is not rejected anywhere', () => {
  it('does not type-check a `json` param (it has no static type)', () => {
    expect(refsIn('${not(params.blob)}', [param('blob', 'json')])).toBe('');
  });

  it('does not type-check an output of a producer that declares no contract', () => {
    expect(refsIn('${not(nodes.a.output.whatever)}')).toBe('');
  });

  it('does not type-check an `${item}` path — E4 decided the element shape is run-time-only', () => {
    // A misspelled `${item.badField}` is a RUN-time throw. This is E4's recorded
    // and owned cost, not an E6 regression: `SigType` has no element type, so
    // there is nothing to check against.
    expect(refsIn('${filter(params.rows, item.keep)}', [param('rows', 'json')])).toBe('');
  });

  it('DOES reject a predicate whose type is known and not boolean', () => {
    // The part of the collection surface that IS checkable: the predicate is a
    // concrete `string`, not an opaque `${item}` path.
    expect(refsIn("${filter(params.rows, concat(item.a, 'x'))}", [param('rows', 'json')])).toMatch(
      /argument 2.*boolean.*got string/i,
    );
    expect(refsIn("${count(params.rows, 'yes')}", [param('rows', 'json')])).toMatch(
      /argument 2.*boolean.*got string/i,
    );
  });

  it('leaves `map`’s projection arg untyped (it is a projection, not a predicate)', () => {
    expect(refsIn("${map(params.rows, concat(item.a, 'x'))}", [param('rows', 'json')])).toBe('');
  });
});

// ===========================================================================
// `${run.*}` typing
// ===========================================================================

describe('validateRefs — `${run.*}` typing', () => {
  it('types every run field as `string`', () => {
    expect(refsIn('${not(run.runId)}')).toMatch(/argument 1.*boolean.*got string/i);
    expect(refsIn('${not(run.startedAt)}')).toMatch(/argument 1.*boolean.*got string/i);
    // `triggerId`/`parentRunId` are seeded `null` by the reducer today (#5 owns
    // the real seed). They are STILL typed `string`: `any` would be strictly
    // WEAKER, not safer — it accepts `${add(run.triggerId, 1)}` as well, and the
    // run-time null throws under either typing. The nullability gap is #5's, and
    // typing them `string` never manufactures a false-accept that `any` avoids.
    expect(refsIn('${not(run.parentRunId)}')).toMatch(/argument 1.*boolean.*got string/i);
  });

  it('accepts a run field in a string position', () => {
    expect(refsIn("${concat(run.runId, '!')}")).toBe('');
  });
});

// ===========================================================================
// E7's boundary must not move
// ===========================================================================

describe('validateRefs — an index-bearing ref stays E7’s refusal ONLY', () => {
  it('reports exactly one error and never a type error', () => {
    // `checkExprStatic` returns early on an index-bearing ref, before walking the
    // index's own sub-expression. Inference MUST agree (`any`, no walk), or this
    // gains a second, misattributed report — and E7 is silently half-unblocked.
    const out = refsIn('${not(nodes.a.output.rows[0])}');
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toMatch(/E7|index/i);
    expect(out).not.toMatch(/argument/i);
  });
});

// ===========================================================================
// The FIELD-type check: `exitWhen` must be boolean (spec #6 names this as E6's)
// ===========================================================================

const loopDoc = (exitWhen: string, checkConfig: Record<string, unknown>) =>
  doc(
    [node('w'), node('check', checkConfig)],
    [edge('w', 'check', 'success')],
    [],
    [{ id: 'lp', kind: 'loop', children: ['w', 'check'], exitWhen, maxRounds: 5 }],
  );

describe('validateDoc — exitWhen must be BOOLEAN (E6 type check)', () => {
  const outputs = { outputs: [{ name: 'done', type: 'boolean' }] };
  const strOutputs = { outputs: [{ name: 'state', type: 'string' }] };

  it('accepts a boolean-typed output ref', () => {
    expect(validateDoc(loopDoc('${nodes.check.output.done}', outputs))).toEqual([]);
  });

  it('rejects a bare `${nodes.check.status}` — a status is the STRING "success"', () => {
    // The exact case params.ts:826-833 defers to E6. Availability already passes
    // (a child is settled by the reducer's own precondition); this is the TYPE.
    const errs = validateDoc(loopDoc('${nodes.check.status}', outputs));
    expect(errs.join('\n')).toMatch(/exitWhen.*boolean.*string/i);
  });

  it('accepts the usable form the spec prescribes', () => {
    expect(validateDoc(loopDoc("${equals(nodes.check.status, 'success')}", outputs))).toEqual([]);
  });

  it('rejects a string-typed output ref', () => {
    const errs = validateDoc(loopDoc('${nodes.check.output.state}', strOutputs));
    expect(errs.join('\n')).toMatch(/exitWhen.*boolean.*string/i);
  });

  it('does NOT reject an untyped (no-contract) output ref — `any` escape hatch', () => {
    expect(validateDoc(loopDoc('${nodes.check.output.done}', {}))).toEqual([]);
  });

  // Consequence of giving exitWhen the output-type map: the undeclared-NAME
  // rejection `validateRefs` already applies doc-wide now applies here too.
  it('rejects an exitWhen output name the producer does not declare', () => {
    const errs = validateDoc(loopDoc('${nodes.check.output.nope}', outputs));
    expect(errs.join('\n')).toMatch(/declares no output named 'nope'/);
  });
});

// ===========================================================================
// E6's PREMISE: every declared `ret` is honest
// ===========================================================================

// E4 shipped a `ret` on all 69 catalog entries and left it UNREAD — "flattening
// every `ret` to 'any' keeps the suite green" was true then. E6 makes it
// load-bearing: `inferExprType` types every call by its `ret`, so a wrong one is
// now a silent mis-inference (a false-accept, or a false-reject with no
// workaround). Nothing else in the suite would catch it.
//
// Each fn is driven through the REAL `substitute` path rather than by calling
// `impl` directly: that is the only way to exercise `eager` and `special` fns
// uniformly (a `special` fn has no `impl` — it takes unevaluated ASTs plus an
// injected `EvalIn`), and it checks what an author actually gets.
//
// NB a `ret: 'any'` row is deliberately vacuous (`matchesSig(v, 'any')` is
// always true). Those fns (`if`/`default`/`first`/`last`/`json`/`coalesce`) can
// each return `null`, which no concrete sig matches — `any` is the honest
// declaration, and the row exists to pin that it stays `any`.
const RET_SAMPLES: Record<string, string> = {
  // logical
  and: '${and(true, false)}',
  or: '${or(true, false)}',
  if: '${if(true, 1, 2)}',
  not: '${not(true)}',
  equals: '${equals(1, 1)}',
  greater: '${greater(2, 1)}',
  greaterOrEquals: '${greaterOrEquals(2, 1)}',
  less: '${less(1, 2)}',
  lessOrEquals: '${lessOrEquals(1, 2)}',
  default: '${default(1, 2)}',
  // string
  concat: "${concat('a', 'b')}",
  substring: "${substring('abc', 0, 2)}",
  replace: "${replace('abc', 'a', 'z')}",
  split: "${split('a,b', ',')}",
  trim: "${trim(' a ')}",
  toLower: "${toLower('A')}",
  toUpper: "${toUpper('a')}",
  startsWith: "${startsWith('abc', 'a')}",
  endsWith: "${endsWith('abc', 'c')}",
  indexOf: "${indexOf('abc', 'b')}",
  lastIndexOf: "${lastIndexOf('abcb', 'b')}",
  slug: "${slug('A b')}",
  // collection
  length: "${length('abc')}",
  empty: "${empty('')}",
  contains: "${contains('abc', 'a')}",
  first: '${first(createArray(1, 2))}',
  last: '${last(createArray(1, 2))}',
  take: '${take(createArray(1, 2), 1)}',
  skip: '${skip(createArray(1, 2), 1)}',
  join: "${join(createArray('a', 'b'), ',')}",
  intersection: '${intersection(createArray(1, 2), createArray(2, 3))}',
  union: '${union(createArray(1), createArray(2))}',
  createArray: '${createArray(1, 2)}',
  range: '${range(1, 3)}',
  filter: '${filter(createArray(1, 2), greater(item, 1))}',
  map: '${map(createArray(1, 2), add(item, 1))}',
  count: '${count(createArray(1, 2))}',
  sum: '${sum(createArray(1, 2))}',
  avg: '${avg(createArray(1, 3))}',
  // conversion
  string: '${string(1)}',
  int: "${int('2')}",
  float: "${float('2.5')}",
  bool: "${bool('true')}",
  array: "${array('a')}",
  json: '${json(\'{"a":1}\')}',
  coalesce: '${coalesce(1, 2)}',
  base64: "${base64('a')}",
  base64ToString: "${base64ToString('YQ==')}",
  encodeUriComponent: "${encodeUriComponent('a b')}",
  decodeUriComponent: "${decodeUriComponent('a%20b')}",
  // math
  add: '${add(1, 2)}',
  sub: '${sub(3, 1)}',
  mul: '${mul(2, 3)}',
  div: '${div(6, 2)}',
  mod: '${mod(5, 2)}',
  min: '${min(1, 2)}',
  max: '${max(1, 2)}',
  // date (E5a — all take an EXPLICIT timestamp; there is no clock read)
  formatDateTime: "${formatDateTime('2026-01-02T03:04:05Z', 'yyyy')}",
  addDays: "${addDays('2026-01-02T03:04:05Z', 1)}",
  addHours: "${addHours('2026-01-02T03:04:05Z', 1)}",
  addMinutes: "${addMinutes('2026-01-02T03:04:05Z', 1)}",
  addSeconds: "${addSeconds('2026-01-02T03:04:05Z', 1)}",
  addToTime: "${addToTime('2026-01-02T03:04:05Z', 1, 'Day')}",
  subtractFromTime: "${subtractFromTime('2026-01-02T03:04:05Z', 1, 'Day')}",
  startOfDay: "${startOfDay('2026-01-02T03:04:05Z')}",
  startOfHour: "${startOfHour('2026-01-02T03:04:05Z')}",
  startOfMonth: "${startOfMonth('2026-01-02T03:04:05Z')}",
  dayOfWeek: "${dayOfWeek('2026-01-02T03:04:05Z')}",
  dayOfMonth: "${dayOfMonth('2026-01-02T03:04:05Z')}",
};

describe('the catalog’s declared `ret` is honest (E6 reads it)', () => {
  it('covers EVERY catalog fn — a new fn cannot skip this audit', () => {
    // The exhaustiveness guard is the point: without it a fn added later would
    // silently ship an unaudited `ret` that E6 then trusts.
    expect(Object.keys(RET_SAMPLES).sort()).toEqual(Object.keys(FUNCTIONS).sort());
  });

  it.each(Object.entries(RET_SAMPLES))('%s returns its declared `ret`', (name, expr) => {
    const spec = FUNCTIONS[name]!;
    const value = substitute(expr, { params: {}, nodeOutputs: {}, nodeStatuses: {}, run: {} });
    expect(
      matchesSig(value, spec.ret),
      `'${name}' declares ret '${spec.ret}' but ${expr} returned ${JSON.stringify(value)}`,
    ).toBe(true);
  });
});

// ===========================================================================
// `number` means FINITE — everywhere, one definition
// ===========================================================================

// The engine had TWO definitions of "number": `matchesSig` (the fn signature
// check) required a FINITE number, while `coerce` (inbound params) and
// `matchesType` (declared outputs) accepted anything `!isNaN` — i.e. `Infinity`.
// E6 made `matchesSig`'s definition load-bearing (it types every call by `ret`),
// so the divergence stopped being academic: a declared-`number` param holding
// `Infinity` infers `number` and then FAILS its own arg check at run.
//
// These pin the single definition, at each of the three places a non-finite
// number could enter or arise. Together they are what make `ret:'number'`
// honest — a claim E6 relies on and therefore has to earn.
describe('`number` is FINITE at every boundary (E6’s `ret: number` premise)', () => {
  const c = (params: Record<string, unknown>) => ({
    params,
    nodeOutputs: {},
    nodeStatuses: {},
    run: {},
  });

  it('float() refuses an overflowing literal instead of returning Infinity', () => {
    // `float`'s regex accepts an exponent, so this reaches `Number()` and
    // overflows — the value is named HERE, so the error belongs here.
    expect(() => substitute('${float(params.big)}', c({ big: '1e400' }))).toThrow(/overflow/i);
  });

  it('int() refuses an overflowing digit string instead of returning Infinity', () => {
    expect(() => substitute('${int(params.big)}', c({ big: '9'.repeat(400) }))).toThrow(
      /overflow/i,
    );
  });

  it('arithmetic refuses a result that overflows two FINITE args', () => {
    // The corner the first pass missed: no conversion involved, both args are
    // finite and in-range, and the result is not. Without the guard the doc
    // SAVES CLEAN and throws at run inside the NEXT fn, misattributed:
    // "function 'add': argument 1 must be a number, got Infinity".
    const big = c({ big: 1e308 });
    expect(() => substitute('${mul(params.big, params.big)}', big)).toThrow(/overflow/i);
    expect(() => substitute('${add(params.big, params.big)}', big)).toThrow(/overflow/i);
    expect(() => substitute('${sub(params.big, mul(params.big, -10))}', big)).toThrow(/overflow/i);
    expect(() => substitute('${div(params.big, 0.1)}', big)).toThrow(/overflow/i);
  });

  it('sum()/avg() refuse an overflowing aggregate', () => {
    const big = c({ rows: [1e308, 1e308] });
    expect(() => substitute('${sum(params.rows)}', big)).toThrow(/overflow/i);
    expect(() => substitute('${avg(params.rows)}', big)).toThrow(/overflow/i);
  });

  it('a non-finite number LITERAL is a grammar error, not a silent Infinity', () => {
    // `NUM_RE` has no exponent, but 310 digits overflow anyway. The parser owns
    // this: `inferExprType` types a `num` literal `number` unconditionally.
    expect(() => substitute(`\${add(${'9'.repeat(310)}, 1)}`, c({}))).toThrow(/overflow/i);
  });

  it('still computes ordinary values (no false refusal)', () => {
    expect(substitute('${float(params.big)}', c({ big: '2.5' }))).toBe(2.5);
    expect(substitute('${int(params.big)}', c({ big: '2' }))).toBe(2);
    expect(substitute('${mul(params.big, 2)}', c({ big: 3 }))).toBe(6);
    expect(substitute('${sum(params.rows)}', c({ rows: [1, 2, 3] }))).toBe(6);
  });
});

describe('an inbound `number` param must be FINITE (boundary validation)', () => {
  // REACHABLE OVER HTTP: `1e400` is valid JSON, and `JSON.parse` yields
  // `Infinity` — so a POSTed param override reached `coerce`, passed its
  // `!isNaN` check, and seeded a declared-`number` param with `Infinity`.
  const decl = { params: [param('n', 'number')] };

  it('refuses an overflowing inbound number', () => {
    expect(() => resolveRunParams(decl, { n: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
  });

  it('refuses an overflowing inbound number STRING (310 digits, no exponent)', () => {
    expect(() => resolveRunParams(decl, { n: '9'.repeat(310) })).toThrow(/finite/i);
  });

  it('accepts an ordinary inbound number', () => {
    expect(resolveRunParams(decl, { n: 2 })).toEqual({ n: 2 });
    expect(resolveRunParams(decl, { n: '2.5' })).toEqual({ n: 2.5 });
  });
});

// The THIRD boundary — a declared `number` OUTPUT — lives in the reducer
// (`matchesType`, the `node.succeeded` output contract). It is pinned in
// `reduce.test.ts` alongside the other output-validation rules rather than here,
// so the contract's cases stay in one place.
