import { describe, expect, it } from 'vitest';
import { validateDoc, validatePipelineDoc, validateRefs } from '../params.js';
import type { Container, Edge, Node, Param } from '../../index.js';

/**
 * `validatePipelineDoc` is the ONE composition of the two pure validators
 * (#444). It exists so the canvas badge and the server write-gate can never
 * drift apart on WHICH rules a pipeline doc must satisfy — the drift class
 * that let `containers` be dropped in #473. These tests pin the composition
 * itself (it is exactly the union, in order, with `containers` reaching BOTH
 * validators), not the rules, which `validate-doc.test.ts` / `params.test.ts`
 * already own.
 */

const NODE: Node = { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };

function doc(
  over: Partial<{ params: Param[]; nodes: Node[]; edges: Edge[]; containers: Container[] }> = {},
) {
  return { params: [], nodes: [NODE], edges: [], containers: [], ...over };
}

describe('validatePipelineDoc — the one composition (#444)', () => {
  it('returns [] for a valid doc', () => {
    expect(validatePipelineDoc(doc())).toEqual([]);
  });

  it('is EXACTLY the union of validateDoc + validateRefs, in that order', () => {
    // A doc that breaks BOTH validators at once: a ghost container child is a
    // `validateDoc` error, an undeclared param ref is a `validateRefs` error.
    const d = doc({
      nodes: [{ ...NODE, config: { prompt: '${params.nope}' } }],
      containers: [{ id: 'c1', kind: 'stage', children: ['ghost'], join: 'all' }],
    });

    expect(validatePipelineDoc(d)).toEqual([...validateDoc(d), ...validateRefs(d)]);
    // Both halves genuinely fired — otherwise the union assertion above is
    // vacuously true and would pass even if one validator were dropped.
    expect(validateDoc(d).length).toBeGreaterThan(0);
    expect(validateRefs(d).length).toBeGreaterThan(0);
  });

  it('reports a structural rule (validateDoc is wired)', () => {
    const d = doc({ containers: [{ id: 'c1', kind: 'stage', children: ['ghost'], join: 'all' }] });
    expect(validatePipelineDoc(d)).toContain(
      "container 'c1': child 'ghost' is not a node in this pipeline",
    );
  });

  it('reports a `${}` rule (validateRefs is wired)', () => {
    const d = doc({ nodes: [{ ...NODE, config: { prompt: '${params.nope}' } }] });
    expect(validatePipelineDoc(d)).toContain(
      'nodes.a.config.prompt: ${params.nope} is not a declared param',
    );
  });

  it('passes `containers` to validateRefs too, not just validateDoc', () => {
    // A LOOP re-runs its child, which is what makes `${nodes.<id>.status}`
    // unanswerable (#6 E3) — a `validateRefs` rule that is INVISIBLE unless
    // `containers` reaches it. This pins the load-bearing half of the
    // composition that a naive "just call validateDoc" would silently lose.
    const d = doc({
      nodes: [NODE, { ...NODE, id: 'b', config: { prompt: '${nodes.a.status}' } }],
      edges: [{ id: 'e1', from: 'a', to: 'b', on: 'success' }],
      containers: [
        {
          id: 'c1',
          kind: 'loop',
          children: ['a'],
          maxRounds: 2,
          exitWhen: '${nodes.a.output.done}',
        },
      ],
    });
    expect(validatePipelineDoc(d)).toEqual(expect.arrayContaining(validateRefs(d)));
    expect(validateRefs(d).length).toBeGreaterThan(0);
  });
});
