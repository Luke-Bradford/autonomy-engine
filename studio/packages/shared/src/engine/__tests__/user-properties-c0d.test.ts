/**
 * #1600 OR41 C0d — an activity's user properties are resolved by the pure
 * reducer at dispatch and carried on the `dispatchNode` command, for the
 * executor to record on `node.dispatched`. A property that fails to resolve
 * records its error and never fails the run: it is monitoring metadata.
 */
import { describe, expect, it } from 'vitest';
import type { EngineCommand, EngineEvent, Node } from '../types.js';
import { createEngine } from '../reduce.js';
import { resolveUserProperties } from '../user-properties.js';
import { USER_PROPERTY_VALUE_MAX_CHARS } from '../../schemas/pipeline.js';
import { SECURE_REDACTED } from '../secure.js';

const started = (params: Record<string, unknown> = {}): EngineEvent => ({
  type: 'run.started',
  runId: 'r1',
  pipelineVersionId: 'pv1',
  params,
});
const node = (over: Partial<Node> = {}): Node => ({
  id: 'a',
  type: 'agent_task',
  config: { task: '${params.file}' },
  position: { x: 0, y: 0 },
  ...over,
});
function firstDispatch(n: Node, params: Record<string, unknown> = {}) {
  const eng = createEngine({ nodes: [n], edges: [] });
  const r = eng.reduce(eng.seedState(), started(params));
  const cmd = r.commands.find((c: EngineCommand) => c.type === 'dispatchNode');
  if (cmd?.type !== 'dispatchNode') throw new Error('no dispatchNode');
  return { cmd, commands: r.commands };
}

describe('#1600 C0d — user properties resolved at dispatch', () => {
  it('resolves literals, embedded and whole-value refs, writing a non-string as an embedded ref would', () => {
    const { cmd } = firstDispatch(
      node({
        userProperties: [
          { name: 'Kind', value: 'nightly' },
          { name: 'File', value: 'in/${params.file}' },
          { name: 'Count', value: '${params.n}' },
          { name: 'Obj', value: '${params.o}' },
        ],
      }),
      { file: 'orders.csv', n: 3, o: { a: 1 } },
    );
    expect(cmd.resolvedUserProperties).toEqual([
      { name: 'Kind', value: 'nightly' },
      { name: 'File', value: 'in/orders.csv' },
      { name: 'Count', value: '3' },
      { name: 'Obj', value: '{"a":1}' },
    ]);
  });

  it('records a failing property as its error, keeps the others, and still dispatches the activity', () => {
    const { cmd, commands } = firstDispatch(
      node({
        userProperties: [
          { name: 'Bad', value: '${params.missing.deep}' },
          { name: 'Good', value: 'ok' },
        ],
      }),
      { file: 'x' },
    );
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
    expect(cmd.preparedInput).toEqual({ task: 'x' });
    expect(cmd.resolvedUserProperties?.[0]).toMatchObject({ name: 'Bad' });
    expect(cmd.resolvedUserProperties?.[0]?.error).toEqual(expect.any(String));
    expect(cmd.resolvedUserProperties?.[0]).not.toHaveProperty('value');
    expect(cmd.resolvedUserProperties?.[1]).toEqual({ name: 'Good', value: 'ok' });
  });

  it('is absent when the node has none', () => {
    expect(firstDispatch(node(), { file: 'x' }).cmd.resolvedUserProperties).toBeUndefined();
    // An empty list (the API can save one) records nothing either.
    expect(
      firstDispatch(node({ userProperties: [] }), { file: 'x' }).cmd.resolvedUserProperties,
    ).toBeUndefined();
  });
});

describe('resolveUserProperties', () => {
  it('never cuts a surrogate pair in half', () => {
    // An emoji (two UTF-16 units) straddling the bound is dropped whole.
    const text = 'x'.repeat(USER_PROPERTY_VALUE_MAX_CHARS - 1) + '😀' + 'tail';
    const [prop] = resolveUserProperties([{ name: 'v', value: '' }], () => text);
    expect(prop).toEqual({
      name: 'v',
      value: 'x'.repeat(USER_PROPERTY_VALUE_MAX_CHARS - 1),
      truncated: true,
    });
  });

  it('records a value that cannot be written as text as an error, never throwing', () => {
    // `JSON.stringify` throws on a bigint: that throw must not escape to `prepFailure`.
    const [prop] = resolveUserProperties([{ name: 'n', value: '' }], () => ({ n: 10n }));
    expect(prop).toMatchObject({ name: 'n', error: expect.any(String) });
  });

  it('cuts a long value or error at the authored bound, and says so', () => {
    const long = 'x'.repeat(USER_PROPERTY_VALUE_MAX_CHARS + 5);
    expect(resolveUserProperties([{ name: 'v', value: '' }], () => long)).toEqual([
      { name: 'v', value: long.slice(0, USER_PROPERTY_VALUE_MAX_CHARS), truncated: true },
    ]);
    expect(
      resolveUserProperties([{ name: 'e', value: '' }], () => {
        throw new Error(long);
      }),
    ).toEqual([
      { name: 'e', error: long.slice(0, USER_PROPERTY_VALUE_MAX_CHARS), truncated: true },
    ]);
    expect(
      resolveUserProperties([{ name: 'v', value: '' }], () =>
        'x'.repeat(USER_PROPERTY_VALUE_MAX_CHARS),
      ),
    ).toEqual([{ name: 'v', value: 'x'.repeat(USER_PROPERTY_VALUE_MAX_CHARS) }]);
  });
});

describe('#1600 C0d — user properties on a secure node', () => {
  const props = [
    { name: 'File', value: 'orders.csv' },
    { name: 'Bad', error: 'no such param', truncated: true as const },
  ];
  const dispatched = (nodeId: string): EngineEvent => ({
    type: 'node.dispatched',
    runId: 'r1',
    nodeId,
    attemptId: `${nodeId}#0`,
    idempotent: false,
    userProperties: props,
  });

  it('withholds every value and error on either flag, keeping the names, with nothing else recorded', () => {
    for (const policy of [{ secureInput: true }, { secureOutput: true }]) {
      const n = node({ policy });
      const got = createEngine({ nodes: [n], edges: [], containers: [] }).redact(dispatched('a'));
      expect(got.type === 'node.dispatched' && got.userProperties).toEqual([
        { name: 'File', value: SECURE_REDACTED },
        { name: 'Bad', error: SECURE_REDACTED },
      ]);
    }
  });

  it('#1673 — withholds them on a failure before dispatch too, on either flag', () => {
    const failed: EngineEvent = {
      type: 'node.failed',
      runId: 'r1',
      nodeId: 'a',
      attemptId: 'a#0',
      error: 'connection not found',
      kind: 'permanent',
      userProperties: props,
    };
    for (const policy of [{ secureInput: true }, { secureOutput: true }]) {
      const got = createEngine({ nodes: [node({ policy })], edges: [], containers: [] }).redact(
        failed,
      );
      expect(got.type === 'node.failed' && got.userProperties).toEqual([
        { name: 'File', value: SECURE_REDACTED },
        { name: 'Bad', error: SECURE_REDACTED },
      ]);
    }
    const plain = createEngine({ nodes: [node()], edges: [], containers: [] }).redact(failed);
    expect(plain.type === 'node.failed' && plain.userProperties).toEqual(props);
  });

  it('leaves them as resolved on a node that is not secure', () => {
    const got = createEngine({ nodes: [node()], edges: [], containers: [] }).redact(
      dispatched('a'),
    );
    expect(got.type === 'node.dispatched' && got.userProperties).toEqual(props);
  });
});
