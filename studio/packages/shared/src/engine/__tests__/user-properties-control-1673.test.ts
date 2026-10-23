/**
 * #1673 part 2 — an activity the engine evaluates (If, Switch, Set/Append
 * variable, a return value, Fail, Filter, Wait, Webhook, a Web that only waits)
 * and a pipeline call never reach the executor. Their command carries the
 * node's user properties, resolved as a dispatch's are, for the driver to
 * record on the event it appends; a restart's re-emit carries the same.
 * Part 3: so does an inactive activity's placeholder run, literals only.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, Node, RunState } from '../types.js';
import { createEngine } from '../reduce.js';
import { SECURE_REDACTED } from '../secure.js';
import { INACTIVE_USER_PROPERTY_UNRESOLVED } from '../user-properties.js';
import { WEB_ACTIVITY_TYPE } from '../../catalog/types.js';
import { getActivity } from '../../catalog/registry.js';

const PROPS: Node['userProperties'] = [
  { name: 'Source', value: 'in/${params.file}' },
  { name: 'Kind', value: 'nightly' },
];
const RESOLVED = [
  { name: 'Source', value: 'in/orders.csv' },
  { name: 'Kind', value: 'nightly' },
];
const started: EngineEvent = {
  type: 'run.started',
  runId: 'r1',
  pipelineVersionId: 'pv1',
  params: { file: 'orders.csv' },
};
const node = (type: string, config: Record<string, unknown>, over: Partial<Node> = {}): Node => ({
  id: 'a',
  type,
  config,
  position: { x: 0, y: 0 },
  userProperties: PROPS,
  ...over,
});
const VARIABLES = [
  { name: 'v', type: 'string' as const, default: '' },
  { name: 'list', type: 'array' as const, default: [] },
];
const engineFor = (n: Node) =>
  createEngine({ nodes: [n], edges: [], containers: [], variables: VARIABLES });

/** Each kind of node the engine starts without the executor, and the command it gets. */
const CASES: [string, Node, EngineCommand['type']][] = [
  ['If', node('if', { condition: '${true}' }), 'evaluateControl'],
  ['Switch', node('switch', { on: 'x', cases: ['x'] }), 'evaluateControl'],
  ['Set variable', node('set_variable', { variable: 'v', value: 'x' }), 'writeVariable'],
  ['Append variable', node('append_variable', { variable: 'list', value: 'x' }), 'writeVariable'],
  [
    'a Set variable whose value cannot be written',
    node('set_variable', { variable: 'v', value: '${createArray(1)}' }),
    'failNode',
  ],
  [
    'Pipeline return value',
    node('set_variable', {
      operation: 'return',
      returnValues: [{ key: 'k', type: 'string', content: 'x' }],
    }),
    'succeedControl',
  ],
  ['Fail', node('fail', { message: 'stop' }), 'failNode'],
  [
    'Filter',
    node('filter', { items: '${createArray(1)}', predicate: '${true}' }),
    'succeedControl',
  ],
  ['Wait', node('wait', { seconds: '${60}' }), 'scheduleWait'],
  ['Webhook', node('webhook', { timeoutSeconds: '${600}' }), 'scheduleExternalWait'],
  [
    'a Web that only waits',
    node(WEB_ACTIVITY_TYPE, { waitForCallback: true }),
    'scheduleExternalWait',
  ],
  [
    'a pipeline call',
    node('execute_pipeline', {}, { call: { pipelineVersionId: 'pv2', params: {} } }),
    'startChild',
  ],
];

const carried = (c: EngineCommand | undefined) =>
  c !== undefined && 'resolvedUserProperties' in c ? c.resolvedUserProperties : undefined;

describe('#1673 — user properties on activities the executor never dispatches', () => {
  it.each(CASES)('%s carries them on its command, resolved', (_label, n, type) => {
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    const cmd = r.commands.find((c) => c.type === type);
    expect(cmd, JSON.stringify(r.commands)).toBeDefined();
    expect(carried(cmd)).toEqual(RESOLVED);
  });

  it.each(CASES)('%s carries the same on a restart’s re-emit', (_label, n, type) => {
    const eng = engineFor(n);
    const s: RunState = eng.reduce(eng.seedState(), started).state;
    const r = eng.reduce(s, { type: 'run.resumed', runId: 'r1', reason: 'boot_reconcile' });
    const cmd = r.commands.find((c) => c.type === type);
    expect(cmd, JSON.stringify(r.commands)).toBeDefined();
    expect(carried(cmd)).toEqual(RESOLVED);
  });

  it('carries nothing when the node has none', () => {
    const n = node('if', { condition: '${true}' }, { userProperties: undefined });
    const r = engineFor(n).reduce(engineFor(n).seedState(), started);
    const cmd = r.commands.find((c) => c.type === 'evaluateControl');
    expect(cmd).toBeDefined();
    expect(cmd).not.toHaveProperty('resolvedUserProperties');
  });

  it('a Web that dispatched does not record them again on its callback wait', () => {
    const web = node(
      WEB_ACTIVITY_TYPE,
      {
        url: '/jobs',
        method: 'POST',
        waitForCallback: true,
        outputs: getActivity(WEB_ACTIVITY_TYPE)!.outputs,
      },
      { connectionId: 'c1' },
    );
    const eng = engineFor(web);
    let s = eng.reduce(eng.seedState(), started).state;
    s = eng.reduce(s, {
      type: 'node.dispatched',
      runId: 'r1',
      nodeId: 'a',
      attemptId: 'a#0',
      idempotent: false,
    }).state;
    const parked = eng.reduce(s, {
      type: 'node.awaitingCallback',
      runId: 'r1',
      nodeId: 'a',
      attemptId: 'a#0',
      outputs: { status: 202, headers: {}, body: {}, bytes: 2, durationMs: 1, truncated: false },
      timeoutSeconds: 600,
    });
    const wait = parked.commands.find((c) => c.type === 'scheduleExternalWait');
    expect(wait).toBeDefined();
    expect(wait).not.toHaveProperty('resolvedUserProperties');
    const resumed = eng.reduce(parked.state, {
      type: 'run.resumed',
      runId: 'r1',
      reason: 'boot_reconcile',
    });
    const again = resumed.commands.find((c) => c.type === 'scheduleExternalWait');
    expect(again).toBeDefined();
    expect(again).not.toHaveProperty('resolvedUserProperties');
  });
});

describe('#1673 — withheld on a secure engine-evaluated activity', () => {
  const props = [{ name: 'Source', value: 'orders.csv' }];
  const withheld = [{ name: 'Source', value: SECURE_REDACTED }];
  const at = { runId: 'r1', nodeId: 'a', attemptId: 'a#0', userProperties: props };
  const EVENTS: [string, Node, EngineEvent][] = [
    ['Wait', node('wait', { seconds: '${60}' }), { type: 'timer.waitScheduled', ...at, dueAt: 1 }],
    [
      'Webhook',
      node('webhook', { timeoutSeconds: '${600}' }),
      { type: 'externalWait.created', ...at, dueAt: 1 },
    ],
    [
      'Webhook, the callback already in',
      node('webhook', { timeoutSeconds: '${600}' }),
      { type: 'externalWait.created', ...at, dueAt: 1, arrived: { callback: { ok: true } } },
    ],
    [
      'Filter',
      node('filter', { items: '${createArray(1)}', predicate: '${true}' }),
      { type: 'node.succeeded', ...at, outputs: { result: [1] } },
    ],
    [
      'Fail',
      node('fail', { message: 'stop' }),
      { type: 'node.failed', ...at, error: 'stop', kind: 'permanent' },
    ],
    [
      'an inactive Web',
      node(WEB_ACTIVITY_TYPE, { url: '/jobs', method: 'GET' }, { state: 'inactive' }),
      { type: 'node.inactive', ...at, markAs: 'success' },
    ],
  ];

  it.each(EVENTS)('%s, on either flag', (_label, n, event) => {
    for (const policy of [{ secureInput: true }, { secureOutput: true }]) {
      const got = engineFor({ ...n, policy }).redact(event);
      expect('userProperties' in got && got.userProperties).toEqual(withheld);
    }
    const plain = engineFor(n).redact(event);
    expect('userProperties' in plain && plain.userProperties).toEqual(props);
  });
});

describe('#1673 — an inactive activity records its literal user properties, and evaluates none', () => {
  const MIXED: Node['userProperties'] = [
    { name: 'Kind', value: 'nightly' },
    { name: 'Escaped', value: 'cost $${x}' },
    { name: 'Source', value: 'in/${params.file}' },
    { name: 'Whole', value: '${params.file}' },
    { name: 'Unterminated', value: 'in/${params.file' },
  ];
  const RECORDED = [
    { name: 'Kind', value: 'nightly' },
    { name: 'Escaped', value: 'cost ${x}' },
    { name: 'Source', error: INACTIVE_USER_PROPERTY_UNRESOLVED },
    { name: 'Whole', error: INACTIVE_USER_PROPERTY_UNRESOLVED },
    { name: 'Unterminated', error: INACTIVE_USER_PROPERTY_UNRESOLVED },
  ];
  const off = (type: string, config: Record<string, unknown>, over: Partial<Node> = {}) =>
    node(type, config, { state: 'inactive', userProperties: MIXED, ...over });
  const OFF: [string, Node][] = [
    ['an inactive If', off('if', { condition: '${true}' })],
    ['an inactive Web', off(WEB_ACTIVITY_TYPE, { url: '/jobs', method: 'GET' }, { connectionId: 'c1' })],
  ];

  it.each(OFF)('%s, on its command and on a restart’s re-emit', (_label, n) => {
    const eng = engineFor(n);
    const first = eng.reduce(eng.seedState(), started);
    const cmd = first.commands.find((c) => c.type === 'inactivateNode');
    expect(cmd, JSON.stringify(first.commands)).toBeDefined();
    expect(carried(cmd)).toEqual(RECORDED);
    const again = eng
      .reduce(first.state, { type: 'run.resumed', runId: 'r1', reason: 'boot_reconcile' })
      .commands.find((c) => c.type === 'inactivateNode');
    expect(carried(again)).toEqual(RECORDED);
  });

  it('carries nothing when the node has none', () => {
    const n = off('if', { condition: '${true}' }, { userProperties: undefined });
    const cmd = engineFor(n)
      .reduce(engineFor(n).seedState(), started)
      .commands.find((c) => c.type === 'inactivateNode');
    expect(cmd).toBeDefined();
    expect(cmd).not.toHaveProperty('resolvedUserProperties');
  });

  it('never reads a secure activity’s output into the log, though save never checked it', () => {
    const secret: Node = {
      id: 's',
      type: 'test_activity',
      config: {},
      position: { x: 0, y: 0 },
      policy: { secureOutput: true },
    };
    const reader = off('if', { condition: '${true}' }, {
      id: 'r',
      userProperties: [{ name: 'Leak', value: '${nodes.s.outputs.text}' }],
    });
    const eng = createEngine({
      nodes: [secret, reader],
      edges: [{ id: 's->r', from: 's', to: 'r', on: 'success' }],
      containers: [],
      variables: [],
    });
    let s = eng.reduce(eng.seedState(), started).state;
    s = eng.reduce(s, {
      type: 'node.dispatched',
      runId: 'r1',
      nodeId: 's',
      attemptId: 's#0',
      idempotent: true,
    }).state;
    const r = eng.reduce(s, {
      type: 'node.succeeded',
      runId: 'r1',
      nodeId: 's',
      attemptId: 's#0',
      outputs: { text: 'plaintext secret' },
    });
    const cmd = r.commands.find((c) => c.type === 'inactivateNode');
    expect(cmd, JSON.stringify(r.commands)).toBeDefined();
    expect(carried(cmd)).toEqual([{ name: 'Leak', error: INACTIVE_USER_PROPERTY_UNRESOLVED }]);
    expect(JSON.stringify(r.commands)).not.toContain('plaintext secret');
  });

  it('inside a ForEach body, records each item’s literals and evaluates no `${item}`', () => {
    const child = off('if', { condition: '${true}' }, {
      id: 'c',
      userProperties: [
        { name: 'Kind', value: 'nightly' },
        { name: 'Item', value: '${item}' },
      ],
    });
    const eng = createEngine({
      nodes: [child],
      edges: [],
      containers: [{ id: 'fe', kind: 'foreach', children: ['c'], items: '${createArray(1, 2)}' }],
      variables: [],
    } as never);
    const r = eng.reduce(eng.seedState(), started);
    const cmds = r.commands.filter((c) => c.type === 'inactivateNode');
    expect(cmds.length, JSON.stringify(r.commands)).toBeGreaterThan(0);
    for (const c of cmds) {
      expect(carried(c)).toEqual([
        { name: 'Kind', value: 'nightly' },
        { name: 'Item', error: INACTIVE_USER_PROPERTY_UNRESOLVED },
      ]);
    }
  });
});
