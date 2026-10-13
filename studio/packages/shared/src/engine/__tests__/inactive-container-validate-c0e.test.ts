/**
 * #1600 OR41 C0e — validation leaves out an INACTIVE container's run-only rules
 * and everything inside it, as C0c does for an inactive activity, so a
 * placeholder ForEach/Until with an unfinished body saves. Shape rules stay.
 */
import { describe, expect, it } from 'vitest';
import { validatePipelineDoc } from '../validate-pipeline.js';
import {
  DESCRIPTION_MAX_CHARS,
  NewPipelineVersionSchema,
  type Container,
  type Edge,
  type Node,
} from '../../index.js';

const pos = { x: 0, y: 0 };
const doc = (nodes: Node[], containers: Container[], edges: Edge[] = []) => ({
  params: [],
  variables: [],
  nodes,
  edges,
  containers,
});
const off = (c: Container): Container => ({ ...c, state: 'inactive' });
/** A body activity with a required field missing and a ref to nothing. */
const unfinished: Node = {
  id: 'b',
  type: 'agent_task',
  config: { task: '${nodes.gone.output.v}' },
  position: pos,
};

describe('validation skips an inactive container and its body (#1600 C0e)', () => {
  const cases: [string, Node[], Container][] = [
    [
      'a foreach with no items',
      [{ ...unfinished, config: {} }],
      { id: 'c', kind: 'foreach', children: ['b'] },
    ],
    [
      'a foreach with no body',
      [],
      { id: 'c', kind: 'foreach', children: [], items: '${createArray(1)}' },
    ],
    [
      'a foreach whose items reads a missing param',
      [{ ...unfinished, config: { task: 't' } }],
      { id: 'c', kind: 'foreach', children: ['b'], items: '${params.nope}' },
    ],
    [
      'a loop with no exitWhen',
      [{ ...unfinished, config: { task: 't' } }],
      { id: 'c', kind: 'loop', children: ['b'] },
    ],
    ['an empty loop', [], { id: 'c', kind: 'loop', children: [], exitWhen: '${true}' }],
    [
      'a loop whose exitWhen reads a missing param',
      [{ ...unfinished, config: { task: 't' } }],
      { id: 'c', kind: 'loop', children: ['b'], exitWhen: '${params.nope}' },
    ],
    [
      'a body activity with an unresolvable ref',
      [unfinished],
      { id: 'c', kind: 'stage', children: ['b'] },
    ],
  ];
  for (const [what, nodes, c] of cases) {
    it(`${what}: refused while active, saves while inactive`, () => {
      expect(validatePipelineDoc(doc(nodes, [c])).length).toBeGreaterThan(0);
      expect(validatePipelineDoc(doc(nodes, [off(c)]))).toEqual([]);
    });
  }

  it('shape rules still hold: a dead field and a child that is not a node', () => {
    const dead = validatePipelineDoc(
      doc(
        [{ ...unfinished, config: { task: 't' } }],
        [off({ id: 'c', kind: 'stage', children: ['b'], items: '${createArray(1)}' })],
      ),
    );
    expect(dead).toEqual(["container 'c': items is only meaningful on a foreach, not a stage"]);
    const ghost = validatePipelineDoc(
      doc([], [off({ id: 'c', kind: 'stage', children: ['ghost'] })]),
    );
    expect(ghost).toEqual(["container 'c': child 'ghost' is not a node in this pipeline"]);
  });

  it('an activity outside the inactive container is still validated', () => {
    const errs = validatePipelineDoc(
      doc(
        [
          { ...unfinished, config: { task: 't' } },
          { ...unfinished, id: 'out' },
        ],
        [off({ id: 'c', kind: 'stage', children: ['b'] })],
      ),
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.includes('out'))).toBe(true);
  });
});

describe("a container's description is bounded on write (#1600 C0e)", () => {
  const base = {
    pipelineId: 'p',
    params: [],
    outputs: [],
    nodes: [{ id: 'b', type: 'agent_task', config: { task: 't' }, position: pos }],
    edges: [],
  };
  const withDescription = (description: string) =>
    NewPipelineVersionSchema.safeParse({
      ...base,
      containers: [{ id: 'c', kind: 'stage', children: ['b'], description }],
    });

  it('accepts the limit and refuses one character more', () => {
    expect(withDescription('x'.repeat(DESCRIPTION_MAX_CHARS)).success).toBe(true);
    const over = withDescription('x'.repeat(DESCRIPTION_MAX_CHARS + 1));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path).toEqual(['containers', 0, 'description']);
  });
});

describe('the call graph and the #1669 advisory see an inactive container (#1600 C0e)', () => {
  const caller = (target: string): Node => ({
    id: 'b',
    type: 'call_pipeline',
    config: {},
    call: { pipelineVersionId: target, params: {} },
    position: pos,
  });
  const box: Container = { id: 'c', kind: 'stage', children: ['b'] };

  it("a call inside an inactive container is no call edge: no self-cycle, and a callee's is not followed", () => {
    expect(
      validatePipelineDoc(doc([caller('pv_self')], [off(box)]), { selfId: 'pv_self' }),
    ).toEqual([]);
    // pv_self → pv_b, whose only call back to pv_self sits in an inactive box.
    const outer: Node = { ...caller('pv_b'), id: 'o' };
    const resolvePipeline = (id: string) =>
      id === 'pv_b' ? { nodes: [caller('pv_self')], containers: [off(box)] } : undefined;
    expect(validatePipelineDoc(doc([outer], []), { selfId: 'pv_self', resolvePipeline })).toEqual(
      [],
    );
    // Active, the same docs are refused — the test can fail.
    expect(
      validatePipelineDoc(doc([caller('pv_self')], [box]), { selfId: 'pv_self' }).join(' '),
    ).toContain('cycle');
  });

  it("a read of an inactive ForEach's results, marked Succeeded, warns and still saves", () => {
    const fe: Container = { id: 'c', kind: 'foreach', children: ['b'], items: '${createArray(1)}' };
    const body: Node = { id: 'b', type: 'agent_task', config: { task: 't' }, position: pos };
    const reader: Node = {
      id: 'r',
      type: 'agent_task',
      config: { task: '${nodes.c.output.results}' },
      position: pos,
    };
    const edges: Edge[] = [{ id: 'e', from: 'c', to: 'r', on: 'success' }];
    const warn = (c: Container) => {
      const advisories: string[] = [];
      expect(validatePipelineDoc(doc([body, reader], [c], edges), { advisories })).toEqual([]);
      return advisories;
    };
    expect(warn(off(fe)).join(' ')).toContain("node 'c' is inactive");
    expect(warn(fe)).toEqual([]);
    expect(warn({ ...off(fe), onInactiveMarkAs: 'skipped' })).toEqual([]);
  });
});
