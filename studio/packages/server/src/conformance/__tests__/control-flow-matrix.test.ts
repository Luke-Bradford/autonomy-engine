import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityRun } from '@autonomy-studio/shared';
import { CONTROL_CELL_NAMES } from '../cell-ids.js';
import { connectionOf, openBench, type Bench, type BenchNode } from '../bench.js';
import type { PipelineDocInput, RunResult } from '../harness.js';

/**
 * #1574 OR39 — the CONTROL-FLOW matrix: If, Switch, ForEach (sequential and
 * parallel), Until, Execute Pipeline (wait and no wait), Fail, retry, timeout
 * and skip propagation, alone and nested two deep. Each cell is a real run, and
 * the run monitor's activity-runs table must match the cell's expected table
 * exactly: one line per activity run, `<activity>[<iteration>]#<attempt>=<status>`.
 *
 * Cell ids are `control/<name>`; `adf-parity.ts` links to them.
 */

let bench: Bench;
beforeAll(async () => {
  bench = await openBench();
});
afterAll(async () => {
  await bench?.close();
});

const at = { x: 0, y: 0 };

/** A leaf that does nothing but succeed: a Filter over a one-item array. */
const leaf = (id: string): BenchNode => ({
  id,
  type: 'filter',
  position: at,
  config: { items: '${createArray(1)}', predicate: '${true}' },
});
const ifNode = (id: string, condition: string): BenchNode => ({
  id,
  type: 'if',
  position: at,
  config: { condition },
});
const failNode = (id: string): BenchNode => ({
  id,
  type: 'fail',
  position: at,
  config: { message: 'failed on purpose' },
});
const edge = (from: string, to: string, on = 'success') => ({
  id: `${from}-${on}-${to}`,
  from,
  to,
  on,
});
const branch = (from: string, to: string, name: string) => ({
  id: `${from}-${name}-${to}`,
  from,
  to,
  on: 'branch',
  branch: name,
});
const forEach = (id: string, children: string[], items: string, batchCount?: number) => ({
  id,
  kind: 'foreach',
  children,
  items,
  ...(batchCount === undefined ? {} : { batchCount }),
});
/** A Web call to the fixture server: Web fails on an HTTP error, which a retry needs. */
const http = (id: string, path: string, policy: Record<string, unknown>): BenchNode => ({
  id,
  type: 'web',
  position: at,
  connectionId: connectionOf(bench, 'http'),
  config: { url: `${bench.server.url}${path}`, method: 'GET' },
  policy,
});

/** The activity-runs table as lines, in a stable order. */
function table(rows: readonly ActivityRun[]): string[] {
  return rows
    .map((r) => {
      const it = r.iteration === null ? '' : `[${r.iteration.index}]`;
      return `${r.activityId}${it}#${r.attempt ?? '-'}=${r.status}`;
    })
    .sort();
}

/** Save a child pipeline and return the version id an Execute Pipeline calls. */
async function child(doc: PipelineDocInput): Promise<string> {
  return (await bench.h.createPipeline(doc)).versionId;
}
const execute = (id: string, versionId: string, wait: boolean): BenchNode => ({
  id,
  type: 'execute_pipeline',
  position: at,
  config: {},
  call: { pipelineVersionId: versionId, params: {}, wait },
});

/** An Until that ends after its first round: the exit reads the body's output. */
const until = (children: string[], exitOn: string) => ({
  id: 'loop',
  kind: 'loop',
  children,
  exitWhen: `\${equals(length(nodes.${exitOn}.output.result), 1)}`,
  maxRounds: 3,
});

let flaky = 0;

interface ControlCell {
  readonly doc: () => Promise<PipelineDocInput>;
  readonly status: 'success' | 'failure';
  readonly rows: readonly string[];
  readonly retriesDueNow?: true;
  readonly callBackWith?: Record<string, unknown>;
  readonly check?: (r: RunResult) => void;
}

export const CONTROL_CELLS: Record<string, ControlCell> = {
  'if-true': {
    doc: async () => ({
      nodes: [ifNode('cond', '${equals(1, 1)}'), leaf('yes'), leaf('no')],
      edges: [branch('cond', 'yes', 'true'), branch('cond', 'no', 'false')],
    }),
    status: 'success',
    rows: ['cond#1=success', 'no#-=skipped', 'yes#1=success'],
    check: (r) => expect(r.activityRuns.find((x) => x.activityId === 'cond')?.branch).toBe('true'),
  },
  'if-false': {
    doc: async () => ({
      nodes: [ifNode('cond', '${equals(1, 2)}'), leaf('yes'), leaf('no')],
      edges: [branch('cond', 'yes', 'true'), branch('cond', 'no', 'false')],
    }),
    status: 'success',
    rows: ['cond#1=success', 'no#1=success', 'yes#-=skipped'],
  },
  switch: {
    doc: async () => ({
      nodes: [
        { id: 'sw', type: 'switch', position: at, config: { on: "${'b'}", cases: ['a', 'b'] } },
        leaf('a'),
        leaf('b'),
        leaf('other'),
      ],
      edges: [branch('sw', 'a', 'a'), branch('sw', 'b', 'b'), branch('sw', 'other', 'default')],
    }),
    status: 'success',
    rows: ['a#-=skipped', 'b#1=success', 'other#-=skipped', 'sw#1=success'],
  },
  'switch-default': {
    doc: async () => ({
      nodes: [
        { id: 'sw', type: 'switch', position: at, config: { on: "${'z'}", cases: ['a'] } },
        leaf('a'),
        leaf('other'),
      ],
      edges: [branch('sw', 'a', 'a'), branch('sw', 'other', 'default')],
    }),
    status: 'success',
    rows: ['a#-=skipped', 'other#1=success', 'sw#1=success'],
  },
  'foreach-sequential': {
    doc: async () => ({
      nodes: [leaf('body')],
      containers: [forEach('each', ['body'], "${createArray('x', 'y', 'z')}")],
    }),
    status: 'success',
    rows: ['body[0]#1=success', 'body[1]#1=success', 'body[2]#1=success'],
  },
  'foreach-parallel': {
    doc: async () => ({
      nodes: [leaf('body')],
      containers: [forEach('each', ['body'], "${createArray('x', 'y', 'z')}", 3)],
    }),
    status: 'success',
    rows: ['body[0]#1=success', 'body[1]#1=success', 'body[2]#1=success'],
  },
  until: {
    doc: async () => ({
      nodes: [leaf('body')],
      containers: [until(['body'], 'body')],
    }),
    status: 'success',
    rows: ['body[0]#1=success'],
  },
  'execute-pipeline-wait': {
    doc: async () => ({
      nodes: [execute('call', await child({ nodes: [leaf('inner')] }), true), leaf('after')],
      edges: [edge('call', 'after')],
    }),
    status: 'success',
    rows: ['after#1=success', 'call#1=success'],
    check: (r) => {
      const call = r.activityRuns.find((x) => x.activityId === 'call');
      expect(call?.childRun?.status).toBe('success');
    },
  },
  'execute-pipeline-no-wait': {
    doc: async () => ({
      nodes: [execute('call', await child({ nodes: [leaf('inner')] }), false), leaf('after')],
      edges: [edge('call', 'after')],
    }),
    status: 'success',
    rows: ['after#1=success', 'call#1=success'],
  },
  fail: {
    doc: async () => ({ nodes: [failNode('boom')] }),
    status: 'failure',
    rows: ['boom#1=failure'],
    check: (r) => expect(r.failures.get('boom')?.join(' ')).toContain('failed on purpose'),
  },
  retry: {
    doc: async () => ({
      nodes: [http('call', `/flaky/${++flaky}`, { retry: 1, retryIntervalSeconds: 30 })],
    }),
    retriesDueNow: true,
    status: 'success',
    rows: ['call#1=failure', 'call#2=success'],
  },
  timeout: {
    doc: async () => ({ nodes: [http('call', '/slow', { timeoutSeconds: 1 })] }),
    status: 'failure',
    rows: ['call#1=failure'],
    check: (r) => expect(r.activityRuns[0]?.error).not.toBeNull(),
  },
  'skip-propagation': {
    doc: async () => ({
      nodes: [
        failNode('a'),
        leaf('onSuccess'),
        leaf('onFailure'),
        leaf('onCompletion'),
        leaf('then'),
      ],
      edges: [
        edge('a', 'onSuccess', 'success'),
        edge('a', 'onFailure', 'failure'),
        edge('a', 'onCompletion', 'completion'),
        edge('onSuccess', 'then', 'success'),
      ],
    }),
    // ADF: a failure handled by an On-failure path still fails the run when the
    // failing activity also has an On-success path that was skipped.
    status: 'failure',
    rows: [
      'a#1=failure',
      'onCompletion#1=success',
      'onFailure#1=success',
      'onSuccess#-=skipped',
      'then#-=skipped',
    ],
  },
  'set-variable': {
    doc: async () => ({
      variables: [{ name: 'greeting', type: 'string', default: '' }],
      nodes: [
        {
          id: 'set',
          type: 'set_variable',
          position: at,
          config: { variable: 'greeting', value: 'hello' },
        },
        ifNode('check', "${equals(vars.greeting, 'hello')}"),
        leaf('yes'),
      ],
      edges: [edge('set', 'check'), branch('check', 'yes', 'true')],
    }),
    status: 'success',
    rows: ['check#1=success', 'set#1=success', 'yes#1=success'],
  },
  'append-variable': {
    doc: async () => ({
      variables: [{ name: 'list', type: 'array', default: [] }],
      nodes: [
        {
          id: 'add',
          type: 'append_variable',
          position: at,
          config: { variable: 'list', value: 'x' },
        },
        ifNode('check', '${equals(length(vars.list), 1)}'),
        leaf('yes'),
      ],
      edges: [edge('add', 'check'), branch('check', 'yes', 'true')],
    }),
    status: 'success',
    rows: ['add#1=success', 'check#1=success', 'yes#1=success'],
  },
  filter: {
    doc: async () => ({
      nodes: [
        {
          id: 'keep',
          type: 'filter',
          position: at,
          config: { items: '${createArray(1, 2, 3)}', predicate: '${greater(item, 1)}' },
        },
        ifNode('check', '${equals(length(nodes.keep.output.result), 2)}'),
        leaf('yes'),
      ],
      edges: [edge('keep', 'check'), branch('check', 'yes', 'true')],
    }),
    status: 'success',
    rows: ['check#1=success', 'keep#1=success', 'yes#1=success'],
  },
  wait: {
    doc: async () => ({
      nodes: [
        { id: 'pause', type: 'wait', position: at, config: { seconds: '${1}' } },
        leaf('after'),
      ],
      edges: [edge('pause', 'after')],
    }),
    status: 'success',
    rows: ['after#1=success', 'pause#1=success'],
  },
  webhook: {
    doc: async () => ({
      nodes: [
        { id: 'hook', type: 'webhook', position: at, config: { timeoutSeconds: '${60}' } },
        leaf('after'),
      ],
      edges: [edge('hook', 'after')],
    }),
    callBackWith: { status: 'done' },
    status: 'success',
    rows: ['after#1=success', 'hook#1=success'],
  },
  inactive: {
    doc: async () => ({
      nodes: [
        { ...failNode('off'), state: 'inactive', onInactiveMarkAs: 'success' },
        leaf('after'),
      ],
      edges: [edge('off', 'after')],
    }),
    status: 'success',
    // The row is the Mark-as placeholder: `inactive` says the Fail never ran.
    rows: ['after#1=success', 'off#1=success'],
    check: (r) => expect(r.activityRuns.find((x) => x.activityId === 'off')?.inactive).toBe(true),
  },
  // Nested two deep.
  'foreach>if': {
    doc: async () => ({
      nodes: [ifNode('cond', "${equals(item, 'x')}"), leaf('yes'), leaf('no')],
      edges: [branch('cond', 'yes', 'true'), branch('cond', 'no', 'false')],
      containers: [forEach('each', ['cond', 'yes', 'no'], "${createArray('x', 'y')}")],
    }),
    status: 'success',
    rows: [
      'cond[0]#1=success',
      'cond[1]#1=success',
      'no[0]#-=skipped',
      'no[1]#1=success',
      'yes[0]#1=success',
      'yes[1]#-=skipped',
    ],
  },
  'foreach-parallel>execute-pipeline': {
    doc: async () => {
      const inner = await child({ nodes: [leaf('inner')] });
      return {
        nodes: [execute('call', inner, true)],
        containers: [forEach('each', ['call'], "${createArray('x', 'y')}", 2)],
      };
    },
    status: 'success',
    rows: ['call[0]#1=success', 'call[1]#1=success'],
  },
  'if>execute-pipeline>foreach': {
    doc: async () => {
      const inner = await child({
        nodes: [leaf('body')],
        containers: [forEach('each', ['body'], "${createArray('x', 'y')}")],
      });
      return {
        nodes: [ifNode('cond', '${true}'), execute('call', inner, true)],
        edges: [branch('cond', 'call', 'true')],
      };
    },
    status: 'success',
    rows: ['call#1=success', 'cond#1=success'],
    check: (r) =>
      expect(r.activityRuns.find((x) => x.activityId === 'call')?.childRun?.status).toBe('success'),
  },
  'until>switch': {
    doc: async () => ({
      nodes: [
        { id: 'sw', type: 'switch', position: at, config: { on: "${'a'}", cases: ['a'] } },
        leaf('a'),
        leaf('other'),
      ],
      edges: [branch('sw', 'a', 'a'), branch('sw', 'other', 'default')],
      containers: [until(['sw', 'a', 'other'], 'a')],
    }),
    status: 'success',
    rows: ['a[0]#1=success', 'other[0]#-=skipped', 'sw[0]#1=success'],
  },
  'foreach>fail': {
    doc: async () => ({
      nodes: [failNode('boom')],
      containers: [forEach('each', ['boom'], "${createArray('x', 'y')}")],
    }),
    status: 'failure',
    rows: ['boom[0]#1=failure'],
  },
};

describe('the control-flow matrix', () => {
  it('runs exactly the cells the parity doc can link to', () => {
    expect(Object.keys(CONTROL_CELLS)).toEqual([...CONTROL_CELL_NAMES]);
  });

  it.each(Object.keys(CONTROL_CELLS))('control/%s', async (name) => {
    const cell = CONTROL_CELLS[name]!;
    const result = await bench.h.runDoc(await cell.doc(), undefined, {
      ...(cell.retriesDueNow ? { retriesDueNow: true } : {}),
      ...(cell.callBackWith === undefined ? {} : { callBackWith: cell.callBackWith }),
    });
    expect({ status: result.status, rows: table(result.activityRuns) }).toEqual({
      status: cell.status,
      rows: cell.rows,
    });
    cell.check?.(result);
  });
});
