import { describe, expect, it } from 'vitest';
import type {
  Container,
  Edge,
  EdgeOn,
  Node,
  Param,
  PipelineVersion,
  SubstitutionContext,
} from '../types.js';
import { ParamResolveError, SubstituteError } from '../types.js';
import {
  RUN_FIELDS,
  resolveRunParams,
  substitute,
  validateRefs,
  validateWholeValue,
} from '../params.js';
import { MAX_PATH_DEPTH } from '../functions.js';

// --- helpers ---------------------------------------------------------------

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

function edge(from: string, to: string, on: EdgeOn, back = false): Edge {
  return { id: `${from}->${to}:${on}${back ? ':back' : ''}`, from, to, on, back };
}

function doc(
  nodes: Node[],
  edges: Edge[],
  params: Param[] = [],
  containers: Container[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}

// ===========================================================================
// substitute — reference kinds
// ===========================================================================

describe('substitute — reference resolution', () => {
  it('resolves ${params.<name>}', () => {
    expect(substitute('${params.topic}', ctx({ params: { topic: 'x' } }))).toBe('x');
  });

  it('resolves ${nodes.<id>.output.<name>}', () => {
    const c = ctx({ nodeOutputs: { pick: { item: 42 } } });
    expect(substitute('${nodes.pick.output.item}', c)).toBe(42);
  });

  it('resolves ${run.<field>} from the closed set', () => {
    const c = ctx({ run: { runId: 'run_1' } });
    expect(substitute('${run.runId}', c)).toBe('run_1');
  });

  it('throws on an unknown run field (closed set)', () => {
    expect(() => substitute('${run.nope}', ctx({ run: { runId: 'r' } }))).toThrow(SubstituteError);
  });

  // #6 E3: the spec's spike-hardened "SSOT bug (must fix)" — the shipped set
  // spelled the run id `id` and had no `startedAt` at all, so the spec's own
  // dynamic-filename example (`file_${params.env}_${run.runId}.json`) was
  // REJECTED. `run.id` is renamed, not aliased: the set is documented as CLOSED,
  // and a second spelling in a closed set is exactly the SSOT drift E3 fixes.
  it('exposes RUN_FIELDS as the closed SSOT, reconciled to the spec names', () => {
    expect([...RUN_FIELDS]).toContain('runId');
    expect([...RUN_FIELDS]).toContain('startedAt');
    expect([...RUN_FIELDS]).not.toContain('id');
  });

  it('rejects the pre-E3 ${run.id} spelling', () => {
    expect(() => substitute('${run.id}', ctx({ run: { runId: 'r' } }))).toThrow(SubstituteError);
  });

  it('resolves ${run.startedAt} — the run-stable timestamp', () => {
    const c = ctx({ run: { runId: 'r', startedAt: '2026-07-15T09:00:00.000Z' } });
    expect(substitute('file_${run.startedAt}.json', c)).toBe('file_2026-07-15T09:00:00.000Z.json');
  });

  // A run whose log predates the `startedAt` fact resolves it to null rather
  // than throwing: the field is a durable back-compat optional (see the
  // `run.started` event), so an old log must still fold + resolve.
  it('resolves ${run.startedAt} to null when the run log carries no stamp', () => {
    expect(substitute('${run.startedAt}', ctx({ run: { runId: 'r', startedAt: null } }))).toBe(
      null,
    );
  });

  it('throws on an undeclared param reference', () => {
    expect(() => substitute('${params.missing}', ctx())).toThrow(SubstituteError);
  });
});

// ===========================================================================
// ${nodes.<id>.status} — the T6 fan-in / OR handle
// ===========================================================================

describe('substitute — ${nodes.<id>.status}', () => {
  it('resolves each terminal status', () => {
    for (const s of ['success', 'failure', 'skipped'] as const) {
      expect(substitute('${nodes.a.status}', ctx({ nodeStatuses: { a: s } }))).toBe(s);
    }
  });

  // The language's vocabulary is the TERMINAL set only. A live status
  // (`pending`/`ready`/`dispatched`/`waiting`/`retry_pending`) is a race, not a
  // value: it means the author asked for a verdict the run has not reached.
  // `retry_pending` (F2b) is the newest member and needed no code change here —
  // being outside `TerminalNodeStatusSchema` is the whole mechanism (§A.1).
  it('throws on a non-terminal status rather than leaking a live one', () => {
    for (const s of ['pending', 'ready', 'dispatched', 'waiting', 'retry_pending'] as const) {
      expect(() => substitute('${nodes.a.status}', ctx({ nodeStatuses: { a: s } }))).toThrow(
        SubstituteError,
      );
    }
  });

  it('throws on an unknown node id', () => {
    expect(() => substitute('${nodes.ghost.status}', ctx())).toThrow(SubstituteError);
  });

  // A status error is a plain SubstituteError, NOT the internal
  // MissingValueError that `default()` catches — otherwise `default()`
  // would silently paper over a genuine race/typo with its fallback.
  it('is NOT swallowed by default()', () => {
    const c = ctx({ nodeStatuses: { a: 'dispatched' } });
    expect(() => substitute("${default(nodes.a.status, 'none')}", c)).toThrow(SubstituteError);
    expect(() => substitute("${default(nodes.ghost.status, 'none')}", ctx())).toThrow(
      SubstituteError,
    );
  });
});

// ===========================================================================
// substitute — the allowlist functions + arity
// ===========================================================================

describe('substitute — allowlist functions', () => {
  it('default() returns first when present', () => {
    expect(substitute('${default(params.a, "fb")}', ctx({ params: { a: 'x' } }))).toBe('x');
  });

  it('default() returns fallback when first is empty', () => {
    expect(substitute('${default(params.a, "fb")}', ctx({ params: { a: '' } }))).toBe('fb');
  });

  it('default() returns fallback for a missing node output', () => {
    expect(substitute('${default(nodes.x.output.v, "fb")}', ctx())).toBe('fb');
  });

  it('default() does NOT swallow a missing-param typo', () => {
    expect(() => substitute('${default(params.typo, "fb")}', ctx())).toThrow(SubstituteError);
  });

  it('concat(...) joins variadic args as strings', () => {
    const c = ctx({ params: { a: 'foo', n: 2 } });
    expect(substitute('${concat(params.a, "-", params.n)}', c)).toBe('foo-2');
  });

  it('slug(x) slugifies', () => {
    expect(substitute('${slug(params.t)}', ctx({ params: { t: 'Hello, World!' } }))).toBe(
      'hello-world',
    );
  });

  it('allows nested calls', () => {
    const c = ctx({ params: { a: '', b: 'B c' } });
    expect(substitute('${slug(default(params.a, params.b))}', c)).toBe('b-c');
  });

  it('rejects an unknown function (no eval)', () => {
    expect(() => substitute('${__import__(params.a)}', ctx({ params: { a: 1 } }))).toThrow(
      SubstituteError,
    );
  });

  it('enforces function arity', () => {
    expect(() => substitute('${slug(params.a, params.a)}', ctx({ params: { a: 'x' } }))).toThrow(
      /arity/,
    );
    expect(() => substitute('${default(params.a)}', ctx({ params: { a: 'x' } }))).toThrow(/arity/);
  });
});

// ===========================================================================
// substitute — the INERTNESS / no-injection regression (security-critical)
// ===========================================================================

describe('substitute — inertness (no-injection)', () => {
  it('never rescans a replacement: a resolved ${...} value is emitted literally', () => {
    const c = ctx({ params: { x: '${params.y}', y: 'SHOULD_NOT_APPEAR' } });
    // whole-string ref
    expect(substitute('${params.x}', c)).toBe('${params.y}');
  });

  it('embedded resolved value containing ${...} is also inert', () => {
    const c = ctx({ params: { x: '${params.y}', y: 'SHOULD_NOT_APPEAR' } });
    expect(substitute('v=${params.x}', c)).toBe('v=${params.y}');
  });

  it('single pass: two refs each resolve from the original string only', () => {
    const c = ctx({ params: { a: '${params.b}', b: 'literal-b' } });
    // The first ref resolves to a string literally containing "${params.b}";
    // it must NOT then be resolved to "literal-b".
    expect(substitute('${params.a}|${params.b}', c)).toBe('${params.b}|literal-b');
  });
});

// ===========================================================================
// substitute — escape, malformed, type preservation, recursion
// ===========================================================================

describe('substitute — escape / malformed / typing', () => {
  it('$${ emits a literal ${', () => {
    expect(substitute('$${not.a.ref}', ctx())).toBe('${not.a.ref}');
    expect(substitute('a $${x} b', ctx())).toBe('a ${x} b');
  });

  it('throws on an unterminated ${', () => {
    expect(() => substitute('${params.x', ctx({ params: { x: 1 } }))).toThrow(SubstituteError);
    expect(() => substitute('${params.x} then ${', ctx({ params: { x: 1 } }))).toThrow(
      SubstituteError,
    );
  });

  it('finds the closer at the first unquoted } and fails loud on unbalanced parens (no depth desync)', () => {
    // `}` inside a quoted string arg is skipped (real boundary is the last `}`).
    expect(substitute('${default(params.a, "b}c")}', ctx({ params: { a: null } }))).toBe('b}c');
    expect(substitute('${concat(params.a, "}")}', ctx({ params: { a: 'x' } }))).toBe('x}');
    // An unbalanced extra `)` must NOT desync the scanner past the closer — the
    // closer is the first unquoted `}`, and the malformed body fails loud.
    expect(() => substitute('${foo(params.a))}', ctx({ params: { a: 1 } }))).toThrow(
      SubstituteError,
    );
  });

  it('whole-string ref preserves native type', () => {
    expect(substitute('${params.n}', ctx({ params: { n: 7 } }))).toBe(7);
    expect(substitute('${params.b}', ctx({ params: { b: true } }))).toBe(true);
    const obj = { a: 1 };
    expect(substitute('${params.o}', ctx({ params: { o: obj } }))).toBe(obj);
    const arr = [1, 2];
    expect(substitute('${params.arr}', ctx({ params: { arr } }))).toBe(arr);
  });

  it('embedded ref coerces to string', () => {
    expect(substitute('n=${params.n}', ctx({ params: { n: 7 } }))).toBe('n=7');
    expect(substitute('b=${params.b}', ctx({ params: { b: false } }))).toBe('b=false');
  });

  it('passes non-string scalars through untouched', () => {
    expect(substitute(7, ctx())).toBe(7);
    expect(substitute(true, ctx())).toBe(true);
    expect(substitute(null, ctx())).toBe(null);
  });

  it('recurses into arrays/objects deterministically (keys sorted)', () => {
    const c = ctx({ params: { x: 'X' } });
    const out = substitute({ b: '${params.x}', a: ['${params.x}', 'lit'] }, c) as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ a: ['X', 'lit'], b: 'X' });
    expect(Object.keys(out)).toEqual(['a', 'b']); // sorted
  });
});

// ===========================================================================
// #6 E1 — literals evaluate (`[]` addressing is E7's, below)
// ===========================================================================

describe('substitute — literal expressions (#6 E1)', () => {
  it('a whole-value literal is type-preserving', () => {
    // spec #6 §Syntax: "Inside the braces is an expression (refs, function
    // calls, literals)". `${7.5}` is the number 7.5, not the string "7.5".
    expect(substitute('${7.5}', ctx())).toBe(7.5);
    expect(substitute('${-2.5}', ctx())).toBe(-2.5);
    expect(substitute('${42}', ctx())).toBe(42);
    expect(substitute('${true}', ctx())).toBe(true);
    expect(substitute('${false}', ctx())).toBe(false);
    expect(substitute("${'hello'}", ctx())).toBe('hello');
  });

  it('an embedded literal coerces to string', () => {
    expect(substitute('n=${7.5}', ctx())).toBe('n=7.5');
  });

  it('passes a FLOAT literal through a function arg', () => {
    expect(substitute("${concat('n=', 7.5)}", ctx())).toBe('n=7.5');
    expect(substitute("${concat('b=', true)}", ctx())).toBe('b=true');
  });

  it('still rejects a bareword that is not a literal', () => {
    expect(() => substitute('${truex}', ctx())).toThrow(SubstituteError);
  });
});

// ===========================================================================
// #6 E7 — deep `[]`/`.` addressing (the runtime-validated escape hatch)
//
// E1 parsed `[]` into `segments` and `params.ts` refused any index-bearing ref
// outright; E7 RESOLVES it. Spec #6 L40-41 ("Path supports dot access and `[]`
// bracket access for array indices and dynamic/dynamic-name sub-fields — ADF
// parity: nodes.x.output.rows[params.i].sku") + L111-112 ("Deep `[]`/`.` into a
// `json`/`any` output is `any` — a runtime-validated escape hatch").
// ===========================================================================

describe('substitute — deep `[]`/`.` addressing resolves (#6 E7)', () => {
  const deep = ctx({
    nodeOutputs: { a: { rows: [{ sku: 'S1' }, { sku: 'S2' }], body: { user: { name: 'ada' } } } },
    params: { i: 1, cfg: { host: 'h1', 'a.b': 'dotted', '0': 'zero' } },
  });

  it('resolves the spec’s own example shape — a literal index into an output', () => {
    expect(substitute('${nodes.a.output.rows[0].sku}', deep)).toBe('S1');
  });

  it('resolves a DYNAMIC index (spec L41: rows[params.i].sku)', () => {
    expect(substitute('${nodes.a.output.rows[params.i].sku}', deep)).toBe('S2');
  });

  it('resolves a deep `.` path into a json output', () => {
    expect(substitute('${nodes.a.output.body.user.name}', deep)).toBe('ada');
  });

  it('resolves a deep path into a json PARAM (the rule is the root TYPE, not the namespace)', () => {
    expect(substitute('${params.cfg.host}', deep)).toBe('h1');
  });

  it('resolves a QUOTED dynamic name — ONE segment, TWO dot-parts', () => {
    // `source` must never be split on `.`: `cfg['a.b']` is a single key.
    expect(substitute("${params.cfg['a.b']}", deep)).toBe('dotted');
  });

  it('indexes an OBJECT with a number key (JSON keys are strings)', () => {
    expect(substitute('${params.cfg[0]}', deep)).toBe('zero');
  });

  it('preserves the native type in whole-value mode', () => {
    expect(substitute('${nodes.a.output.rows[0]}', deep)).toEqual({ sku: 'S1' });
    expect(substitute('${nodes.a.output.body.user}', deep)).toEqual({ name: 'ada' });
  });

  it('coerces to string when embedded', () => {
    expect(substitute('sku=${nodes.a.output.rows[1].sku}', deep)).toBe('sku=S2');
  });

  it('throws on an unterminated bracket', () => {
    expect(() => substitute('${params.a[0}', ctx({ params: { a: [1] } }))).toThrow(SubstituteError);
  });
});

describe('substitute — deep addressing: MISSING is rescuable, SHAPE is not (#6 E7)', () => {
  // The error-class line. A deep path has NO static safety (E4: `SigType` has no
  // element type), so `default()` is the author's ONLY tool — and a missing key
  // is the NORMAL case for an untyped json body. But a WRONG SHAPE is a doc
  // defect, and routing that through the rescue class would mask it (E3's rule).
  const c = ctx({
    nodeOutputs: {
      a: { body: { user: { name: 'ada' }, opt: null }, rows: [{ sku: 'S1' }], text: 'hello' },
    },
  });

  it('a missing own property is RESCUABLE by default()', () => {
    expect(substitute("${default(nodes.a.output.body.nope, 'fb')}", c)).toBe('fb');
    expect(substitute("${default(nodes.a.output.body.user.nope, 'fb')}", c)).toBe('fb');
  });

  it('a missing own property BARE throws — never a silent empty string', () => {
    // toStr(undefined) === '', so returning undefined would emit '' and call it
    // a result. Loud beats silent (E5a's "loud beats a silent epoch-1970").
    expect(() => substitute('${nodes.a.output.body.nope}', c)).toThrow(SubstituteError);
    expect(() => substitute('x=${nodes.a.output.body.nope}', c)).toThrow(SubstituteError);
  });

  it('an out-of-range array index is RESCUABLE by default()', () => {
    expect(substitute("${default(nodes.a.output.rows[9], 'fb')}", c)).toBe('fb');
    expect(() => substitute('${nodes.a.output.rows[9]}', c)).toThrow(SubstituteError);
  });

  it('a NULL intermediate is MISSING, not SHAPE — `null` is JSON’s "optional field"', () => {
    // `isAbsent` already treats null as absent, so `default(…body.opt,'fb')` is
    // 'fb' today. If a null intermediate were SHAPE, `default(…body.opt.x,'fb')`
    // would THROW for {opt:null} but return 'fb' for {opt:{}} — identical author
    // intent, class decided by whether the API omits the key or spells it null.
    expect(substitute("${default(nodes.a.output.body.opt, 'fb')}", c)).toBe('fb');
    expect(substitute("${default(nodes.a.output.body.opt.x, 'fb')}", c)).toBe('fb');
    expect(() => substitute('${nodes.a.output.body.opt.x}', c)).toThrow(SubstituteError);
  });

  it('a field on a SCALAR is SHAPE — default() must NOT rescue it', () => {
    // The doc is wrong, not the data. Masking it would hide a real defect.
    expect(() => substitute("${default(nodes.a.output.text.foo, 'fb')}", c)).toThrow(
      /not an object|cannot read field/i,
    );
  });

  it('an index into a SCALAR is SHAPE — default() must NOT rescue it', () => {
    expect(() => substitute("${default(nodes.a.output.text[0], 'fb')}", c)).toThrow(
      /cannot index|not an array/i,
    );
  });

  it.each([
    ['negative', '${nodes.a.output.rows[-1]}'],
    ['fractional', '${nodes.a.output.rows[0.5]}'],
    ['boolean', '${nodes.a.output.rows[true]}'],
    ['an array', '${nodes.a.output.rows[createArray(1)]}'],
  ])('refuses %s as an array index (SHAPE, not rescuable)', (_label, expr) => {
    expect(() => substitute(expr, c)).toThrow(SubstituteError);
    expect(() => substitute(`\${default(${expr.slice(2, -1)}, 'fb')}`, c)).toThrow(SubstituteError);
  });

  it('refuses a NON-FINITE index rather than keying the string "Infinity"', () => {
    // `1e999` is valid JSON, so `JSON.parse` hands back Infinity and a `json`
    // param carries it straight in — the same silent-wrong-key hazard as null:
    // String(Infinity) is 'Infinity', which is a perfectly good own property.
    const inf = ctx({
      params: { cfg: { Infinity: 'boom', NaN: 'boom' }, blob: JSON.parse('{"n":1e999}') },
    });
    expect(() => substitute('${params.cfg[params.blob.n]}', inf)).toThrow(/finite/);
    expect(() => substitute('${params.cfg[div(0, 0)]}', inf)).toThrow(SubstituteError);
  });

  it('names a non-finite ARRAY index honestly (JSON.stringify would say "null")', () => {
    const inf = ctx({
      nodeOutputs: { a: { rows: [1] } },
      params: { blob: JSON.parse('{"n":1e999}') },
    });
    expect(() => substitute('${nodes.a.output.rows[params.blob.n]}', inf)).toThrow(/Infinity/);
  });

  it('refuses a NULL index rather than keying the empty string', () => {
    // toStr(null) === '', and `run.triggerId` is seeded literal null for EVERY
    // run today (spec L399) — so `${params.cfg[run.triggerId]}` would silently
    // look up the own property ''. A null is never a key.
    const n = ctx({ params: { cfg: { '': 'empty-key' } }, run: { triggerId: null } });
    expect(() => substitute('${params.cfg[run.triggerId]}', n)).toThrow(SubstituteError);
  });
});

describe('substitute — deep addressing never leaks host surface (#6 E7)', () => {
  // The walk resolves OWN properties of PLAIN objects/arrays only. Without the
  // `typeof === 'object'` guard a string BOXES (hasOwnProperty('abc','length')
  // is TRUE), handing back host object surface as resolved node config.
  const c = ctx({
    nodeOutputs: { a: { text: 'hello', rows: [1, 2, 3], obj: { x: 1 } } },
    run: { runId: 'run_1' },
  });

  it('does not index into a STRING (${run.runId[0]} must not be "r")', () => {
    expect(() => substitute('${run.runId[0]}', c)).toThrow(SubstituteError);
    expect(() => substitute('${nodes.a.output.text[0]}', c)).toThrow(SubstituteError);
  });

  it('does not read a STRING’s boxed .length', () => {
    expect(() => substitute('${nodes.a.output.text.length}', c)).toThrow(SubstituteError);
  });

  it('does not read an ARRAY’s .length — that is the catalog’s length(), not a field', () => {
    // hasOwnProperty([], 'length') is TRUE, so this needs its own guard.
    expect(() => substitute('${nodes.a.output.rows.length}', c)).toThrow(SubstituteError);
    expect(substitute('${length(nodes.a.output.rows)}', c)).toBe(3); // the designed form
  });

  it('does not index an array with a FIELD segment — `[]` is the one way', () => {
    expect(() => substitute('${nodes.a.output.rows.0}', c)).toThrow(SubstituteError);
    expect(substitute('${nodes.a.output.rows[0]}', c)).toBe(1); // the designed form
  });

  it('never walks the prototype chain', () => {
    for (const path of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(() => substitute(`\${nodes.a.output.obj.${path}}`, c)).toThrow(SubstituteError);
    }
  });

  it('a JSON-own `__proto__` resolves as ORDINARY DATA (and pollutes nothing)', () => {
    // JSON.parse('{"__proto__":{...}}') creates an OWN `__proto__` property, so
    // this is real data, not the prototype. The walk is READ-ONLY — it never
    // assigns — so there is no pollution vector; refusing it would instead make
    // a legitimate (if cursed) API payload unreadable.
    const parsed = ctx({ nodeOutputs: { a: { body: JSON.parse('{"__proto__":{"x":1}}') } } });
    expect(substitute('${nodes.a.output.body.__proto__.x}', parsed)).toBe(1);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
});

describe('substitute — deep addressing stays INERT (#6 E7)', () => {
  it('emits a resolved value containing ${...} LITERALLY', () => {
    // The security invariant: the walk SELECTS a sub-value of an already-resolved
    // value and never re-parses it, so untrusted data cannot become code.
    const c = ctx({ nodeOutputs: { a: { body: { evil: '${params.secret}' } } } });
    expect(substitute('${nodes.a.output.body.evil}', c)).toBe('${params.secret}');
    expect(substitute('v=${nodes.a.output.body.evil}', c)).toBe('v=${params.secret}');
  });
});

describe('substitute — MAX_PATH_DEPTH bounds the walk (#6 E7)', () => {
  // The walk re-runs PER LAMBDA ELEMENT and `charge()` counts ARRAYS ONLY, so a
  // deep path returning a scalar spends NOTHING against MAX_ARRAY_ELEMENTS_TOTAL
  // — the array budget cannot see this work. JSON.parse accepts 50k-deep nesting
  // and a `json` param takes any parsed value as-is off a run-now override, so
  // deep DATA is reachable; validateRefs is advisory (#444), so an unvalidated
  // doc reaches the engine. Measured: depth 20000 x 50k invocations = 1e9
  // lookups = ~4.4s of blocked PURE reducer, per field.
  function deepData(n: number): Record<string, unknown> {
    let v: Record<string, unknown> = { end: 'leaf' };
    for (let i = 0; i < n; i += 1) v = { a: v };
    return v;
  }

  it('the array budget does NOT see the walk — which is WHY this cap exists', () => {
    // The three budget facts the cap's rationale rests on, pinned together:
    //  1. a walk RETURNING an array is charged (it flows through evalExpr);
    //  2. an INDEX EXPR is charged (same reason);
    //  3. an intermediate array TRAVERSED by an index is NOT — selection is O(1),
    //     not a scan, so charging it would be dishonest.
    // (3) is exactly the hole MAX_PATH_DEPTH covers: a deep path returning a
    // SCALAR spends NOTHING, so the element budget can never bound the walk.
    const big = Array.from({ length: 9_000 }, (_, i) => i);
    const c = ctx({ params: { wrap: { rows: big } } });
    // (1) RESOLVING the array 12 times charges 12 x 9k = 108k > the 100k budget.
    const resolved = Array.from({ length: 12 }, () => '${params.wrap.rows}').join(',');
    expect(() => substitute(resolved, c)).toThrow(/too many array elements/);
    // (2)+(3) INDEXING it 12 times spends nothing — the traversed array is never
    // handed to evalExpr, and each walk returns a scalar. Same 12 x 9k of data.
    const indexed = Array.from({ length: 12 }, () => '${params.wrap.rows[0]}').join(',');
    expect(substitute(indexed, c)).toBe(new Array(12).fill('0').join(','));
  });

  it('resolves a path AT the cap', () => {
    const c = ctx({ params: { d: deepData(MAX_PATH_DEPTH - 3) } });
    const path = `params.d.${'a.'.repeat(MAX_PATH_DEPTH - 3)}end`;
    expect(substitute(`\${${path}}`, c)).toBe('leaf');
  });

  it('refuses a path OVER the cap (and default() does not rescue it)', () => {
    const c = ctx({ params: { d: deepData(MAX_PATH_DEPTH + 10) } });
    const path = `params.d.${'a.'.repeat(MAX_PATH_DEPTH + 10)}end`;
    expect(() => substitute(`\${${path}}`, c)).toThrow(/deep|depth|MAX_PATH_DEPTH|segments/i);
    expect(() => substitute(`\${default(${path}, 'fb')}`, c)).toThrow(/deep|depth|segments/i);
  });
});

describe('validateRefs — a malformed expression is reported ONCE (#6 E1)', () => {
  // E1 made `parseExpr` throw on bodies that previously degraded to a ref, so
  // the parse-failure fallback is now hit routinely. It must not also emit a
  // second `unresolvable reference ${}` naming an empty ref absent from the doc.
  it.each([
    ['an empty body', '${}'],
    ['an unterminated bracket', '${params.a[0}'],
    ['a stray bracket', '${a]b}'],
    ['an empty path segment', '${params..a}'],
    ['junk after a string literal', "${'a' junk 'b'}"],
  ])('reports %s exactly once', (_label, expr) => {
    const errors = validateRefs(doc([node('n', { prompt: expr })], []));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toMatch(/unresolvable reference \$\{\}/);
  });
});

describe('validateRefs — deep `[]`/`.` addressing at SAVE time (#6 E7)', () => {
  const producer = node('a', {
    outputs: [
      { name: 'rows', type: 'json' },
      { name: 'title', type: 'string' },
    ],
  });

  it('ACCEPTS a deep path into a json-typed output', () => {
    const nodes = [producer, node('b', { prompt: '${nodes.a.output.rows[0].sku}' })];
    expect(validateRefs(doc(nodes, [edge('a', 'b', 'success')]))).toEqual([]);
  });

  it('ACCEPTS a deep path into a no-contract node (nothing declared => any)', () => {
    const nodes = [node('a', {}), node('b', { prompt: '${nodes.a.output.body.x[0]}' })];
    expect(validateRefs(doc(nodes, [edge('a', 'b', 'success')]))).toEqual([]);
  });

  it('ACCEPTS a deep path into a json param', () => {
    const nodes = [node('b', { prompt: "${params.cfg['a.b'].host}" })];
    expect(validateRefs(doc(nodes, [], [{ name: 'cfg', type: 'json', required: true }]))).toEqual(
      [],
    );
  });

  it('ACCEPTS a deep ref inside default() (the soft path)', () => {
    const nodes = [producer, node('b', { prompt: "${default(nodes.a.output.rows[0].sku, 'fb')}" })];
    expect(validateRefs(doc(nodes, [edge('a', 'b', 'success')]))).toEqual([]);
  });

  // --- the scalar-root rule: deep is FOR json/any (spec L48) ----------------

  it('REJECTS a deep path into a string-typed output (statically known scalar)', () => {
    const nodes = [producer, node('b', { prompt: '${nodes.a.output.title.foo}' })];
    const errors = validateRefs(doc(nodes, [edge('a', 'b', 'success')]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/string/);
  });

  it('REJECTS a deep path into a number param', () => {
    const nodes = [node('b', { prompt: '${params.n[0]}' })];
    const errors = validateRefs(doc(nodes, [], [{ name: 'n', type: 'number', required: true }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/number/);
  });

  it.each([
    ['a run field', '${run.runId.foo}'],
    ['a node status', '${nodes.a.status.foo}'],
  ])('REJECTS a deep path into %s (both are strings)', (_label, expr) => {
    const nodes = [producer, node('b', { prompt: expr })];
    const errors = validateRefs(doc(nodes, [edge('a', 'b', 'success')]));
    // Exactly one: the scalar-root rule, not also an availability report — the
    // no-double-report property the single `refRoot` SSOT exists to give.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/string/);
  });

  // --- the E7 NOTE's hole: an index expr must be WALKED ----------------------

  it('reports a SECRET param hidden inside an index (the E7 NOTE’s hole)', () => {
    // Pre-E7 the ref returned before walking `index.expr`, so a secret smuggled
    // into an index went unreported. Resolving `[]` without recursing here would
    // have opened a real hole in the secret rule.
    const nodes = [producer, node('b', { prompt: '${nodes.a.output.rows[params.tok]}' })];
    const errors = validateRefs(
      doc(nodes, [edge('a', 'b', 'success')], [{ name: 'tok', type: 'secret', required: true }]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/secret/);
  });

  it.each([
    ['an undeclared param', '${nodes.a.output.rows[params.nope]}', /not a declared param/],
    ['an unknown function', '${nodes.a.output.rows[bogus(1)]}', /unknown function/],
    ['a non-upstream node output', '${nodes.a.output.rows[nodes.zz.output.i]}', /upstream/],
  ])('reports %s inside an index', (_label, expr, re) => {
    const nodes = [producer, node('b', { prompt: expr })];
    const errors = validateRefs(doc(nodes, [edge('a', 'b', 'success')]));
    expect(errors).toHaveLength(1); // one defect, one error
    expect(errors[0]).toMatch(re);
  });

  // --- the ROOT checks survive a deep tail ----------------------------------

  it('still name-checks the ROOT output of a deep ref', () => {
    const nodes = [producer, node('b', { prompt: '${nodes.a.output.NOPE.x}' })];
    const errors = validateRefs(doc(nodes, [edge('a', 'b', 'success')]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/declares no output named 'NOPE'/);
  });

  it('still enforces DOMINANCE on a deep ref', () => {
    const nodes = [producer, node('b', { prompt: '${nodes.a.output.rows[0].sku}' })];
    // No edge a->b: `a` does not dominate `b`, so its output is unavailable.
    const errors = validateRefs(doc(nodes, [edge('b', 'a', 'success')]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/upstream|not guaranteed/);
  });

  it('refuses an index in the ROOT region (a namespace/id/output name is literal)', () => {
    // A dynamic output name would defeat the declared-name check, so the root is
    // FIELDS ONLY; `leadingFields` stops at the first index and nothing matches.
    const nodes = [producer, node('b', { prompt: '${nodes[0].output.rows}' })];
    const errors = validateRefs(doc(nodes, [edge('a', 'b', 'success')]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unresolvable reference/);
  });

  it.each([
    ['a boolean literal', '${nodes.a.output.rows[true]}'],
    ['a boolean-returning call', '${nodes.a.output.rows[equals(1, 1)]}'],
    ['an array-returning call', '${nodes.a.output.rows[createArray(1)]}'],
  ])('REJECTS %s as an index — it can never resolve, for any data', (_label, expr) => {
    const nodes = [producer, node('b', { prompt: expr })];
    const errors = validateRefs(doc(nodes, [edge('a', 'b', 'success')]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/index must be a number or a string/);
  });

  it.each([
    ['a number', '${nodes.a.output.rows[0]}'],
    ['a string (the indexed value may be an object at run)', "${nodes.a.output.rows['k']}"],
    ['an any-typed ref', '${nodes.a.output.rows[nodes.a.output.rows]}'],
  ])('ACCEPTS %s as an index', (_label, expr) => {
    const nodes = [producer, node('b', { prompt: expr })];
    expect(validateRefs(doc(nodes, [edge('a', 'b', 'success')]))).toEqual([]);
  });

  it('reports a path over MAX_PATH_DEPTH at SAVE time too (both halves)', () => {
    const path = `params.cfg.${'a.'.repeat(MAX_PATH_DEPTH + 10)}end`;
    const nodes = [node('b', { prompt: `\${${path}}` })];
    const errors = validateRefs(doc(nodes, [], [{ name: 'cfg', type: 'json', required: true }]));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/deep|depth|segments/i);
  });
});

// ===========================================================================
// substitute — the ${} boundary scanner honors quotes + nested parens
//
// The boundary used to be found with a naive `[^}]*` regex, which truncated a
// body containing a `}` inside a quoted string arg. These regression tests
// pin the FIXED behaviour: such a `}` is now part of the body, not the
// terminator. (No existing test previously asserted the old truncating
// behaviour, so this is a pure widening — no prior test changes behaviour.)
// ===========================================================================

describe('substitute — quote/paren-aware ${} boundary scanning', () => {
  it('a `}` inside a quoted string arg does not truncate the body', () => {
    // params.a absent → default() falls back to the whole quoted literal,
    // which itself contains a `}` — the body must have been captured whole.
    expect(substitute('${default(params.a, "b}c")}', ctx({ params: { a: '' } }))).toBe('b}c');
  });

  it('concat(...) with a `}`-containing string arg resolves', () => {
    const c = ctx({ params: { x: 'foo' } });
    expect(substitute('${concat(params.x, "}")}', c)).toBe('foo}');
  });

  it('nested calls each with a `}`-containing string arg resolve', () => {
    const c = ctx({ params: { a: 'A' } });
    expect(substitute('${default(concat(params.a, "}"), "fb")}', c)).toBe('A}');
  });

  it('a genuinely unterminated ${ (missing final brace) still throws', () => {
    // Same body as the passing case above, minus the closing `}` — depth
    // returns to 0 after the call's `)` but no top-level `}` ever appears.
    expect(() => substitute('${default(params.a, "b}c")', ctx({ params: { a: '' } }))).toThrow(
      SubstituteError,
    );
  });

  it('the inertness/no-injection regression still holds alongside the new scanner', () => {
    const c = ctx({ params: { x: '${params.y}', y: 'SHOULD_NOT_APPEAR' } });
    expect(substitute('${params.x}', c)).toBe('${params.y}');
  });

  it('$${ literal-escape still works alongside the new scanner', () => {
    expect(substitute('$${not.a.ref}', ctx())).toBe('${not.a.ref}');
  });
});

// ===========================================================================
// resolveRunParams
// ===========================================================================

describe('resolveRunParams', () => {
  const params: Param[] = [
    { name: 'topic', type: 'string', required: true },
    { name: 'retries', type: 'number', required: false, default: 3 },
    { name: 'flag', type: 'boolean', required: false, default: false },
    { name: 'token', type: 'secret', required: true },
  ];

  it('applies precedence: default < override', () => {
    const out = resolveRunParams(doc([], [], params), {
      topic: 't',
      retries: 9,
      token: 'my_label',
    });
    expect(out.retries).toBe(9); // override beat default
    expect(out.flag).toBe(false); // default used
  });

  it('coerces to declared type', () => {
    const out = resolveRunParams(doc([], [], params), {
      topic: 't',
      retries: '12',
      flag: 'true',
      token: 'lbl',
    });
    expect(out.retries).toBe(12);
    expect(out.flag).toBe(true);
  });

  it('throws when a required param is unset', () => {
    expect(() => resolveRunParams(doc([], [], params), { token: 'lbl' })).toThrow(
      ParamResolveError,
    );
  });

  it('throws on a type mismatch', () => {
    expect(() =>
      resolveRunParams(doc([], [], params), { topic: 't', retries: 'abc', token: 'lbl' }),
    ).toThrow(ParamResolveError);
  });

  it('throws on an override for an undeclared param', () => {
    expect(() =>
      resolveRunParams(doc([], [], params), { topic: 't', token: 'lbl', bogus: 1 }),
    ).toThrow(ParamResolveError);
  });

  it('STRIPS a secret param from the context (value never enters params)', () => {
    const out = resolveRunParams(doc([], [], params), {
      topic: 't',
      token: 'my_label',
    });
    expect(out).not.toHaveProperty('token');
    expect(Object.values(out)).not.toContain('my_label');
  });

  it('still enforces a required secret being unset (without echoing a value)', () => {
    let msg = '';
    try {
      resolveRunParams(doc([], [], params), { topic: 't' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/token/);
  });

  it('refuses a secret value that is not a valid label, never echoing it', () => {
    const secretish = 'sk-REALLY_SECRET_VALUE_WITH SPACES';
    let msg = '';
    try {
      resolveRunParams(doc([], [], params), { topic: 't', token: secretish });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(secretish);
    expect(msg).toMatch(/label/);
  });
});

// ===========================================================================
// validateRefs
// ===========================================================================

describe('validateRefs — params + functions', () => {
  const declared: Param[] = [
    { name: 'topic', type: 'string', required: true },
    { name: 'apiKey', type: 'secret', required: true },
  ];

  it('a clean doc → []', () => {
    const d = doc([node('a', { brief: '${params.topic}' })], [], declared);
    expect(validateRefs(d)).toEqual([]);
  });

  it('flags an undeclared param', () => {
    const d = doc([node('a', { brief: '${params.nope}' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/not a declared param/);
  });

  it('refuses a secret-typed param ref anywhere', () => {
    const d = doc([node('a', { brief: '${params.apiKey}' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/secret-typed/);
  });

  it('flags a bad function arity', () => {
    const d = doc([node('a', { brief: '${slug(params.topic, params.topic)}' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/arity/);
  });

  it('flags an unknown function', () => {
    const d = doc([node('a', { brief: '${danger(params.topic)}' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/unknown function/);
  });

  it('flags an unterminated ${', () => {
    const d = doc([node('a', { brief: 'x ${params.topic' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/unterminated/);
  });

  it('flags an unknown run field', () => {
    const d = doc([node('a', { brief: '${run.bogus}' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/run field/);
  });

  it('agrees with substitute: a `}` inside a quoted arg does not truncate the body', () => {
    // Same boundary scanner as `substitute` — a clean expression whose only
    // `}` is inside a quoted string arg must not be misparsed/flagged.
    const d = doc([node('a', { brief: '${default(params.topic, "b}c")}' })], [], declared);
    expect(validateRefs(d)).toEqual([]);
  });

  it('still flags a genuinely unterminated ${ once the body contains a quoted `}`', () => {
    const d = doc([node('a', { brief: '${default(params.topic, "b}c")' })], [], declared);
    expect(validateRefs(d).join('\n')).toMatch(/unterminated/);
  });
});

describe('validateRefs — node-output availability / dominance', () => {
  it('a strict-upstream (dominating) ref is ok unconditionally', () => {
    const d = doc(
      [node('a', {}), node('b', { in: '${nodes.a.output.v}' })],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('a self ref is an error', () => {
    const d = doc([node('a', { in: '${nodes.a.output.v}' })], []);
    expect(validateRefs(d).join('\n')).toMatch(/does not name an upstream node/);
  });

  it('a downstream ref is an error', () => {
    const d = doc(
      [node('a', { in: '${nodes.b.output.v}' }), node('b', {})],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(d).join('\n')).toMatch(/does not name an upstream node/);
  });

  it('a NON-dominating ref (one branch of a join) needs default()', () => {
    // a -> b (success), a -> c (success), b -> d, c -> d.  b does NOT dominate d.
    const nodes = [node('a', {}), node('b', {}), node('c', {}), node('d', {})];
    const edges = [
      edge('a', 'b', 'success'),
      edge('a', 'c', 'success'),
      edge('b', 'd', 'success'),
      edge('c', 'd', 'success'),
    ];
    const bad = doc([...nodes.slice(0, 3), node('d', { in: '${nodes.b.output.v}' })], edges);
    expect(validateRefs(bad).join('\n')).toMatch(/wrap it in default/);

    const ok = doc(
      [...nodes.slice(0, 3), node('d', { in: '${default(nodes.b.output.v, "fb")}' })],
      edges,
    );
    expect(validateRefs(ok)).toEqual([]);

    // a DOES dominate d → unconditional ref to a is fine.
    const domOk = doc([...nodes.slice(0, 3), node('d', { in: '${nodes.a.output.v}' })], edges);
    expect(validateRefs(domOk)).toEqual([]);
  });

  // A `skipped` edge inverts the guarantee its predecessor carried: `c` runs
  // only when `b` was SKIPPED, and `b` is skipped precisely because `a` did NOT
  // succeed. Inheriting b's `guaranteed` set (which contains `a`) into `c`
  // would assert a succeeded on the one path where it provably didn't — the
  // checker would ACCEPT the doc and the run would then hard-fail at dispatch
  // (`prepInput` throws → finishRun{invalid_event}).
  it('a ref through a skipped edge is NOT guaranteed — nothing upstream survives a skip', () => {
    const edges = [edge('a', 'b', 'success'), edge('b', 'c', 'skipped')];
    const bad = doc(
      [node('a', {}), node('b', {}), node('c', { in: '${nodes.a.output.v}' })],
      edges,
    );
    expect(validateRefs(bad).join('\n')).toMatch(/wrap it in default/);

    // default() is the correct escape hatch — it tolerates the absent output.
    const ok = doc(
      [node('a', {}), node('b', {}), node('c', { in: '${default(nodes.a.output.v, "fb")}' })],
      edges,
    );
    expect(validateRefs(ok)).toEqual([]);
  });

  it("a ref to the skipped predecessor's OWN output is not guaranteed either", () => {
    // b was skipped → b never produced an output at all.
    const edges = [edge('a', 'b', 'success'), edge('b', 'c', 'skipped')];
    const bad = doc(
      [node('a', {}), node('b', {}), node('c', { in: '${nodes.b.output.v}' })],
      edges,
    );
    expect(validateRefs(bad).join('\n')).toMatch(/wrap it in default/);
  });

  it('a failure-branch-only ref needs default(); with default() it is ok', () => {
    // a --failure--> h (handler); h --success--> d.  h is NOT guaranteed at d
    // via the whole graph (a may succeed → h never runs), so an unconditional
    // ref to a's OUTPUT from a node reachable via failure is not available.
    const edges = [edge('a', 'h', 'failure'), edge('h', 'd', 'success')];
    const bad = doc(
      [node('a', {}), node('h', {}), node('d', { in: '${nodes.a.output.v}' })],
      edges,
    );
    // `a` ran (it's on every path) but did NOT necessarily succeed (h is reached
    // only when a failed), so a's outputs are not guaranteed → needs default().
    expect(validateRefs(bad).join('\n')).toMatch(/wrap it in default/);

    const ok = doc(
      [node('a', {}), node('h', {}), node('d', { in: '${default(nodes.a.output.v, "fb")}' })],
      edges,
    );
    expect(validateRefs(ok)).toEqual([]);
  });

  it('a loop-sibling (back-edge) ref needs default(); with default() it is ok', () => {
    // a -> b (success), b --back--> a.  From a, reading b's output is only
    // legal via default() (a re-runs and reads the previous round's value).
    const edges = [edge('a', 'b', 'success'), edge('b', 'a', 'success', true)];
    const bad = doc([node('a', { in: '${nodes.b.output.v}' }), node('b', {})], edges);
    expect(validateRefs(bad).join('\n')).toMatch(/wrap it in default/);

    const ok = doc([node('a', { in: '${default(nodes.b.output.v, "fb")}' }), node('b', {})], edges);
    expect(validateRefs(ok)).toEqual([]);
  });

  it('an edge-less doc uses the implicit success-chain for dominance', () => {
    // No edges → implicit a->b->c. c may reference a and b unconditionally.
    const d = doc(
      [
        node('a', {}),
        node('b', {}),
        node('c', { in: '${concat(nodes.a.output.v, nodes.b.output.v)}' }),
      ],
      [],
    );
    expect(validateRefs(d)).toEqual([]);
  });
});

// ===========================================================================
// validateRefs — node-output NAME against the producer's DECLARED outputs
// (deferred req c). A ref to `${nodes.X.output.NAME}` where X DECLARES an
// output contract (`config.outputs`) but has no output named NAME can only
// fail at run time, so it is rejected statically — the same `config.outputs`
// the reducer uses as its runtime output SSOT (storeOutputs/validateOutputs).
// ===========================================================================

describe('validateRefs — node-output NAME against declared outputs (req c)', () => {
  // A producer node that DECLARES an output contract via `config.outputs`.
  function producer(id: string, outputs: { name: string; type: string }[]): Node {
    return node(id, { outputs });
  }

  it('a ref to a DECLARED output name is ok', () => {
    const d = doc(
      [producer('a', [{ name: 'v', type: 'string' }]), node('b', { in: '${nodes.a.output.v}' })],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('a ref to an UNDECLARED output name is an error (producer declares a contract)', () => {
    const d = doc(
      [
        producer('a', [{ name: 'v', type: 'string' }]),
        node('b', { in: '${nodes.a.output.missing}' }),
      ],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(d).join('\n')).toMatch(/declares no output named 'missing'/);
  });

  it('a producer with NO declared outputs enforces no name contract (any name ok)', () => {
    // config `{}` → no `outputs` array → the reducer stores the whole payload,
    // so any referenced name may exist at run time; nothing to reject statically.
    const d = doc(
      [node('a', {}), node('b', { in: '${nodes.a.output.anything}' })],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('an undeclared name inside default() is NOT rejected (runtime falls back)', () => {
    // `default(nodes.a.output.missing, "fb")` catches the missing output and
    // uses the fallback, so an unknown name resolves fine — a static reject
    // here would be a false reject.
    const d = doc(
      [
        producer('a', [{ name: 'v', type: 'string' }]),
        node('b', { in: '${default(nodes.a.output.missing, "fb")}' }),
      ],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('the accepted-name set matches what the reducer would store (consistency)', () => {
    // `v` is declared → accepted; `w` is not → rejected. This is exactly the
    // set `storeOutputs` keeps, so static validation and runtime storage agree.
    const decls = [{ name: 'v', type: 'string' }];
    const okay = doc(
      [producer('a', decls), node('b', { in: '${nodes.a.output.v}' })],
      [edge('a', 'b', 'success')],
    );
    const bad = doc(
      [producer('a', decls), node('b', { in: '${nodes.a.output.w}' })],
      [edge('a', 'b', 'success')],
    );
    expect(validateRefs(okay)).toEqual([]);
    expect(validateRefs(bad).join('\n')).toMatch(/declares no output named 'w'/);
  });
});

// ===========================================================================
// #6 E2 — the interpolation model.
//
// `substitute` already resolved whole-value vs embedded before E2; E2 lifts the
// mode decision into ONE SSOT (`interpolationMode`) that the evaluator and the
// static checkers share, and adds `validateWholeValue` for the fields where an
// embedded expression is a BUG rather than a choice (spec #6's spike-hardened
// block: "`if.condition` / `foreach.items` MUST be whole-value mode ... proven
// that an embedded boolean silently coerces to the string 'true'").
//
// The guards below pin `substitute`'s semantics as UNCHANGED — E2 is a pure
// refactor there. They exist because the obvious reading of Round-2 I1 ("mode
// is decided after canonical-trimming the field") is a blanket trim inside
// `substitute`, which would silently re-type every `"${x}\n"` template and eat
// the newline. The trim belongs to whole-value-REQUIRED fields only.
// ===========================================================================

describe('substitute — interpolation mode (E2 refactor: semantics UNCHANGED)', () => {
  it('an exact lone ${} preserves the resolved value native type', () => {
    expect(substitute('${params.n}', ctx({ params: { n: 42 } }))).toBe(42);
    expect(substitute('${params.f}', ctx({ params: { f: true } }))).toBe(true);
    expect(substitute('${params.o}', ctx({ params: { o: [1, 2] } }))).toEqual([1, 2]);
  });

  it('an embedded ${} coerces to string', () => {
    expect(substitute('n=${params.n}', ctx({ params: { n: 42 } }))).toBe('n=42');
  });

  it('does NOT trim a padded lone ${}: it stays embedded, and the padding survives', () => {
    // Round-2 I1's trim is scoped to whole-value-REQUIRED fields (exitWhen /
    // #4's if.condition, foreach.items) — NOT to every config string.
    expect(substitute(' ${params.n} ', ctx({ params: { n: 42 } }))).toBe(' 42 ');
  });

  it('does NOT eat a trailing newline, nor re-type the value (the blanket-trim trap)', () => {
    // `"${x}\n"` is an ordinary prompt/file-body template. A blanket trim would
    // flip it to whole-value mode: the \n vanishes and an array output stops
    // being a string. Both are silent wrong-value bugs.
    expect(substitute('${params.text}\n', ctx({ params: { text: 'hi' } }))).toBe('hi\n');
    expect(substitute('${params.rows}\n', ctx({ params: { rows: [1, 2] } }))).toBe('[1,2]\n');
  });

  it('a literal field is returned with its $${ escapes restored', () => {
    // Literal is its own mode now; it must still unescape (there is no ref to
    // resolve, but `$${` still means a literal `${`).
    expect(substitute('$${not.a.ref}', ctx())).toBe('${not.a.ref}');
    expect(substitute('plain text', ctx())).toBe('plain text');
  });

  it('INERTNESS holds across the refactor: a resolved value is never rescanned', () => {
    const c = ctx({ params: { evil: '${params.secret}', secret: 'LEAKED' } });
    expect(substitute('${params.evil}', c)).toBe('${params.secret}');
    expect(substitute('x=${params.evil}', c)).toBe('x=${params.secret}');
  });
});

describe('validateWholeValue — the reusable whole-value-required checker', () => {
  const check = (v: string): string[] => {
    const errors: string[] = [];
    validateWholeValue('f.cond', v, errors, 'condition');
    return errors;
  };

  it('accepts an exact lone ${} expression', () => {
    expect(check('${nodes.a.output.done}')).toEqual([]);
  });

  it('accepts a PADDED lone ${} — the canonical trim decides the mode (I1)', () => {
    // The whole point of I1: a stray space must not demote the boolean.
    expect(check(' ${nodes.a.output.done} ')).toEqual([]);
    expect(check('${nodes.a.output.done}\n')).toEqual([]);
  });

  it('rejects an embedded expression, naming the string-coercion trap', () => {
    expect(check('done=${nodes.a.output.done}').join(' ')).toContain('whole-value');
  });

  it('rejects a literal (no expression at all)', () => {
    expect(check('true').join(' ')).toContain('must be a ${...} expression');
  });

  it('stays SILENT on an unterminated ${ — the grammar scan owns that diagnostic', () => {
    // It must not report the open brace as a MODE defect: the caller always
    // scans for grammar errors too, so owning it here would double-report it.
    // `validate-doc.test.ts` pins the "reported exactly once" property end-to-end,
    // which is the only place that claim is meaningful.
    expect(check('${nodes.a.output.done')).toEqual([]);
  });

  it('returns the parsed whole-value body so the caller need not rescan', () => {
    const errors: string[] = [];
    const got = validateWholeValue('f.cond', ' ${nodes.a.output.done} ', errors, 'condition');
    expect(errors).toEqual([]);
    expect(got?.body).toBe('nodes.a.output.done');
  });

  it('returns null when it reported an error', () => {
    expect(validateWholeValue('f.cond', 'x=${a.b}', [], 'condition')).toBeNull();
  });
});

// ===========================================================================
// validateRefs — ${nodes.<id>.status} availability (`settled`, #6 E3)
// ===========================================================================
//
// The availability rule for a STATUS ref is "is `x` guaranteed TERMINAL here",
// which is a different question from `guaranteed`'s "did `x` SUCCEED here" —
// hence its own must-analysis. These tests pin the two false-accepts the
// planning gate found by counterexample; each would statically accept a doc
// that then THROWS at run time, with no `default()` escape hatch.

describe('validateRefs — ${nodes.<id>.status} (#6 E3 T6)', () => {
  it('reads a status where the OUTPUT is not readable (the ADF fan-in/OR case)', () => {
    // `b` runs only when `a` FAILED, so a's outputs do not exist here — but a is
    // unambiguously terminal, which is the whole point of the status handle.
    const nodes = [node('a', {}), node('b', { note: '${nodes.a.status}' })];
    expect(validateRefs(doc(nodes, [edge('a', 'b', 'failure')]))).toEqual([]);

    const bad = [node('a', {}), node('b', { note: '${nodes.a.output.text}' })];
    expect(validateRefs(doc(bad, [edge('a', 'b', 'failure')]))).not.toEqual([]);
  });

  it('reads a status transitively through a success chain', () => {
    const nodes = [node('a', {}), node('b', {}), node('c', { note: '${nodes.a.status}' })];
    const edges = [edge('a', 'b', 'success'), edge('b', 'c', 'success')];
    expect(validateRefs(doc(nodes, edges))).toEqual([]);
  });

  it('rejects a status ref to a node that is not upstream at all', () => {
    const nodes = [node('a', { note: '${nodes.b.status}' }), node('b', {})];
    expect(validateRefs(doc(nodes, [edge('a', 'b', 'success')]))).not.toEqual([]);
  });

  // COUNTEREXAMPLE A (planning gate): `join:'any'` + a CONTAINER predecessor.
  // `computeGraph` tracks node ids only, but the reducer's readiness graph spans
  // nodes ∪ containers — so the container edge is invisible here and live there.
  // Under `any`, R dispatches the moment the container satisfies, while `a` is
  // still running. Nothing tracked is guaranteed → the analysis must yield ∅.
  it("rejects a status ref under join:'any' with an untracked (container) predecessor", () => {
    const nodes = [node('a', {}), node('r', { join: 'any', note: '${nodes.a.status}' })];
    const edges = [edge('c', 'r', 'success'), edge('a', 'r', 'success')];
    expect(validateRefs(doc(nodes, edges))).not.toEqual([]);
  });

  it("accepts the same shape under join:'all' (an untracked pred only ADDS a requirement)", () => {
    const nodes = [node('a', {}), node('r', { note: '${nodes.a.status}' })];
    const edges = [edge('c', 'r', 'success'), edge('a', 'r', 'success')];
    expect(validateRefs(doc(nodes, edges))).toEqual([]);
  });

  // COUNTEREXAMPLE A' (planning gate): the SKIP INVERSION. `r` is skipped as soon
  // as ONE incoming group is dead — its OTHER predecessors may still be running.
  // So a skipped `r` says nothing about `a`, and settledness must NOT propagate
  // through an `on:'skipped'` edge (the same inversion `guaranteed` handles).
  it('does not propagate settledness through a skipped edge', () => {
    const nodes = [
      node('a', {}),
      node('x', {}),
      node('r', {}),
      node('s', { note: '${nodes.a.status}' }),
    ];
    const edges = [edge('x', 'r', 'success'), edge('a', 'r', 'success'), edge('r', 's', 'skipped')];
    expect(validateRefs(doc(nodes, edges))).not.toEqual([]);
  });

  // The shape that makes the skip inversion LOAD-BEARING rather than merely
  // conservative — the intersection alone cannot catch this one, because the
  // thing that kills `r` is invisible to the analysis.
  //
  // `r` has an untracked (container) predecessor `c` and a tracked one `a`, under
  // the default `all` join. `c` being skipped kills r's `c` group → `r` is
  // skipped — while `a` may still be RUNNING. So settled[r] = {a} names a live
  // node, and `s`, reached by r's skip, must not inherit it. Without the
  // inversion this is accepted and then throws at dispatch.
  it("does not inherit a skipped node's own predecessors (untracked predecessor)", () => {
    const nodes = [node('a', {}), node('r', {}), node('s', { note: '${nodes.a.status}' })];
    const edges = [edge('c', 'r', 'success'), edge('a', 'r', 'success'), edge('r', 's', 'skipped')];
    expect(validateRefs(doc(nodes, edges))).not.toEqual([]);
  });

  it('still reads the SKIPPED node itself, which is terminal by definition', () => {
    const nodes = [node('a', {}), node('r', {}), node('s', { note: '${nodes.r.status}' })];
    const edges = [edge('a', 'r', 'success'), edge('r', 's', 'skipped')];
    expect(validateRefs(doc(nodes, edges))).toEqual([]);
  });

  // COUNTEREXAMPLE B (planning gate): a back-edge bounce RESETS its body to
  // `pending` mid-run, so a node that had settled can un-settle while an
  // off-body sibling stays ready. Refused doc-wide rather than modelled.
  // A LOOP container re-runs its children with NO back-edge in the doc
  // (`resetContainerRound` fires off `exitWhen`/`maxRounds` alone), so an
  // edge-only guard misses it. Caught by BOTH pre-PR review lenses: the shape
  // below validated clean and then killed the run —
  // `finishRun{failure, invalid_event}`, "dispatch prep failed for node 'r':
  // ${nodes.z.status}: node 'z' has not settled here".
  it('refuses a status ref in a doc carrying a LOOP container (it re-runs children)', () => {
    const nodes = [
      node('z', {}),
      node('q', {}),
      node('w', {}),
      node('r', { saw: '${nodes.z.status}' }),
    ];
    const edges = [edge('z', 'w', 'success'), edge('w', 'r', 'success')];
    const loop = {
      id: 'c',
      kind: 'loop' as const,
      children: ['z', 'q'],
      exitWhen: '${nodes.q.output.done}',
    };
    expect(validateRefs(doc(nodes, edges, [], [loop]))).not.toEqual([]);
  });

  // ...but a STAGE never re-rounds (`stepContainers` exits it once its children
  // are terminal), so it must not disable the handle.
  it('still allows a status ref in a doc whose only container is a STAGE', () => {
    const nodes = [node('z', {}), node('w', { saw: '${nodes.z.status}' })];
    const edges = [edge('z', 'w', 'success')];
    const stage = { id: 'c', kind: 'stage' as const, children: ['z'] };
    expect(validateRefs(doc(nodes, edges, [], [stage]))).toEqual([]);
  });

  it('refuses a status ref anywhere in a doc carrying a back-edge', () => {
    const nodes = [node('a', {}), node('b', { note: '${nodes.a.status}' }), node('z', {})];
    const edges = [
      edge('a', 'b', 'success'),
      edge('b', 'z', 'success'),
      { ...edge('z', 'a', 'success', true), maxBounces: 2 },
    ];
    const errors = validateRefs(doc(nodes, edges));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/back-edge/);
  });
});

// ===========================================================================
// validateRefs — the `guaranteed` false-accept the status work uncovered
// ===========================================================================

describe("validateRefs — join:'any' + an untracked predecessor (#6 E3)", () => {
  // The SAME hole as counterexample A, on the pre-existing OUTPUT rule: under
  // `any`, `r` may dispatch on the container edge alone while `a` is still
  // running, so a's outputs are NOT guaranteed. Tracked-edge-only intersection
  // silently accepted this. Fixed alongside `settled` so the two analyses cannot
  // disagree about the same graph.
  it("rejects an output ref under join:'any' with an untracked predecessor", () => {
    const nodes = [node('a', {}), node('r', { join: 'any', note: '${nodes.a.output.text}' })];
    const edges = [edge('c', 'r', 'success'), edge('a', 'r', 'success')];
    expect(validateRefs(doc(nodes, edges))).not.toEqual([]);
  });

  it("still accepts an output ref under the default 'all' join", () => {
    const nodes = [node('a', {}), node('r', { note: '${nodes.a.output.text}' })];
    const edges = [edge('c', 'r', 'success'), edge('a', 'r', 'success')];
    expect(validateRefs(doc(nodes, edges))).toEqual([]);
  });
});
