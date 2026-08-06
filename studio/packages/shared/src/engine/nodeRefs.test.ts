import { describe, expect, it } from 'vitest';
import { parseExpr, protectEscapes, scanTemplateRefs } from './expr.js';
import { remapNodeRefs, remapNodeRefsInString } from './nodeRefs.js';

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
