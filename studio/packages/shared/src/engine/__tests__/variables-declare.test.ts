import { describe, expect, it } from 'vitest';
import {
  NewPipelineVersionSchema,
  PipelineVersionSchema,
  VariableDefSchema,
  type VariableDef,
} from '../../schemas/pipeline.js';
import { validatePipelineDoc } from '../params.js';

/**
 * #844 V1 — pipeline variables are DECLARED on the version doc (spec
 * `2026-09-27-foundation-pipeline-variables.md` V-D1). Inert: nothing reads or
 * writes them yet, so what this slice owns is the declaration's shape and the
 * save-time rules on it.
 */
function doc(variables: unknown[]) {
  return {
    params: [],
    nodes: [],
    edges: [],
    containers: [],
    variables: variables as VariableDef[],
  };
}

function errorsFor(variables: unknown[]): string[] {
  return validatePipelineDoc(doc(variables));
}

describe('VariableDefSchema', () => {
  it('accepts the four variable types and refuses json/secret', () => {
    for (const type of ['string', 'number', 'boolean', 'array']) {
      expect(VariableDefSchema.safeParse({ name: 'v', type, default: null }).success).toBe(true);
    }
    // `json` is a PARAM type; `secret` has nowhere safe to live in a value that
    // is written to the run log in clear (V-D1).
    for (const type of ['json', 'secret']) {
      expect(VariableDefSchema.safeParse({ name: 'v', type, default: null }).success).toBe(false);
    }
  });

  it('reads a version with no `variables` key as no variables (old rows, old exports)', () => {
    const parsed = PipelineVersionSchema.parse({
      id: 'pv_1',
      resourceId: 'res_1',
      pipelineId: 'pl_1',
      version: 1,
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      catalogVersion: 1,
      createdAt: 1,
    });
    expect(parsed.variables).toEqual([]);
  });

  it('carries declared variables through the write schema', () => {
    const variables = [{ name: 'count', type: 'number', default: 0, description: 'rounds' }];
    const parsed = NewPipelineVersionSchema.parse({
      pipelineId: 'pl_1',
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      variables,
    });
    expect(parsed.variables).toEqual(variables);
  });
});

describe('validateDoc — variable declarations (V-D1)', () => {
  it('accepts a default of each declared type', () => {
    expect(
      errorsFor([
        { name: 's', type: 'string', default: '' },
        { name: 'n', type: 'number', default: 0 },
        { name: 'b', type: 'boolean', default: false },
        { name: 'a', type: 'array', default: [1, 'two', { three: 3 }] },
      ]),
    ).toEqual([]);
  });

  it('refuses a duplicate variable name on the write schema (the params/outputs rule)', () => {
    const result = NewPipelineVersionSchema.safeParse({
      pipelineId: 'pl_1',
      params: [],
      outputs: [],
      nodes: [],
      edges: [],
      variables: [
        { name: 'x', type: 'string', default: '' },
        { name: 'x', type: 'number', default: 0 },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [
        ['variables', 1, 'name'],
        `duplicate variable name 'x' (variable names must be unique within the pipeline)`,
      ],
    ]);
  });

  it('refuses a name that cannot be addressed as ${vars.<name>}', () => {
    const errors = errorsFor([{ name: 'my-var', type: 'string', default: '' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`variable 'my-var'`);
    expect(errors[0]).toContain('${vars.<name>}');
  });

  it('checks the default STRICTLY against the type — no coercion', () => {
    // The params gate would coerce "5" for a number; a variable default does not.
    expect(errorsFor([{ name: 'n', type: 'number', default: '5' }])).toEqual([
      `variable 'n' default must be a number, got string`,
    ]);
    expect(errorsFor([{ name: 'b', type: 'boolean', default: 'true' }])).toEqual([
      `variable 'b' default must be a boolean, got string`,
    ]);
    expect(errorsFor([{ name: 's', type: 'string', default: 1 }])).toEqual([
      `variable 's' default must be a string, got number`,
    ]);
    expect(errorsFor([{ name: 'a', type: 'array', default: {} }])).toEqual([
      `variable 'a' default must be an array, got object`,
    ]);
  });

  it('refuses a missing default — an unset variable has no honest value', () => {
    expect(errorsFor([{ name: 'n', type: 'number' }])).toEqual([
      `variable 'n' default must be a number, got undefined`,
    ]);
  });

  it('refuses a non-finite number, top-level or nested in an array default', () => {
    expect(errorsFor([{ name: 'n', type: 'number', default: Number.POSITIVE_INFINITY }])).toEqual([
      `variable 'n' default must be a number, got Infinity`,
    ]);
    const nested = errorsFor([{ name: 'a', type: 'array', default: [1, [Number.NaN]] }]);
    expect(nested).toHaveLength(1);
    expect(nested[0]).toContain(`variable 'a' default`);
  });

  it('lets a param and a variable share a name — they are separate roots', () => {
    expect(
      validatePipelineDoc({
        ...doc([{ name: 'x', type: 'string', default: '' }]),
        params: [{ name: 'x', type: 'string', required: false, default: '' }],
      }),
    ).toEqual([]);
  });
});
