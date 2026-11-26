/**
 * #1567 OR36 A2 — an activity the engine evaluates records HOW it decided: the
 * expression, each reference's value and the result, on the command the driver
 * turns into its event. A restart's re-emit records the same. A dispatched
 * activity's command records each `${}` field it resolved.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, Node, RunState } from '../types.js';
import { createEngine } from '../reduce.js';

const started: EngineEvent = {
  type: 'run.started',
  runId: 'r1',
  pipelineVersionId: 'pv1',
  params: { file: 'orders.csv', n: 20 },
};
const node = (id: string, type: string, config: Record<string, unknown>): Node => ({
  id,
  type,
  config,
  position: { x: 0, y: 0 },
});
const VARIABLES = [{ name: 'v', type: 'string' as const, default: '' }];
const engineFor = (n: Node) =>
  createEngine({ nodes: [n], edges: [], containers: [], variables: VARIABLES });

const evaluationOf = (c: EngineCommand | undefined) =>
  c !== undefined && 'evaluation' in c ? c.evaluation : undefined;

const CASES: [string, Node, EngineCommand['type'], unknown][] = [
  [
    'If',
    node('if1', 'if', { condition: '${greater(params.n, 0)}' }),
    'evaluateControl',
    {
      field: 'condition',
      expression: '${greater(params.n, 0)}',
      operands: { 'params.n': 20 },
      result: 'true',
    },
  ],
  [
    'Switch',
    node('sw', 'switch', { on: '${params.file}', cases: ['orders.csv'] }),
    'evaluateControl',
    {
      field: 'on',
      expression: '${params.file}',
      operands: { 'params.file': 'orders.csv' },
      result: 'orders.csv',
    },
  ],
  [
    'Set variable',
    node('set', 'set_variable', { variable: 'v', value: 'in/${params.file}' }),
    'writeVariable',
    {
      field: 'value',
      expression: 'in/${params.file}',
      operands: { 'params.file': 'orders.csv' },
      result: 'in/orders.csv',
    },
  ],
  [
    'Fail',
    node('f', 'fail', { message: 'bad ${params.file}' }),
    'failNode',
    {
      field: 'message',
      expression: 'bad ${params.file}',
      operands: { 'params.file': 'orders.csv' },
      result: 'bad orders.csv',
    },
  ],
];

describe('#1567 — the evaluation record on an engine-evaluated activity', () => {
  it.each(CASES)('%s records its expression, operands and result', (_l, n, type, want) => {
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    const cmd = r.commands.find((c) => c.type === type);
    expect(cmd, JSON.stringify(r.commands)).toBeDefined();
    expect(evaluationOf(cmd)).toEqual(want);
  });

  it.each(CASES)('%s records the same on a restart’s re-emit', (_l, n, type, want) => {
    const eng = engineFor(n);
    const s: RunState = eng.reduce(eng.seedState(), started).state;
    const r = eng.reduce(s, { type: 'run.resumed', runId: 'r1', reason: 'boot_reconcile' });
    expect(evaluationOf(r.commands.find((c) => c.type === type))).toEqual(want);
  });

  it('a Filter records its composed expression and the filtered result', () => {
    const n = node('flt', 'filter', {
      items: '${createArray(1, 7, 9)}',
      predicate: '${greater(item, 5)}',
    });
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    const ev = evaluationOf(r.commands.find((c) => c.type === 'succeedControl'));
    expect(ev).toMatchObject({ field: 'filter', result: { result: [7, 9] } });
  });

  it('a literal decides nothing to audit, so it records nothing', () => {
    const n = node('if1', 'if', { condition: '${true}' });
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    const cmd = r.commands.find((c) => c.type === 'evaluateControl');
    expect(evaluationOf(cmd)).toMatchObject({ operands: {}, result: 'true' });
    const lit = node('set', 'set_variable', { variable: 'v', value: 'plain' });
    const w = engineFor(lit).reduce(engineFor(lit).seedState(), started);
    expect(w.commands.find((c) => c.type === 'writeVariable')).not.toHaveProperty('evaluation');
  });
});

describe('#1567 — a dispatch records each ${} field it resolved', () => {
  it('maps field paths to template, value and operands, parameters included', () => {
    const n: Node = {
      ...node('copy', 'http', { url: 'https://x/${params.file}', method: 'GET' }),
      connectionId: 'c1',
      connectionParams: { region: '${params.file}' },
    };
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    const cmd = r.commands.find((c) => c.type === 'dispatchNode');
    expect(cmd && 'expressions' in cmd ? cmd.expressions : undefined).toEqual({
      url: {
        template: 'https://x/${params.file}',
        value: 'https://x/orders.csv',
        operands: { 'params.file': 'orders.csv' },
      },
      'connectionParams.region': {
        template: '${params.file}',
        value: 'orders.csv',
        operands: { 'params.file': 'orders.csv' },
      },
    });
  });

  it('records nothing when no field holds a ${}', () => {
    const n: Node = {
      ...node('h', 'http', { url: 'https://x', method: 'GET' }),
      connectionId: 'c1',
    };
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    expect(r.commands.find((c) => c.type === 'dispatchNode')).not.toHaveProperty('expressions');
  });
});
