/**
 * #4 A8 — the `filter` control activity (run-time + save-time halves).
 *
 * A `filter` node is engine-evaluated like `if`/`switch`/`fail` (`kind:'control'`,
 * never dispatched), but — unlike a branch (`if`/`switch`) or a failure (`fail`) —
 * it produces a normal SUCCESS with an OUTPUT: the input array filtered by a
 * whole-value `${}` boolean predicate, order-preserved. A ready `filter` resolves
 * its `items` + `predicate` PURELY (by composing them into the INERT expression
 * language's existing `filter(items, predicate)` closed-fn, evaluated under ONE
 * element budget), holds `ready`, and the driver appends `node.succeeded{outputs:
 * {result}}` via the reducer's own `succeedControl` command. Downstream nodes then
 * read `${nodes.<filter>.output.result}`.
 *
 * All run-time assertions go through the shared `driveRun` harness against the
 * REAL reducer (no mocks); the harness folds `succeedControl` exactly as the
 * server driver's `pump` does. Save-time assertions call the real
 * `validateDoc`/`validateRefs`.
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineEvent, Node, Param, PipelineVersion } from '../types.js';
import { createEngine, type Engine, type EngineDoc } from '../reduce.js';
import { validateDoc, validateRefs, validatePipelineDoc } from '../params.js';
import { getActivity } from '../../catalog/registry.js';
import { CATALOG_VERSION } from '../../schemas/version.js';
import { driveRun, simpleResolve } from './helpers/run-driver.js';

let seq = 0;
function node(id: string, config: Record<string, unknown> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config, position: { x: seq, y: 0 } };
}
function filterNode(
  id: string,
  items: unknown,
  predicate: unknown,
  config: Record<string, unknown> = {},
): Node {
  seq += 1;
  return {
    id,
    type: 'filter',
    config: { items, predicate, ...config },
    position: { x: seq, y: 0 },
  };
}
function edge(
  from: string,
  to: string,
  on: 'success' | 'failure' | 'completion' | 'skipped' = 'success',
): Edge {
  return { id: `${from}->${to}:${on}`, from, to, on };
}
function eng(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers } satisfies EngineDoc);
}
function doc(
  nodes: Node[],
  edges: Edge[] = [],
  containers: Container[] = [],
  params: Param[] = [],
): Pick<PipelineVersion, 'params' | 'nodes' | 'edges' | 'containers'> {
  return { params, nodes, edges, containers };
}
const foreach = (id: string, children: string[], items: string): Container => ({
  id,
  kind: 'foreach',
  children,
  items,
});

const succeededEvents = (log: EngineEvent[], nodeId: string) =>
  log.filter((e) => e.type === 'node.succeeded' && e.nodeId === nodeId) as Extract<
    EngineEvent,
    { type: 'node.succeeded' }
  >[];

describe('filter keeps the matching elements, order-preserved (#4 A8)', () => {
  it('produces node.succeeded with result = the filtered array', () => {
    const e = eng([filterNode('f', '${params.nums}', '${greater(item, 2)}')]);
    const { state, order, finish, log } = driveRun(e, {
      params: { nums: [1, 4, 2, 5, 3] },
      resolve: simpleResolve(),
    });

    expect(state.nodes.f!.status).toBe('success');
    // Input order preserved (NOT sorted): 4, 5, 3 in their original positions.
    expect(state.outputs.f).toEqual({ result: [4, 5, 3] });
    expect(finish?.outcome).toBe('success');
    // Engine-evaluated: never handed to the executor.
    expect(order).not.toContain('f');
    expect(log.some((ev) => ev.type === 'node.dispatched' && ev.nodeId === 'f')).toBe(false);
    // The output is a durable fact in the log before any downstream walk.
    expect(succeededEvents(log, 'f')[0]?.outputs).toEqual({ result: [4, 5, 3] });
  });

  it('an empty input array succeeds with result:[]', () => {
    const e = eng([filterNode('f', '${params.nums}', '${greater(item, 2)}')]);
    const { state, finish } = driveRun(e, { params: { nums: [] }, resolve: simpleResolve() });
    expect(state.nodes.f!.status).toBe('success');
    expect(state.outputs.f).toEqual({ result: [] });
    expect(finish?.outcome).toBe('success');
  });

  it('a predicate that matches nothing succeeds with result:[]', () => {
    const e = eng([filterNode('f', '${params.nums}', '${greater(item, 99)}')]);
    const { state } = driveRun(e, { params: { nums: [1, 2, 3] }, resolve: simpleResolve() });
    expect(state.outputs.f).toEqual({ result: [] });
  });

  it('a downstream node reads ${nodes.f.output.result}', () => {
    const e = eng(
      [filterNode('f', '${params.nums}', '${greater(item, 2)}'), node('use')],
      [edge('f', 'use', 'success')],
    );
    const { state } = driveRun(e, { params: { nums: [1, 3, 5] }, resolve: simpleResolve() });
    expect(state.nodes.use!.status).toBe('success');
    // The consumer resolved the filter's output — proven by a clean run (an
    // unresolvable ${} would have thrown → invalid_event before `use` succeeded).
    expect(state.outputs.f).toEqual({ result: [3, 5] });
  });
});

describe('filter with a malformed config fails the run LOUD (#4 A8)', () => {
  it('items resolving to a non-array → invalid_event (never a silent empty result)', () => {
    const e = eng([filterNode('f', '${params.notarray}', '${greater(item, 2)}')]);
    const { finish, finishes } = driveRun(e, {
      params: { notarray: 'oops' },
      resolve: simpleResolve(),
    });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
    expect(finishes).toBe(1);
  });

  it('a predicate resolving to a non-boolean for an element → invalid_event', () => {
    // `${item}` alone is a number, not a boolean — the predicate is not a boolean.
    const e = eng([filterNode('f', '${params.nums}', '${item}')]);
    const { finish } = driveRun(e, { params: { nums: [1, 2] }, resolve: simpleResolve() });
    expect(finish?.outcome).toBe('failure');
    expect(finish?.reason).toBe('invalid_event');
  });

  it('a bad ${} ref in items → invalid_event', () => {
    const e = eng([filterNode('f', '${nodes.missing.output.x}', '${greater(item, 2)}')]);
    const { finish } = driveRun(e, { resolve: simpleResolve() });
    expect(finish?.reason).toBe('invalid_event');
  });
});

describe('filter binds ${item} per element, shadowing an outer foreach (#4 A8)', () => {
  it('inside a foreach body: items sees the foreach ${item}, the predicate ${item} shadows to each element', () => {
    // foreach over [[1,4,2],[5,0]]: the filter child iterates the CURRENT sub-array
    // (`items:${item}`) and keeps elements > 2 (`predicate:${item}` shadows). Each
    // round appends one node.succeeded, proving the outer item reached `items` AND
    // the inner element reached the predicate.
    const e = eng(
      [filterNode('f', '${item}', '${greater(item, 2)}')],
      [],
      [foreach('fe', ['f'], '${params.lists}')],
    );
    const { state, log } = driveRun(e, {
      params: {
        lists: [
          [1, 4, 2],
          [5, 0],
        ],
      },
      resolve: simpleResolve(),
    });
    const results = succeededEvents(log, 'f').map((ev) => ev.outputs['result']);
    expect(results).toEqual([[4], [5]]);
    expect(state.containers.fe!.status).toBe('success');
  });
});

describe('filter crash recovery re-emits succeedControl (#4 A8)', () => {
  it('resume re-derives the succeedControl a projection discarded, never re-dispatching', () => {
    const e = eng([filterNode('f', '${params.nums}', '${greater(item, 2)}')]);
    const projected = e.projectRunState([
      { type: 'run.started', runId: 'r1', pipelineVersionId: 'pv1', params: { nums: [1, 3, 5] } },
    ]);
    expect(projected.nodes.f!.status).toBe('ready');
    const { commands } = e.resume(projected);
    expect(commands).toContainEqual({
      type: 'succeedControl',
      nodeId: 'f',
      attemptId: 'f#0',
      outputs: { result: [3, 5] },
    });
    // A control node must NEVER be re-dispatched to the executor on resume.
    expect(commands.some((c) => c.type === 'dispatchNode' && c.nodeId === 'f')).toBe(false);
  });

  it('re-derives succeedControl for a filter INSIDE a foreach, threading the foreach ${item}', () => {
    // The exact #569 shape (which the if/switch RECOVERY path still gets wrong):
    // a `${item}`-bearing field on a control node inside a foreach body. The filter
    // recovery fork must pass `foreachItemOf` so `items:${item}` (the current
    // sub-array) re-resolves — if it omitted it (like #569), `${item}` would throw
    // and resume would emit `finishRun{invalid_event}` instead of succeedControl.
    const e = eng(
      [filterNode('f', '${item}', '${greater(item, 2)}')],
      [],
      [foreach('fe', ['f'], '${params.lists}')],
    );
    const projected = e.projectRunState([
      {
        type: 'run.started',
        runId: 'r1',
        pipelineVersionId: 'pv1',
        params: { lists: [[1, 4], [5]] },
      },
    ]);
    // Item 0's body child is `ready` (its succeedControl command was discarded).
    expect(projected.nodes.f!.status).toBe('ready');
    const { commands } = e.resume(projected);
    // Item 0 = [1,4] → [4]; the foreach `${item}` reached `items`, the predicate
    // `${item}` shadowed per element — proving the recovery fork is #569-free.
    expect(commands).toContainEqual({
      type: 'succeedControl',
      nodeId: 'f',
      attemptId: 'f#0',
      outputs: { result: [4] },
    });
    expect(commands.some((c) => c.type === 'finishRun')).toBe(false);
  });
});

describe('filter save-time validation (#4 A8)', () => {
  it('accepts a well-formed filter', () => {
    const d = doc(
      [filterNode('f', '${params.nums}', '${greater(item, 2)}')],
      [],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    expect(validatePipelineDoc(d)).toEqual([]);
  });

  it('allows ${item} in the predicate even when the filter is NOT inside a foreach', () => {
    // The predicate is a lambda arg of the composed `filter(items, predicate)`, so
    // its `${item}` is always in scope — unlike a bare node config field.
    const d = doc(
      [filterNode('f', '${params.nums}', '${greater(item, 2)}')],
      [],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    expect(validateRefs(d)).toEqual([]);
  });

  it('rejects ${item} in items when the filter is NOT inside a foreach', () => {
    // `items` is the outer-scope arg0 — `${item}` there needs foreach membership.
    const d = doc([filterNode('f', '${item}', '${greater(item, 2)}')]);
    expect(validateRefs(d).join(' ')).toMatch(/item/);
  });

  it('rejects a non-whole-value items (embedded template) → whole-value error', () => {
    const d = doc(
      [filterNode('f', 'x${params.nums}', '${greater(item, 2)}')],
      [],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    expect(validateDoc(d).join(' ')).toContain('whole-value');
  });

  it('rejects a non-whole-value predicate (embedded template) → whole-value error', () => {
    const d = doc(
      [filterNode('f', '${params.nums}', 'x${greater(item, 2)}')],
      [],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    expect(validateDoc(d).join(' ')).toContain('whole-value');
  });

  it('rejects a missing items', () => {
    const d = doc([filterNode('f', undefined, '${greater(item, 2)}')]);
    expect(validateDoc(d).join(' ')).toMatch(/items/);
  });

  it('rejects a missing predicate', () => {
    const d = doc([filterNode('f', '${params.nums}', undefined)]);
    expect(validateDoc(d).join(' ')).toMatch(/predicate/);
  });

  it('rejects an unterminated ${ in items at SAVE (not deferred to a run-time invalid_event)', () => {
    // A common authoring typo. `validateWholeValue`/`defectOf` stay silent on a
    // grammar error (it is the scan's to report); a filter replaces the generic
    // node scan, so `scanFilterRefs`' fallback must still surface it at save.
    const d = doc(
      [filterNode('f', '${params.nums', '${greater(item, 2)}')],
      [],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    expect(validatePipelineDoc(d).join(' ')).toMatch(/unterminated/);
  });

  it('rejects a bad ${} ref inside a non-whole-value predicate at SAVE', () => {
    // Not composable (embedded template), so the composed scan is skipped — the
    // fallback scan must still badge the undeclared-node ref, not defer it to run.
    const d = doc(
      [filterNode('f', '${params.nums}', 'x${nodes.ghost.output.y}')],
      [],
      [],
      [{ name: 'nums', type: 'json', required: true }],
    );
    expect(validateRefs(d).join(' ')).toMatch(/ghost/);
  });
});

describe('filter catalog entry (#4 A8)', () => {
  it('is a control activity that produces a `result` output', () => {
    const entry = getActivity('filter');
    expect(entry?.kind).toBe('control');
    expect(entry?.connectionKinds).toEqual([]);
    expect(entry?.outputs.map((o) => o.name)).toContain('result');
  });

  it('cataloguing the filter type bumped CATALOG_VERSION to at least 6', () => {
    // Filter's bump was 5→6; it is no longer the LATEST catalogued type (A6's
    // `wait` bumped 6→7), so this pins the floor its bump established rather than
    // the current value — the newest routing test (`wait-routing`) pins the exact
    // version, the house pattern for "latest activity owns the version assertion".
    expect(CATALOG_VERSION).toBeGreaterThanOrEqual(6);
  });
});
