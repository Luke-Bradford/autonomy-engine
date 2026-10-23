/**
 * #1673 part 4 — a container's (ForEach, Until, Stage) user properties. Resolved
 * once, as the container enters, in its OUTER scope, and held on its run state:
 * entering is pure, so no event records them and replay re-derives them from
 * the pinned doc. An inactive container records literals only. Against the REAL
 * reducer via the shared `driveRun` harness.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, Node } from '../types.js';
import { createEngine } from '../reduce.js';
import { validatePipelineDoc } from '../validate-pipeline.js';
import { variableReadsOf } from '../params.js';
import { INACTIVE_USER_PROPERTY_UNRESOLVED } from '../user-properties.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

const PROPS: Container['userProperties'] = [
  { name: 'Source', value: 'in/${params.file}' },
  { name: 'Kind', value: 'nightly' },
];
const RESOLVED = [
  { name: 'Source', value: 'in/orders.csv' },
  { name: 'Kind', value: 'nightly' },
];
const PARAMS = { file: 'orders.csv', list: [1, 2] };

let seq = 0;
function node(id: string, extra: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config: { task: 't' }, position: { x: seq, y: 0 }, ...extra };
}
const edge = (from: string, to: string): Edge => ({
  id: `${from}->${to}`,
  from,
  to,
  on: 'success',
});
const box = (kind: Container['kind'], over: Partial<Container> = {}): Container => ({
  id: 'c',
  kind,
  children: ['body'],
  ...(kind === 'foreach' && { items: '${params.list}' }),
  ...(kind === 'loop' && { exitWhen: '${true}' }),
  userProperties: PROPS,
  ...over,
});
const engineFor = (c: Container) =>
  createEngine({
    nodes: [node('first'), node('body')],
    edges: [edge('first', 'c')],
    containers: [c],
  });

describe('a container resolves its user properties as it enters (#1673)', () => {
  for (const kind of ['foreach', 'loop', 'stage'] as const) {
    it(`${kind}: on its run state, resolved in the outer scope`, () => {
      const { state, finish } = driveRun(engineFor(box(kind)), {
        params: PARAMS,
        resolve: simpleResolve(),
      });
      expect(finish?.outcome).toBe('success');
      expect(state.containers.c!.userProperties).toEqual(RESOLVED);
    });
  }

  it('reads what the container’s predecessors produced, as they stood at entry', () => {
    const c = box('stage', {
      userProperties: [{ name: 'First', value: '${nodes.first.status}' }],
    });
    const { state } = driveRun(engineFor(c), { params: PARAMS, resolve: simpleResolve() });
    expect(state.containers.c!.userProperties).toEqual([{ name: 'First', value: 'success' }]);
  });

  it('a parallel ForEach records them too', () => {
    const { state } = driveRun(engineFor(box('foreach', { batchCount: 2 })), {
      params: PARAMS,
      resolve: simpleResolve(),
    });
    expect(state.containers.c!.status).toBe('success');
    expect(state.containers.c!.userProperties).toEqual(RESOLVED);
  });

  it('resolves them once: a loop\u2019s later rounds do not re-resolve them', () => {
    // At entry its body has not settled, so the read is an error; after round 1
    // it has. Re-resolving on a re-round would record `success` instead.
    const c = box('loop', {
      exitWhen: '${equals(1, 2)}',
      maxRounds: 2,
      userProperties: [{ name: 'Body', value: '${nodes.body.status}' }],
    });
    const { state } = driveRun(engineFor(c), { params: PARAMS, resolve: simpleResolve() });
    expect(state.containers.c!.round).toBeGreaterThan(0);
    const [body] = state.containers.c!.userProperties!;
    expect(body!.value).toBeUndefined();
    expect(body!.error).toMatch(/has not settled/);
  });

  it('a ForEach with no items still entered, so it still records them', () => {
    const { state } = driveRun(engineFor(box('foreach')), {
      params: { ...PARAMS, list: [] },
      resolve: simpleResolve(),
    });
    expect(state.containers.c!.status).toBe('success');
    expect(state.containers.c!.userProperties).toEqual(RESOLVED);
  });

  it('a property that cannot be resolved records its error, and the container still runs', () => {
    const c = box('stage', { userProperties: [{ name: 'Bad', value: '${params.missing.deep}' }] });
    const { state, finish, order } = driveRun(engineFor(c), {
      params: PARAMS,
      resolve: simpleResolve(),
    });
    expect(order).toContain('body');
    expect(finish?.outcome).toBe('success');
    const [bad] = state.containers.c!.userProperties!;
    expect(bad!.name).toBe('Bad');
    expect(bad!.value).toBeUndefined();
    expect(bad!.error).toEqual(expect.any(String));
  });

  it('none when the container has none, or an empty list', () => {
    for (const userProperties of [undefined, []]) {
      const { state } = driveRun(engineFor(box('stage', { userProperties })), {
        params: PARAMS,
        resolve: simpleResolve(),
      });
      expect(state.containers.c!).not.toHaveProperty('userProperties');
    }
  });

  it('none on a container that never entered (skipped)', () => {
    const { state } = driveRun(engineFor(box('stage')), {
      params: PARAMS,
      resolve: simpleResolve({ first: 'failure' }),
    });
    expect(state.containers.c!.status).toBe('skipped');
    expect(state.containers.c!.userProperties).toBeUndefined();
  });

  it('an inactive container records literals only', () => {
    const { state, order } = driveRun(engineFor(box('foreach', { state: 'inactive' })), {
      params: PARAMS,
      resolve: simpleResolve(),
    });
    expect(order).not.toContain('body');
    expect(state.containers.c!.userProperties).toEqual([
      { name: 'Source', error: INACTIVE_USER_PROPERTY_UNRESOLVED },
      { name: 'Kind', value: 'nightly' },
    ]);
  });

  it('replays to the same state, so the log needs no record of them', () => {
    const eng = engineFor(box('foreach'));
    const { state, log } = driveRun(eng, { params: PARAMS, resolve: simpleResolve() });
    let replay = eng.seedState();
    for (const ev of log) replay = eng.reduce(replay, ev).state;
    expect(replay).toEqual(state);
    expect(replay.containers.c!.userProperties).toEqual(RESOLVED);
  });

  it('a rerun’s copied container carries the source run’s record on', () => {
    const copied = {
      status: 'success' as const,
      round: 0,
      outputs: {},
      userProperties: [{ name: 'Kind', value: 'from the source run' }],
    };
    const { state } = driveRun(engineFor(box('stage')), {
      params: PARAMS,
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'src',
        frontier: [],
        copiedOutputs: {},
        copiedContainers: { c: copied },
      },
    });
    expect(state.containers.c!.userProperties).toEqual(copied.userProperties);
  });
});

describe('a rerun\u2019s malformed inactive mark (#1673)', () => {
  it('drops the literal-only record with the mark', () => {
    const copied = {
      status: 'success' as const,
      round: 0,
      outputs: {},
      inactive: true as const,
      userProperties: [{ name: 'Kind', error: INACTIVE_USER_PROPERTY_UNRESOLVED }],
    };
    const { state, diagnostics } = driveRun(engineFor(box('stage')), {
      params: PARAMS,
      resolve: simpleResolve(),
      reseed: {
        sourceRunId: 'src',
        frontier: [],
        copiedOutputs: {},
        copiedContainers: { c: copied },
      },
    });
    expect(diagnostics.some((d) => d.includes('inactive mark'))).toBe(true);
    expect(state.containers.c!.inactive).toBeUndefined();
    expect(state.containers.c!.userProperties).toBeUndefined();
  });
});

describe('a container’s user properties at save (#1673)', () => {
  // A loop's own `exitWhen` must read its body (not a constant) to save.
  const valid = (c: Container): Container =>
    c.kind === 'loop' ? { ...c, exitWhen: "${equals(nodes.body.status, 'success')}" } : c;
  const errs = (c: Container) =>
    validatePipelineDoc({
      params: [
        { name: 'file', type: 'string', required: false },
        { name: 'list', type: 'json', required: false },
      ],
      variables: [],
      nodes: [node('first'), node('body')],
      edges: [edge('first', 'c')],
      containers: [valid(c)],
    }).join('\n');

  it('accepts literals, params and a predecessor’s output', () => {
    expect(
      errs(
        box('stage', {
          userProperties: [
            { name: 'File', value: '${params.file}' },
            { name: 'First', value: '${nodes.first.status}' },
          ],
        }),
      ),
    ).toBe('');
  });

  it('refuses a bad ref, naming the container and the row', () => {
    expect(
      errs(box('loop', { userProperties: [{ name: 'X', value: '${params.nope}' }] })),
    ).toContain('container.c.userProperties[0].value');
  });

  it('refuses ${item} on a ForEach: it resolves before any item exists', () => {
    expect(errs(box('foreach', { userProperties: [{ name: 'X', value: '${item}' }] }))).toContain(
      'container.c.userProperties[0].value',
    );
  });

  it('refuses a read of one of its own children, which has not run at entry', () => {
    expect(
      errs(box('stage', { userProperties: [{ name: 'X', value: '${nodes.body.status}' }] })),
    ).toContain('container.c.userProperties[0].value');
  });

  it('refuses a read of a secure output, as an activity\u2019s does', () => {
    const errors = validatePipelineDoc({
      params: [],
      variables: [],
      nodes: [node('first', { policy: { secureInput: true, secureOutput: true } }), node('body')],
      edges: [edge('first', 'c')],
      containers: [
        box('stage', { userProperties: [{ name: 'X', value: '${nodes.first.output.result}' }] }),
      ],
    }).join('\n');
    expect(errors).toContain("node 'first' has secure outputs");
  });

  it('counts a variable read in one', () => {
    const { reads, validatorErrors } = variableReadsOf({
      params: [],
      variables: [{ name: 'v', type: 'string', default: '' }],
      nodes: [node('first'), node('body')],
      edges: [edge('first', 'c')],
      containers: [box('stage', { userProperties: [{ name: 'V', value: '${vars.v}' }] })],
    });
    expect(validatorErrors).toEqual([]);
    expect([...(reads.get('c') ?? [])]).toContain('v');
  });

  it('skips an inactive container, as it skips the rest of it', () => {
    expect(
      errs(
        box('stage', {
          state: 'inactive',
          userProperties: [{ name: 'X', value: '${params.nope}' }],
        }),
      ),
    ).toBe('');
  });
});
