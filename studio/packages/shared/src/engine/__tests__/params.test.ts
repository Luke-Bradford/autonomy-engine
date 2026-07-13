import { describe, expect, it } from 'vitest';
import type { Edge, Node, Param, PipelineVersion, SubstitutionContext } from '../types.js';
import { ParamResolveError, SubstituteError } from '../types.js';
import { RUN_FIELDS, resolveRunParams, substitute, validateRefs } from '../params.js';

// --- helpers ---------------------------------------------------------------

function ctx(over: Partial<SubstitutionContext> = {}): SubstitutionContext {
  return {
    params: over.params ?? {},
    nodeOutputs: over.nodeOutputs ?? {},
    run: over.run ?? {},
  };
}

let nodeSeq = 0;
function node(id: string, config: Record<string, unknown>): Node {
  nodeSeq += 1;
  return { id, type: 'agent_task', config, position: { x: nodeSeq, y: 0 } };
}

function edge(from: string, to: string, on: Edge['on'], back = false): Edge {
  return { id: `${from}->${to}:${on}${back ? ':back' : ''}`, from, to, on, back };
}

function doc(
  nodes: Node[],
  edges: Edge[],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges'> {
  return { params, nodes, edges };
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
    const c = ctx({ run: { id: 'run_1' } });
    expect(substitute('${run.id}', c)).toBe('run_1');
  });

  it('throws on an unknown run field (closed set)', () => {
    expect(() => substitute('${run.nope}', ctx({ run: { id: 'r' } }))).toThrow(SubstituteError);
  });

  it('exposes RUN_FIELDS as the closed SSOT', () => {
    expect([...RUN_FIELDS]).toContain('id');
    expect([...RUN_FIELDS]).not.toContain('nope');
  });

  it('throws on an undeclared param reference', () => {
    expect(() => substitute('${params.missing}', ctx())).toThrow(SubstituteError);
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
