/**
 * #1600 OR41 C0c — an inactive activity is left out of validation (ADF: "you
 * don't need to provide all required fields for an inactive activity"), so it
 * can hold an unfinished config. The doc's STRUCTURE is still validated.
 */
import { describe, expect, it } from 'vitest';
import { validatePipelineDoc } from '../validate-pipeline.js';
import type { Edge, Node } from '../../index.js';

const pos = { x: 0, y: 0 };
const doc = (nodes: Node[], edges: Edge[] = []) => ({
  params: [],
  variables: [],
  nodes,
  edges,
  containers: [],
});
const off = (n: Node): Node => ({ ...n, state: 'inactive' });

describe('validation skips an inactive node (#1600 C0c)', () => {
  // Each refused while active, and saves once switched off.
  const unfinished: [string, Node][] = [
    ['an unknown type', { id: 'x', type: 'not_a_type', config: {}, position: pos }],
    ['a required field missing', { id: 'x', type: 'fail', config: {}, position: pos }],
    [
      'a ref to a node that does not exist',
      { id: 'x', type: 'agent_task', config: { task: '${nodes.gone.output.v}' }, position: pos },
    ],
    [
      'an undeclared parameter',
      { id: 'x', type: 'agent_task', config: { task: '${params.nope}' }, position: pos },
    ],
    [
      'a variable write to an undeclared variable',
      { id: 'x', type: 'set_variable', config: { variable: 'v', value: '1' }, position: pos },
    ],
    [
      'a timeout on a control node',
      {
        id: 'x',
        type: 'fail',
        config: { message: 'm' },
        position: pos,
        policy: { timeoutSeconds: 5 },
      },
    ],
  ];
  for (const [what, n] of unfinished) {
    it(`${what}: refused while active, saves while inactive`, () => {
      expect(validatePipelineDoc(doc([n])).length).toBeGreaterThan(0);
      expect(validatePipelineDoc(doc([off(n)]))).toEqual([]);
    });
  }

  it('still refuses the STRUCTURE around it: an edge to a node that does not exist', () => {
    const n = off({ id: 'x', type: 'not_a_type', config: {}, position: pos });
    const errs = validatePipelineDoc(
      doc([n], [{ id: 'e', from: 'x', to: 'ghost', on: 'success' }]),
    );
    expect(errs.some((e) => e.includes('ghost'))).toBe(true);
  });

  it("an ACTIVE node's ref to an inactive node's declared output still validates (and fails at run, ADF's limitation)", () => {
    const src = off({
      id: 'src',
      type: 'agent_task',
      config: { task: 't', outputs: [{ name: 'v', type: 'string' }] },
      position: pos,
    });
    const reader = {
      id: 'r',
      type: 'agent_task',
      config: { task: '${nodes.src.output.v}' },
      position: pos,
    };
    expect(
      validatePipelineDoc(doc([src, reader], [{ id: 'e', from: 'src', to: 'r', on: 'success' }])),
    ).toEqual([]);
  });

  it('an inactive call node is no call edge: a self-call through it is not a cycle', () => {
    const self: Node = {
      id: 'c',
      type: 'call_pipeline',
      config: {},
      position: pos,
      call: { pipelineVersionId: 'pv_self' },
    };
    const refused = validatePipelineDoc(doc([self]), { selfId: 'pv_self' });
    expect(refused.some((e) => e.includes('pv_self'))).toBe(true);
    expect(validatePipelineDoc(doc([off(self)]), { selfId: 'pv_self' })).toEqual([]);
  });
});
