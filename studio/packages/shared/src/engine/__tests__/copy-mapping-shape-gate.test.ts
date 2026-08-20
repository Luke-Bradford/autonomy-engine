/**
 * #1176 — the copy mapping's three CROSS-ROW rules, at the #444 write gate.
 *
 * Until this, the three cross-row rules — the cardinality rule, the duplicate-sink
 * refusal and the `source`/`expression` XOR, then an array `.min(1)` beside a
 * private `refineMapping`, now both folded into `copyMappingShapeIssues` — were
 * reached by exactly two things:
 * the canvas Apply pre-check (*"a UX PRE-CHECK, never the gate"*) and
 * `connectors/copy.ts`'s dispatch parse. `validateDoc` is what
 * `createPipelineVersion` funnels EVERY mint through — the versions route and
 * the git-import path both — so a doc arriving from a repo could hold any of the
 * three and validate clean, failing hours later when a scheduled copy ran.
 *
 * These assert through `validateDoc`, not through `copyMappingShapeIssues`
 * directly, because the claim under test is that the GATE reads them. A unit
 * test of the shared function would pass just as happily with the call site
 * deleted — which is the failure mode this ticket exists about.
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

const row = (over: Record<string, unknown> = {}) => ({
  source: 'id',
  sink: 'id',
  type: 'integer',
  onError: 'fail',
  ...over,
});

describe('#1176 — the cross-row mapping rules reach the write gate', () => {
  it('accepts a well-formed mapping', () => {
    expect(validateDoc(doc([copyNode([row(), row({ source: 'name', sink: 'name' })])]))).toEqual(
      [],
    );
  });

  it('REFUSES a mapping that maps no columns, naming the FIELD (it has no row)', () => {
    expect(validateDoc(doc([copyNode([])]))).toEqual([
      'node.c.mapping: a copy maps no columns — add at least one mapping row',
    ]);
  });

  it('REFUSES two rows writing one sink column — silent LAST-WINS into the store', () => {
    expect(validateDoc(doc([copyNode([row(), row({ source: 'other' })])]))).toEqual([
      "node.c.mapping[1].sink: duplicate sink column 'id' (each sink column may be written by one mapping row)",
    ]);
  });

  it('REFUSES a row carrying BOTH `source` and `expression`', () => {
    expect(validateDoc(doc([copyNode([row({ expression: '${run.runId}' })])]))).toEqual([
      "node.c.mapping[0].expression: a mapping row takes either 'source' or 'expression', never both",
    ]);
  });

  it('REFUSES a row carrying NEITHER', () => {
    expect(validateDoc(doc([copyNode([{ sink: 'id', type: 'integer' }])]))).toEqual([
      "node.c.mapping[0].source: a mapping row needs either 'source' or 'expression'",
    ]);
  });

  it('accepts a row whose value comes from `expression` alone', () => {
    const only = { sink: 'imported_at', expression: '${run.startedAt}', type: 'string' };
    expect(validateDoc(doc([copyNode([only])]))).toEqual([]);
  });

  it('names EVERY offending row, not just the first', () => {
    const issues = validateDoc(
      doc([copyNode([row(), row({ source: 'a' }), row({ sink: 'x', expression: '${b}' })])]),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('mapping[1].sink');
    expect(issues[1]).toContain('mapping[2].expression');
  });

  it('leaves a non-copy node alone', () => {
    const other: Node = {
      id: 'n',
      type: 'file_read',
      config: { mapping: [] },
      position: { x: 0, y: 0 },
    };
    expect(validateDoc(doc([other]))).toEqual([]);
  });
});

describe('#1176 — what the gate still declines to read', () => {
  /*
   * A NON-ARRAY `mapping` stays a silent skip, and it is the one skip in this
   * file that is a RULE rather than a deferral: `mapping` may be a whole-value
   * `${}` that resolves to an array at dispatch, and substitution happens in the
   * reducer — so refusing it here would refuse a working pipeline at save time.
   * `copy-identifier-gate.test.ts` pins the same shape for the same reason.
   */
  it('skips a mapping it cannot see rows in', () => {
    expect(validateDoc(doc([copyNode('${params.everything}')]))).toEqual([]);
    expect(validateDoc(doc([copyNode(undefined)]))).toEqual([]);
    expect(validateDoc(doc([copyNode({ not: 'an array' })]))).toEqual([]);
  });

  /*
   * Per-FIELD types are the canvas schema's and the adapter's, both of which
   * refuse them legibly. The property under test is that a garbage row does not
   * THROW out of the gate — an uncaught `TypeError` here is a 500 where a 400
   * belongs, and an uncaught throw in the canvas's validation memo.
   */
  it('does not throw on rows that are not objects, and does not count them as a sink', () => {
    expect(validateDoc(doc([copyNode([null, 7, ['x'], '${params.col}'])]))).toEqual([]);
  });

  it('does not fold a non-string sink into the duplicate check', () => {
    // TWO rows, both with a non-string sink, deliberately: with one the guard is
    // unfalsifiable (nothing collides with it either way). Without the guard
    // these two report `duplicate sink column 'null'`, which names a column that
    // does not exist and buries the type error the adapter will give.
    const rows = [
      { source: 'a', sink: null },
      { source: 'b', sink: null },
    ];
    expect(validateDoc(doc([copyNode(rows)]))).toEqual([]);
  });

  it('compares sink names as STRINGS — the store owns what "the same column" means', () => {
    // `resolveSinkColumns` folds `ID` onto the store's own `id` and refuses the
    // collision with the store's answer (#1151). A second, store-blind fold here
    // would refuse a mapping before anyone had asked the store.
    expect(validateDoc(doc([copyNode([row(), row({ source: 'a', sink: 'ID' })])]))).toEqual([]);
  });
});
