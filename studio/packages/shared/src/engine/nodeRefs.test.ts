import { describe, expect, it } from 'vitest';
import { parseExpr, protectEscapes, scanTemplateRefs } from './expr.js';
import { MAX_CONFIG_DEPTH } from './params.js';
import {
  referencedNodeIds,
  remapNodeRefs,
  remapNodeRefsInString,
  renameNodeOutputRefs,
} from './nodeRefs.js';

// The ids a real paste carries. `newLocalId` is `${prefix}_${crypto.randomUUID()}`,
// so EVERY canvas-minted id contains hyphens — a scanner that reads "identifier
// runs" stops at the first `-`, misses the map, and silently leaves the copy
// pointing at the ORIGINAL node. The whole matrix uses uuid-shaped ids for that
// reason: `n_a`-style ids would go green on a scanner that is broken in production.
const A = 'n_8f14e45f-ceea-467a-9ba3-1f2c3d4e5f60';
const B = 'n_2b1c9d80-3a44-4c1e-8f77-90ab12cd34ef';
const A2 = 'n_00000000-0000-4000-8000-0000000000a1';
const B2 = 'n_00000000-0000-4000-8000-0000000000b2';

const MAP = new Map([
  [A, A2],
  [B, B2],
]);

describe('remapNodeRefsInString', () => {
  it('rewrites a whole-field output ref to the copied node', () => {
    expect(remapNodeRefsInString(`\${nodes.${A}.output.text}`, MAP)).toBe(
      `\${nodes.${A2}.output.text}`,
    );
  });

  it('rewrites a status ref', () => {
    expect(remapNodeRefsInString(`\${nodes.${A}.status}`, MAP)).toBe(`\${nodes.${A2}.status}`);
  });

  it('leaves a node that is NOT in the map pointing where it did', () => {
    const outside = 'n_deadbeef-0000-4000-8000-000000000000';
    expect(remapNodeRefsInString(`\${nodes.${outside}.output.x}`, MAP)).toBe(
      `\${nodes.${outside}.output.x}`,
    );
  });

  it('rewrites every ref in an interpolated string, and several spans', () => {
    const before = `a \${nodes.${A}.output.x} b \${nodes.${B}.status} c`;
    expect(remapNodeRefsInString(before, MAP)).toBe(
      `a \${nodes.${A2}.output.x} b \${nodes.${B2}.status} c`,
    );
  });

  it('rewrites both refs inside ONE span (a call with two arguments)', () => {
    const before = `\${default(nodes.${A}.output.x, nodes.${B}.output.y)}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(
      `\${default(nodes.${A2}.output.x, nodes.${B2}.output.y)}`,
    );
  });

  it('rewrites a ref that carries a deep tail and an index', () => {
    const before = `\${nodes.${A}.output.rows[0].name}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(`\${nodes.${A2}.output.rows[0].name}`);
  });

  it('rewrites a ref used INSIDE an index expression', () => {
    const before = `\${nodes.${B}.output.rows[nodes.${A}.output.i].name}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(
      `\${nodes.${B2}.output.rows[nodes.${A2}.output.i].name}`,
    );
  });

  it('does NOT rewrite a node id inside a quoted string literal', () => {
    const before = `\${default(params.p, 'nodes.${A}.output.x')}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(before);
  });

  it('does NOT rewrite `nodes` used as a FIELD rather than the namespace', () => {
    const before = `\${params.cfg.nodes.${A}.output.x}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(before);
  });

  it('does NOT rewrite a FIELD that merely ends in "nodes"', () => {
    // `childnodes.` carries the substring `nodes` followed by a dot, so a check
    // that only looked at the TRAILING boundary would read it as a second
    // namespace and rewrite an id that is not a node reference at all.
    const before = `\${nodes.${A}.output.childnodes.${A}}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(`\${nodes.${A2}.output.childnodes.${A}}`);
  });

  it('DOES rewrite a ref opening an argument list or an index body', () => {
    // The four legal path starts: body start, whitespace, `,`/`(`, and `[`.
    expect(remapNodeRefsInString(`\${default(nodes.${A}.status, 1)}`, MAP)).toBe(
      `\${default(nodes.${A2}.status, 1)}`,
    );
    expect(remapNodeRefsInString(`\${params.rows[nodes.${A}.output.i]}`, MAP)).toBe(
      `\${params.rows[nodes.${A2}.output.i]}`,
    );
  });

  it('does NOT rewrite outside a ${} span — plain prose is never touched', () => {
    const before = `see nodes.${A}.output.x in the docs`;
    expect(remapNodeRefsInString(before, MAP)).toBe(before);
  });

  it('leaves an escaped $${ literal alone, and restores it unharmed', () => {
    const before = `$\${nodes.${A}.output.x} and \${nodes.${A}.status}`;
    expect(remapNodeRefsInString(before, MAP)).toBe(
      `$\${nodes.${A}.output.x} and \${nodes.${A2}.status}`,
    );
  });

  it('returns an UNTERMINATED string unchanged rather than truncating it', () => {
    // `scanTemplateRefs` stops at the open brace and reports only the refs BEFORE
    // it; splicing those would silently drop the tail. The save gate reports the
    // real defect — this function must not mangle it first.
    const before = `\${nodes.${A}.status} then \${nodes.${B}.output`;
    expect(remapNodeRefsInString(before, MAP)).toBe(before);
  });

  it('is a no-op for an empty map and for a string with no ${', () => {
    expect(remapNodeRefsInString(`\${nodes.${A}.status}`, new Map())).toBe(`\${nodes.${A}.status}`);
    expect(remapNodeRefsInString('plain text', MAP)).toBe('plain text');
  });

  it('rewrites the LONGER id when one mapped id is a prefix of another', () => {
    const short = 'n_1';
    const long = 'n_1-extra';
    const map = new Map([
      [short, 'n_S'],
      [long, 'n_L'],
    ]);
    expect(remapNodeRefsInString(`\${nodes.${long}.status}`, map)).toBe('${nodes.n_L.status}');
    expect(remapNodeRefsInString(`\${nodes.${short}.status}`, map)).toBe('${nodes.n_S.status}');
  });

  it('AGREES WITH THE GRAMMAR: the parsed shape is identical except at the id', () => {
    // The property that makes a character scanner defensible: whatever it rewrites,
    // `parseExpr` must still read the SAME structure, differing only where a mapped
    // node id sits. This is the test that catches a charset drift from `readField`.
    const bodies = [
      `nodes.${A}.output.text`,
      `nodes.${A}.output.rows[0].name`,
      `default(nodes.${A}.output.x, nodes.${B}.output.y)`,
      `nodes.${B}.output.rows[nodes.${A}.output.i].name`,
    ];
    for (const body of bodies) {
      const after = remapNodeRefsInString(`\${${body}}`, MAP);
      const scan = scanTemplateRefs(protectEscapes(after));
      expect(scan.unterminatedAt).toBeNull();
      expect(scan.matches).toHaveLength(1);
      const swap = (e: unknown): unknown => {
        const node = e as { kind: string; [k: string]: unknown };
        if (node.kind === 'call') {
          return { kind: 'call', name: node.name, args: (node.args as unknown[]).map(swap) };
        }
        if (node.kind === 'ref') {
          const segments = (node.segments as { kind: string; name?: string; expr?: unknown }[]).map(
            (seg, i) =>
              seg.kind === 'index'
                ? { kind: 'index', expr: swap(seg.expr) }
                : // position 1 of a `nodes.` path is the node id — the ONE place a
                  // difference is licensed. Normalise it away on both sides.
                  { kind: 'field', name: i === 1 ? '<id>' : seg.name },
          );
          return { kind: 'ref', segments };
        }
        return { kind: node.kind, value: node.value };
      };
      expect(swap(parseExpr((scan.matches[0] as { body: string }).body))).toEqual(
        swap(parseExpr(body)),
      );
    }
  });
});

describe('remapNodeRefs (config tree)', () => {
  it('rewrites string leaves at every depth, and leaves other types alone', () => {
    const before = {
      prompt: `use \${nodes.${A}.output.text}`,
      nested: { list: [`\${nodes.${B}.status}`, 7, true, null] },
      count: 3,
    };
    expect(remapNodeRefs(before, MAP)).toEqual({
      prompt: `use \${nodes.${A2}.output.text}`,
      nested: { list: [`\${nodes.${B2}.status}`, 7, true, null] },
      count: 3,
    });
  });

  it('does not mutate its input', () => {
    const before = { prompt: `\${nodes.${A}.status}` };
    remapNodeRefs(before, MAP);
    expect(before.prompt).toBe(`\${nodes.${A}.status}`);
  });

  it('rewrites an OBJECT KEY never — only values', () => {
    const before = { [`nodes.${A}`]: `\${nodes.${A}.status}` };
    expect(remapNodeRefs(before, MAP)).toEqual({ [`nodes.${A}`]: `\${nodes.${A2}.status}` });
  });
});

describe('referencedNodeIds (#935 — which of these nodes does a config read?)', () => {
  const C = 'n_3c3c3c3c-0000-4000-8000-00000000000c';

  it('names every candidate a `${nodes.<id>…}` ref reads, at any depth, once each', () => {
    const config = {
      url: `https://x.test/\${nodes.${A}.output.body}`,
      headers: [{ value: `\${nodes.${A}.status}` }, { value: `\${add(nodes.${B}.output.n, 1)}` }],
    };
    expect(referencedNodeIds(config, [A, B, C]).sort()).toEqual([A, B].sort());
  });

  it('ignores a candidate that is only named in a quoted literal, in prose, or behind `$${`', () => {
    const config = {
      a: `\${concat('nodes.${A}.output', 'x')}`,
      b: `plain nodes.${A}.output.body prose`,
      c: `$\${nodes.${A}.output.body}`,
    };
    expect(referencedNodeIds(config, [A])).toEqual([]);
  });

  it('reads the LONGER id when one candidate is a prefix of another', () => {
    const short = 'n_1';
    const long = 'n_1-extra';
    expect(referencedNodeIds({ x: `\${nodes.${long}.output.y}` }, [short, long])).toEqual([long]);
  });

  it('is empty for no candidates and for a config with no refs', () => {
    expect(referencedNodeIds({ x: `\${nodes.${A}.output.y}` }, [])).toEqual([]);
    expect(referencedNodeIds({ x: 'nothing here', n: 3, b: null }, [A])).toEqual([]);
  });
});

describe('referencedNodeIds is a GUARD, so it reads what the rewriter may skip', () => {
  it('still reads a ref in a string holding the NUL mask char', () => {
    expect(referencedNodeIds({ x: `\u0000 \${nodes.${A}.output.y}` }, [A])).toEqual([A]);
  });

  it('still reads every span before an UNTERMINATED `${`', () => {
    expect(referencedNodeIds({ x: `\${nodes.${A}.output.y} then \${oops` }, [A])).toEqual([A]);
  });
});

describe('referencedNodeIds reads at ANY depth', () => {
  it('reads a ref nested past MAX_CONFIG_DEPTH, where the rewriter stops', () => {
    let deep: unknown = `\${nodes.${A}.output.y}`;
    for (let i = 0; i < MAX_CONFIG_DEPTH + 5; i += 1) deep = { d: deep };
    expect(referencedNodeIds(deep, [A])).toEqual([A]);
  });
});

describe('#1600 C8b — renameNodeOutputRefs (one node, one output renamed)', () => {
  const R = new Map([['entries', 'childItems']]);
  const rename = (v: unknown) => renameNodeOutputRefs(v, 'list', R);

  it('renames the output field, keeping its tail, index and the rest of the span', () => {
    expect(rename('${nodes.list.output.entries}')).toBe('${nodes.list.output.childItems}');
    expect(rename("${concat(nodes.list.output.entries[0].name, '/x')}")).toBe(
      "${concat(nodes.list.output.childItems[0].name, '/x')}",
    );
    expect(rename('a ${nodes.list.output.entries.length} b ${nodes.list.output.entries}')).toBe(
      'a ${nodes.list.output.childItems.length} b ${nodes.list.output.childItems}',
    );
  });

  it('leaves another output, a status read, another node and literals alone', () => {
    for (const s of [
      '${nodes.list.output.path}',
      '${nodes.list.status}',
      '${nodes.list2.output.entries}',
      "${concat('nodes.list.output.entries', 'x')}",
      'prose nodes.list.output.entries',
      '$${nodes.list.output.entries}',
      '${nodes.list.output.entriesX}',
    ]) {
      expect(rename(s)).toBe(s);
    }
  });

  it('refuses a read it cannot rename faithfully', () => {
    for (const s of [
      '${nodes.list.output}',
      "${nodes.list.output['entries']}",
      '${nodes.list[0]}',
      '${nodes.list.output.entries',
      `\${nodes.list.output.entries}\u0000`,
      "${concat('x, nodes.list.output.entries)}",
    ]) {
      expect(rename(s), s).toBeUndefined();
    }
  });

  it('walks every leaf, copy-on-write: unchanged subtrees keep their identity', () => {
    const untouched = { a: '${nodes.other.output.x}', b: [1, true, null] };
    const tree = { untouched, deep: [{ items: '${nodes.list.output.entries}' }] };
    const out = rename(tree) as typeof tree;
    expect(out.deep[0]).toEqual({ items: '${nodes.list.output.childItems}' });
    expect(out.untouched).toBe(untouched);
    expect(tree.deep[0]?.items).toBe('${nodes.list.output.entries}');
    const same = { a: '${nodes.list.output.path}' };
    expect(rename(same)).toBe(same);
  });

  it('one refused leaf refuses the whole tree', () => {
    expect(rename({ ok: '${nodes.list.output.entries}', bad: '${nodes.list.output}' })).toBe(
      undefined,
    );
  });

  it('past MAX_CONFIG_DEPTH, refuses a subtree that names the node and passes one that does not', () => {
    const nest = (leaf: string) => {
      let v: unknown = leaf;
      for (let d = 0; d <= MAX_CONFIG_DEPTH + 1; d += 1) v = { v };
      return v;
    };
    expect(rename(nest('${nodes.list.output.entries}'))).toBeUndefined();
    const plain = nest('${nodes.other.output.entries}');
    expect(rename(plain)).toBe(plain);
  });

  it('AGREES WITH THE GRAMMAR: the parsed shape is identical except the renamed field', () => {
    const bodies = [
      'nodes.list.output.entries',
      'nodes.list.output.entries[0].name',
      'default(nodes.list.output.entries, nodes.b.output.entries)',
      'nodes.b.output.rows[nodes.list.output.entries].name',
    ];
    // Only `nodes.list.output.<field>` may differ, and only from `entries` to
    // `childItems`; every other segment, `nodes.b.output.entries` included,
    // must parse the same.
    const swap = (e: unknown): unknown => {
      const node = e as { kind: string; [k: string]: unknown };
      if (node.kind === 'call') {
        return { kind: 'call', name: node.name, args: (node.args as unknown[]).map(swap) };
      }
      if (node.kind === 'ref') {
        const segs = node.segments as { kind: string; name?: string; expr?: unknown }[];
        const ours = segs[0]?.name === 'nodes' && segs[1]?.name === 'list';
        return {
          kind: 'ref',
          segments: segs.map((seg, i) =>
            seg.kind === 'index'
              ? { kind: 'index', expr: swap(seg.expr) }
              : {
                  kind: 'field',
                  name: ours && i === 3 && seg.name === 'childItems' ? 'entries' : seg.name,
                },
          ),
        };
      }
      return { kind: node.kind, value: node.value };
    };
    for (const body of bodies) {
      const after = rename(`\${${body}}`) as string;
      expect(after).toContain('nodes.list.output.childItems');
      const scan = scanTemplateRefs(protectEscapes(after));
      expect(scan.unterminatedAt).toBeNull();
      expect(swap(parseExpr((scan.matches[0] as { body: string }).body))).toEqual(
        swap(parseExpr(body)),
      );
    }
    expect(rename('${default(nodes.list.output.entries, nodes.b.output.entries)}')).toBe(
      '${default(nodes.list.output.childItems, nodes.b.output.entries)}',
    );
  });

  it('matches the minted id shape literally, and the longer of two prefix ids', () => {
    const id = 'n_d30cd1b0-cf27-49f2-b293-2f6a9a37490b';
    expect(renameNodeOutputRefs(`\${nodes.${id}.output.entries}`, id, R)).toBe(
      `\${nodes.${id}.output.childItems}`,
    );
    expect(renameNodeOutputRefs('${nodes.n_1-extra.output.entries}', 'n_1', R)).toBe(
      '${nodes.n_1-extra.output.entries}',
    );
    expect(renameNodeOutputRefs('${nodes.n_1.output.entries}', 'n_1-extra', R)).toBe(
      '${nodes.n_1.output.entries}',
    );
  });

  it('reads `nodes` only at the start of a path', () => {
    for (const s of ['${item.nodes.list.output.entries}', '${a.childnodes.list.output.entries}']) {
      expect(rename(s)).toBe(s);
    }
    expect(rename('${add(1, nodes.list.output.entries.length)}')).toBe(
      '${add(1, nodes.list.output.childItems.length)}',
    );
  });

  it('refuses a field the grammar reads past whitespace, and renames one a delimiter ends', () => {
    expect(rename('${nodes.list.output.entries x}')).toBeUndefined();
    expect(rename('${length(nodes.list.output.entries )}')).toBe(
      '${length(nodes.list.output.childItems )}',
    );
  });

  it('keeps a parsed `__proto__` key a key', () => {
    const tree = JSON.parse('{"__proto__": {"a": 1}, "x": "${nodes.list.output.entries}"}');
    const out = rename(tree) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(out['x']).toBe('${nodes.list.output.childItems}');
  });
});
