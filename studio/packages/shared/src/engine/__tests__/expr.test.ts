import { describe, expect, it } from 'vitest';
import { SubstituteError } from '../types.js';
import { parseExpr, protectEscapes, restoreEscapes, scanTemplateRefs } from '../expr.js';
import { substitute } from '../params.js';

// ===========================================================================
// #6 E1 — the expression grammar + AST. These tests pin the GRAMMAR itself
// (what parses, to what shape); `params.test.ts` pins evaluation/validation
// behaviour on top of it. The parser is the SSOT both `substitute` and
// `validateRefs` read, so a shape asserted here is the shape E2-E8 build on.
// ===========================================================================

describe('parseExpr — literals', () => {
  it('parses an integer literal', () => {
    expect(parseExpr('42')).toEqual({ kind: 'num', value: 42 });
  });

  it('parses a FLOAT literal — a float must not tokenize as a ref', () => {
    expect(parseExpr('7.5')).toEqual({ kind: 'num', value: 7.5 });
  });

  it('parses a negative float literal', () => {
    expect(parseExpr('-2.5')).toEqual({ kind: 'num', value: -2.5 });
  });

  it('parses boolean literals', () => {
    expect(parseExpr('true')).toEqual({ kind: 'bool', value: true });
    expect(parseExpr('false')).toEqual({ kind: 'bool', value: false });
  });

  it('parses string literals in either quote style', () => {
    expect(parseExpr("'a'")).toEqual({ kind: 'str', value: 'a' });
    expect(parseExpr('"a"')).toEqual({ kind: 'str', value: 'a' });
  });

  it('treats a bareword that merely STARTS like a literal as a reference', () => {
    // `truex` / `42x` are refs, not literals — the literal rules are exact.
    expect(parseExpr('truex')).toMatchObject({ kind: 'ref', source: 'truex' });
    expect(parseExpr('42x')).toMatchObject({ kind: 'ref', source: '42x' });
  });

  it('ignores insignificant whitespace inside the braces', () => {
    expect(parseExpr('  7.5  ')).toEqual({ kind: 'num', value: 7.5 });
  });
});

describe('parseExpr — string literals must be COMPLETE tokens (no silent truncation)', () => {
  // A quote-strip that only checks first-char/last-char would accept each of
  // these and silently yield a WRONG string. A malformed body must fail loud.
  it.each([
    ['${"a", "b"}', '"a", "b"'],
    ["${'a'.'b'}", "'a'.'b'"],
    ["${'a' junk 'b'}", "'a' junk 'b'"],
    ['${"a"+"b"}', '"a"+"b"'],
  ])('rejects %s rather than silently truncating it', (_label, body) => {
    expect(() => parseExpr(body)).toThrow(SubstituteError);
  });

  it('rejects an unterminated string literal', () => {
    expect(() => parseExpr("'abc")).toThrow(SubstituteError);
  });

  it('accepts a quoted literal containing delimiters', () => {
    expect(parseExpr("'a, b.c[0]'")).toEqual({ kind: 'str', value: 'a, b.c[0]' });
  });
});

describe('parseExpr — function calls', () => {
  it('parses a call with mixed literal + ref args', () => {
    expect(parseExpr("concat('a', params.b, 7.5, true)")).toEqual({
      kind: 'call',
      name: 'concat',
      args: [
        { kind: 'str', value: 'a' },
        { kind: 'ref', source: 'params.b', segments: [field('params'), field('b')] },
        { kind: 'num', value: 7.5 },
        { kind: 'bool', value: true },
      ],
    });
  });

  it('parses nested calls', () => {
    expect(parseExpr('concat(slug(params.a))')).toMatchObject({
      kind: 'call',
      name: 'concat',
      args: [{ kind: 'call', name: 'slug' }],
    });
  });

  // Spec #6's v1 catalog names are camelCase; a lowercase-only name charset
  // silently demotes most of the catalog to unresolvable REFS instead of
  // reporting an unknown function. E4 implements these names against this.
  it.each([
    'toLower',
    'toUpper',
    'greaterOrEquals',
    'startsWith',
    'base64ToString',
    'encodeUriComponent',
    'formatDateTime',
    'addDays',
    'dayOfWeek',
  ])('tokenizes catalog name %s as a CALL', (name) => {
    expect(parseExpr(`${name}(params.a)`)).toMatchObject({ kind: 'call', name });
  });

  it('admits digits in a function name', () => {
    expect(parseExpr('base64Url2(params.a)')).toMatchObject({ kind: 'call', name: 'base64Url2' });
  });

  it('keeps a top-level comma split out of quotes, parens and brackets', () => {
    const e = parseExpr("concat('a, b', slug(params.x), nodes.n.output.rows[0])");
    expect(e).toMatchObject({ kind: 'call', args: [{}, {}, {}] });
  });

  it('rejects unbalanced parens inside a call’s args', () => {
    expect(() => parseExpr('concat(slug(params.a)')).toThrow(SubstituteError);
  });

  it('treats a call missing its closing paren as a REF, not a parse error', () => {
    // A field's charset is permissive because node ids are `z.string().min(1)`
    // — an id containing parens is addressable, so reserving `(` here would
    // reject legal config. The ref then fails as unresolvable at resolve time.
    expect(parseExpr('concat(params.a')).toMatchObject({ kind: 'ref' });
  });
});

describe('parseExpr — reference paths (`.` and `[]` addressing)', () => {
  it('parses a dotted path into field segments', () => {
    expect(parseExpr('nodes.n.output.text')).toEqual({
      kind: 'ref',
      source: 'nodes.n.output.text',
      segments: [field('nodes'), field('n'), field('output'), field('text')],
    });
  });

  it('parses a literal index segment', () => {
    expect(parseExpr('nodes.n.output.rows[0]')).toEqual({
      kind: 'ref',
      source: 'nodes.n.output.rows[0]',
      segments: [
        field('nodes'),
        field('n'),
        field('output'),
        field('rows'),
        { kind: 'index', expr: { kind: 'num', value: 0 } },
      ],
    });
  });

  it('parses the spec’s dynamic-index example (ADF parity)', () => {
    // spec #6: `nodes.x.output.rows[params.i].sku`
    expect(parseExpr('nodes.x.output.rows[params.i].sku')).toEqual({
      kind: 'ref',
      source: 'nodes.x.output.rows[params.i].sku',
      segments: [
        field('nodes'),
        field('x'),
        field('output'),
        field('rows'),
        {
          kind: 'index',
          expr: { kind: 'ref', source: 'params.i', segments: [field('params'), field('i')] },
        },
        field('sku'),
      ],
    });
  });

  it('parses a QUOTED index as ONE segment, not two fields', () => {
    expect(parseExpr("nodes.n.output.m['b.c']")).toEqual({
      kind: 'ref',
      source: "nodes.n.output.m['b.c']",
      segments: [
        field('nodes'),
        field('n'),
        field('output'),
        field('m'),
        { kind: 'index', expr: { kind: 'str', value: 'b.c' } },
      ],
    });
  });

  it('parses nested bracket addressing', () => {
    expect(parseExpr('nodes.n.output.a[nodes.n.output.i[0]]')).toMatchObject({
      kind: 'ref',
      segments: [{}, {}, {}, {}, { kind: 'index', expr: { kind: 'ref' } }],
    });
  });

  // Node ids are `z.string().min(1)` (schemas/pipeline.ts) — ANY non-empty
  // string. A strict field charset would reject legal ids that exist today.
  it('accepts a permissive field charset (hyphens etc — node ids allow them)', () => {
    expect(parseExpr('nodes.my-node.output.text')).toMatchObject({
      kind: 'ref',
      segments: [field('nodes'), field('my-node'), field('output'), field('text')],
    });
  });

  it.each([
    ['an unterminated bracket', 'params.a[0'],
    ['an empty index', 'params.a[]'],
    ['an empty field', 'params..a'],
    ['a leading dot', '.params.a'],
    ['a leading bracket', '[0]'],
    ['a trailing dot', 'params.a.'],
    ['an empty expression', ''],
  ])('rejects %s', (_label, body) => {
    expect(() => parseExpr(body)).toThrow(SubstituteError);
  });
});

describe('the bare-predicate rule is structural (spec #6 Round-2)', () => {
  // NORMATIVE: predicates are BARE expressions, never nested `${}`. That is not
  // a convention — it is forced by the boundary scanner closing at the first
  // unquoted `}`, so a nested `${}` cannot survive extraction. E4 builds
  // `filter`/`map`/`count` against this; these two tests are what stop it
  // silently regressing.
  it('a nested ${} predicate is NOT EXPRESSIBLE — the body closes at the first }', () => {
    const { matches } = scanTemplateRefs('${count(a, ${item.x})}');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.body).toBe('count(a, ${item.x'); // truncated at the first `}`
  });

  it('so a nested ${} predicate fails LOUD rather than resolving', () => {
    expect(() =>
      substitute('${count(a, ${item.x})}', { params: {}, nodeOutputs: {}, run: {} }),
    ).toThrow(SubstituteError);
  });

  it('parses a BARE predicate arg as an unevaluated AST (E4 binds `item` per element)', () => {
    expect(parseExpr('count(nodes.each.output.results, greaterOrEquals(item.score, 8))')).toEqual({
      kind: 'call',
      name: 'count',
      args: [
        {
          kind: 'ref',
          source: 'nodes.each.output.results',
          segments: [field('nodes'), field('each'), field('output'), field('results')],
        },
        {
          kind: 'call',
          name: 'greaterOrEquals',
          args: [
            { kind: 'ref', source: 'item.score', segments: [field('item'), field('score')] },
            { kind: 'num', value: 8 },
          ],
        },
      ],
    });
  });
});

describe('scanTemplateRefs / protectEscapes / restoreEscapes', () => {
  it('locates every ${} boundary, non-overlapping', () => {
    const { matches, unterminatedAt } = scanTemplateRefs('a${params.x}b${params.y}');
    expect(unterminatedAt).toBeNull();
    expect(matches.map((m) => m.body)).toEqual(['params.x', 'params.y']);
    expect(matches[0]).toMatchObject({ start: 1, end: 11 });
  });

  it('reports an unterminated opener rather than silently ignoring it', () => {
    expect(scanTemplateRefs('${params.x').unterminatedAt).toBe(0);
  });

  it('does not treat a } inside a quoted arg as the closer', () => {
    expect(scanTemplateRefs('${default(params.a, "b}c")}').matches[0]!.body).toBe(
      'default(params.a, "b}c")',
    );
  });

  it('protect/restore round-trips a $${ escape, and the sentinel never leaks', () => {
    const protectedStr = protectEscapes('a $${x} b');
    expect(protectedStr).not.toContain('$${');
    expect(scanTemplateRefs(protectedStr).matches).toEqual([]); // an escape is NOT a ref
    expect(restoreEscapes(protectedStr)).toBe('a ${x} b');
  });
});

function field(name: string): { kind: 'field'; name: string } {
  return { kind: 'field', name };
}
