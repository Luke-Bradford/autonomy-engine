import { describe, expect, it } from 'vitest';
import type { EngineEvent, Node, PipelineVersion } from '../types.js';
import { createEngine } from '../reduce.js';
import { validateDoc } from '../params.js';
import { SCRIPT_ACTIVITY_TYPE } from '../../catalog/types.js';
import { scriptConfigSchema, scriptDispatchConfigSchema } from '../../catalog/script-config.js';

/**
 * #1600 OR41 C10a — a Script block's SQL is literal (§8), as Copy's Pre-copy
 * script is: save refuses a `${` in it, the reducer hands it over unsubstituted,
 * and the dispatch schema refuses a raw `${` that reached the store some other
 * way. Only each block's `parameters` is evaluated.
 */
const script = (config: Record<string, unknown>): Node => ({
  id: 's',
  type: SCRIPT_ACTIVITY_TYPE,
  config,
  position: { x: 0, y: 0 },
});

const doc = (
  nodes: Node[],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers' | 'variables'> => ({
  params: [],
  nodes,
  edges: [],
  containers: [],
  variables: [],
});

const started: EngineEvent = {
  type: 'run.started',
  runId: 'r1',
  pipelineVersionId: 'pv1',
  params: {},
};

function preparedInputOf(node: Node): Record<string, unknown> {
  const eng = createEngine({ nodes: [node], edges: [] });
  const cmd = eng
    .reduce(eng.seedState(), started)
    .commands.find((c) => c.type === 'dispatchNode') as {
    preparedInput: Record<string, unknown>;
  };
  return cmd.preparedInput;
}

describe('prepInput leaves a Script block’s SQL and Type unsubstituted (C10a)', () => {
  it('passes each block’s SQL raw and substitutes only its parameters', () => {
    const input = preparedInputOf(
      script({
        runAsOneTransaction: true,
        blocks: [
          {
            type: 'nonQuery',
            sql: "delete from t where r = :r or note = '${run.runId}'",
            parameters: { r: '${run.runId}' },
          },
          { type: 'query', sql: 'select 1' },
        ],
      }),
    );
    expect(input).toEqual({
      runAsOneTransaction: true,
      blocks: [
        {
          type: 'nonQuery',
          sql: "delete from t where r = :r or note = '${run.runId}'",
          parameters: { r: 'r1' },
        },
        { type: 'query', sql: 'select 1' },
      ],
    });
  });

  it('hands a malformed blocks value over raw, never substituted', () => {
    const input = preparedInputOf(script({ blocks: '${run.runId}' }));
    expect(input).toEqual({ blocks: '${run.runId}' });
  });
});

describe('the save gate refuses a ${} in a Script block’s SQL or Type (C10a)', () => {
  it('accepts literal SQL with a ${} bind value', () => {
    const node = script({
      blocks: [
        { type: 'nonQuery', sql: 'delete from t where r = :r', parameters: { r: '${run.runId}' } },
      ],
    });
    expect(validateDoc(doc([node]))).toEqual([]);
  });

  it('refuses a ${} in a block’s SQL, naming the block', () => {
    const node = script({
      blocks: [
        { type: 'query', sql: 'select 1' },
        { type: 'nonQuery', sql: "delete from t where r = '${run.runId}'" },
      ],
    });
    expect(validateDoc(doc([node])).join(' ')).toMatch(
      /blocks\[1\]\.sql: a Script block's SQL stays literal/,
    );
  });

  it('refuses a ${} as a block’s Type', () => {
    const node = script({ blocks: [{ type: '${params.kind}', sql: 'select 1' }] });
    expect(validateDoc(doc([node])).join(' ')).toMatch(/blocks\[0\]\.type: a Script block's Type/);
  });

  it('refuses a Script with no blocks', () => {
    expect(validateDoc(doc([script({ blocks: [] })])).length).toBeGreaterThan(0);
  });
});

describe('the Script dispatch schema (C10a)', () => {
  it('refuses a raw ${} in a block’s SQL', () => {
    const parsed = scriptDispatchConfigSchema.safeParse({
      blocks: [{ type: 'query', sql: "select '${x}'" }],
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults to autocommit blocks and the first 1000 rows of each result set', () => {
    const parsed = scriptConfigSchema.parse({ blocks: [{ type: 'query', sql: 'select 1' }] });
    expect(parsed.runAsOneTransaction).toBe(false);
    expect(parsed.captureResultSets).toBe('firstRows');
  });

  it('requires a block’s Type', () => {
    expect(scriptConfigSchema.safeParse({ blocks: [{ sql: 'select 1' }] }).success).toBe(false);
  });
});
