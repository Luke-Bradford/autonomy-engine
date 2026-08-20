/**
 * #996 §8 (M5 slice 4c, #1139) — a `copy`'s mapping column names must be LITERAL.
 *
 * The save-time half of §8, deferred from slice 4b (#1134) as untestable: a
 * pipeline doc could not hold a `copy` node until the catalog entry existed, so
 * there was nothing for the rule to refuse.
 *
 * The rule cannot live at dispatch, and that is the whole reason it is here.
 * Substitution happens in the REDUCER, so by the time a mapping reaches an
 * adapter an interpolated column name is an ordinary string and the adapter
 * cannot tell it came from an expression. Save time is the last moment the
 * distinction exists.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node, Param, PipelineVersion } from '../types.js';
import { validateDoc } from '../params.js';
import { COPY_ACTIVITY_TYPE } from '../../catalog/types.js';

function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}

const copyNode = (mapping: unknown): Node => ({
  id: 'c',
  type: COPY_ACTIVITY_TYPE,
  config: { mapping, mode: 'append' },
  position: { x: 0, y: 0 },
});

const literalRow = { source: 'id', sink: 'id', type: 'integer', onError: 'fail' };

describe('§8 — a copy mapping column name must be a literal identifier', () => {
  it('accepts literal source and sink column names', () => {
    expect(validateDoc(doc([copyNode([literalRow])]))).toEqual([]);
  });

  it('REFUSES a ${} expression as a SOURCE column name', () => {
    const issues = validateDoc(doc([copyNode([{ ...literalRow, source: '${params.col}' }])]));
    expect(issues.join(' ')).toMatch(/mapping\[0\]\.source: a column name must be a literal/);
  });

  it('REFUSES a ${} expression as a SINK column name', () => {
    const issues = validateDoc(doc([copyNode([{ ...literalRow, sink: '${params.col}' }])]));
    expect(issues.join(' ')).toMatch(/mapping\[0\]\.sink: a column name must be a literal/);
  });

  it('ALLOWS a ${} expression in `expression` — a VALUE binds as a query parameter', () => {
    // §8's first bullet, and the escape hatch the whole section rests on. A rule
    // that refused this would make the dynamic half of a copy unauthorable.
    const row = { sink: 'imported_at', expression: '${run.startedAt}', type: 'string' };
    expect(validateDoc(doc([copyNode([row])]))).toEqual([]);
  });

  it('names the OFFENDING ROW, not just the node', () => {
    const issues = validateDoc(
      doc([copyNode([literalRow, literalRow, { ...literalRow, sink: '${params.col}' }])]),
    );
    expect(issues.join(' ')).toContain('mapping[2].sink');
  });

  it('reports BOTH ends of one row independently', () => {
    const issues = validateDoc(
      doc([copyNode([{ ...literalRow, source: '${a}', sink: '${b}' }])]),
    );
    expect(issues.filter((i) => i.includes('mapping[0]'))).toHaveLength(2);
  });

  it('refuses an EMBEDDED expression, not only a whole-value one', () => {
    // `col_${params.n}` is exactly the interpolated-identifier shape §8 names —
    // it reaches the adapter as an ordinary string and cannot be distinguished
    // there, so a whole-value-only check would leave the real hazard open.
    const issues = validateDoc(doc([copyNode([{ ...literalRow, sink: 'col_${params.n}' }])]));
    expect(issues.join(' ')).toContain('mapping[0].sink');
  });

  it('leaves a non-copy node alone', () => {
    const other: Node = {
      id: 'n',
      type: 'file_read',
      config: { mapping: [{ ...literalRow, sink: '${params.col}' }] },
      position: { x: 0, y: 0 },
    };
    expect(validateDoc(doc([other]))).toEqual([]);
  });
});

describe('§8 gate is identifier-only — a malformed SHAPE is the adapter’s to refuse', () => {
  // Shape is `copyDispatchInputSchema`'s job: `Node.config` is opaque to this
  // validator and §13 gives the authoring surface to M8. A second reader of the
  // shape rules here would be one more thing to keep in step. So each of these
  // must be a SILENT SKIP — not a throw, and not a refusal.
  it('skips a mapping that is not an array', () => {
    expect(validateDoc(doc([copyNode({ not: 'an array' })]))).toEqual([]);
    expect(validateDoc(doc([copyNode(undefined)]))).toEqual([]);
    expect(validateDoc(doc([copyNode('${params.everything}')]))).toEqual([]);
  });

  it('skips a row that is not an object', () => {
    expect(validateDoc(doc([copyNode(['${params.col}', null, 7, ['x']])]))).toEqual([]);
  });

  it('skips a source/sink that is not a string', () => {
    expect(validateDoc(doc([copyNode([{ source: 42, sink: null }])]))).toEqual([]);
  });
});
