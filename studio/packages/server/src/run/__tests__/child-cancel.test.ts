import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  type CancelSource,
  type Edge,
  type EngineEvent,
  type NewPipelineVersion,
  type Node,
  type Run,
} from '@autonomy-studio/shared';
import { createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun, listRuns } from '../../repo/runs.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { createConnectorRegistry } from '../../connectors/registry.js';
import type { Supervisor } from '../../workers/process-supervisor.js';
import { createRunCancels } from '../cancel.js';
import { cancelLiveChildren, createRunCanceller, type RunCanceller } from '../cancel-service.js';
import { createChildRuns, subscribeChildReturns, type ChildRuns } from '../child.js';
import {
  onCancelFolded,
  startRun,
  type DocResolver,
  type DriveDeps,
  type DriveLog,
  type Executor,
  type ExecutorCommand,
} from '../driver.js';
import { createRunDrives } from '../drives.js';
import { createRunEventBus } from '../event-bus.js';
import { createExecutor } from '../executor.js';
import { appendEngineEvent, loadEngineEvents } from '../events.js';
import { abortableExecutor } from './abortable-executor.js';
import { stubAlarms } from './stub-alarms.js';

/**
 * CX3 (#1320, spec D8) — a cancel propagates to a run's LIVE, NON-DETACHED
 * `call_pipeline` children, transitively, and a run that ends asks its live
 * children to stop (#1056's live path).
 *
 * Everything on the path is REAL and wired the way `index.ts` wires it: the
 * executor's `startChild` branch, `createChildRuns`, the child-return reactor
 * (which is also the terminal tap), the driver, the ONE cancel registry whose
 * `cancelChildren` is `cancelLiveChildren` over the route's own canceller (a
 * lazy closure), and a real DB. Only the LEAF dispatch is stubbed: a hanging
 * leaf blocks until its run is aborted (then fails `cancelled`, as the real
 * adapters do on their signal) or until the test completes it.
 */

type Db = ReturnType<typeof freshDb>['db'];

const noopSupervisor: Supervisor = {
  spawnSupervised: () => {
    throw new Error('no adapter should run: every leaf is stubbed');
  },
  reapAllSupervised: () => Promise.resolve(),
};

let KEY: Uint8Array;
beforeAll(async () => {
  await sodium.ready;
  KEY = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
});

let seq = 0;
function leaf(id: string): Node {
  seq += 1;
  return { id, type: 'test_activity', config: {}, position: { x: seq, y: 0 } };
}

function callNode(id: string, pipelineVersionId: string, wait?: boolean): Node {
  seq += 1;
  return {
    id,
    type: 'call_pipeline',
    config: {},
    position: { x: seq, y: 0 },
    call: { pipelineVersionId, params: {}, ...(wait === undefined ? {} : { wait }) },
  };
}

/**
 * Top-level nodes with no edges between them are NOT all ready at once, so a
 * test that needs parallel in-flight work fans out from a root: `fanOut`
 * prepends a (non-hanging) `root` whose success edges lead to every node given.
 */
function fanOut(nodes: Node[]): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [leaf('root'), ...nodes],
    edges: nodes.map((n) => ({ id: `root->${n.id}`, from: 'root', to: n.id, on: 'success' })),
  };
}

function seedVersion(db: Db, nodes: Node[] | { nodes: Node[]; edges: Edge[] }): string {
  const doc = Array.isArray(nodes) ? { nodes, edges: [] } : nodes;
  const pipeline = createPipeline(db, { ownerId: 'local', name: `P${(seq += 1)}` });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes: doc.nodes,
    edges: doc.edges,
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedRun(db: Db, pvId: string, parentRunId: string | null = null): Run {
  return createRun(db, {
    ownerId: 'local',
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId,
    params: {},
  });
}

function resolveDocFor(db: Db): DocResolver {
  return (id) => {
    const pv = getPipelineVersion(db, id);
    if (pv === null) throw new Error(`no pv ${id}`);
    return pv;
  };
}

interface BoundaryOptions {
  /** Hold the parent's `call.started` (the child ROW already exists) until this
   * resolves: the window where a parent's cancel cannot yet see its child. */
  holdCallStarted?: () => Promise<void>;
  /** Capture `kick`s instead of performing them; `releaseKicks` performs them. */
  holdKicks?: boolean;
}

/**
 * The server's cancel + child wiring, as `index.ts` builds it: one registry,
 * whose `cancelChildren` reaches children through the canceller built FROM the
 * boundary that holds the registry (hence the lazy closure), and the same
 * registry handed to the driver deps and to the terminal tap.
 */
function boundary(db: Db, hang: ReadonlySet<string>, opts: BoundaryOptions = {}) {
  const resolveDoc = resolveDocFor(db);
  const drives = createRunDrives();
  const bus = createRunEventBus();
  const errors: { obj: unknown; msg?: string }[] = [];
  const log: DriveLog = {
    error: (obj, msg) => {
      errors.push({ obj, msg });
    },
  };
  const leaves = abortableExecutor(hang);

  // Assigned once, below; the closures resolve them long after this returns.
  // eslint-disable-next-line prefer-const
  let childRuns: ChildRuns;
  // eslint-disable-next-line prefer-const
  let canceller: RunCanceller;
  const heldKicks: Run[] = [];

  const real = createExecutor({
    db,
    masterKey: KEY,
    resolveDoc,
    adapters: createConnectorRegistry({ supervisor: noopSupervisor }),
    childRuns: {
      ensure: (c, p) => childRuns.ensure(c, p),
      kick: (r) => {
        if (opts.holdKicks === true) heldKicks.push(r);
        else childRuns.kick(r);
      },
      result: (id) => childRuns.result(id),
    },
  });
  async function* startChild(command: ExecutorCommand, runId: string): AsyncGenerator<EngineEvent> {
    for await (const e of real.perform(command, runId)) {
      if (e.type === 'call.started' && opts.holdCallStarted !== undefined) {
        await opts.holdCallStarted();
      }
      yield e;
    }
  }
  const executor: Executor = {
    perform: (command, runId) =>
      command.type === 'startChild' ? startChild(command, runId) : leaves.perform(command, runId),
    abortRun: (runId) => {
      leaves.abortRun(runId);
      real.abortRun?.(runId);
    },
  };

  const cancels = createRunCancels({
    cancelChildren: (parentRunId, source) =>
      cancelLiveChildren({ db, resolveDoc, canceller, log }, parentRunId, source),
  });
  const deps: DriveDeps = {
    db,
    resolveDoc,
    executor,
    alarms: stubAlarms(),
    drives,
    bus,
    cancels,
    log,
  };
  canceller = createRunCanceller({ ...deps, cancels });
  childRuns = createChildRuns(deps);
  const unsubscribe = subscribeChildReturns({ ...deps, bus, cancels, childRuns });
  return {
    ...deps,
    bus,
    cancels,
    canceller,
    childRuns,
    leaves,
    errors,
    unsubscribe,
    releaseKicks: () => {
      for (const r of heldKicks.splice(0)) childRuns.kick(r);
    },
  };
}

const TERMINAL = new Set(['success', 'failure', 'interrupted', 'cancelled']);
const status = (db: Db, runId: string): string | undefined => getRun(db, runId)?.status;
const isTerminal = (db: Db, runId: string): boolean => TERMINAL.has(status(db, runId) ?? '');
const types = (db: Db, runId: string): string[] => loadEngineEvents(db, runId).map((e) => e.type);

function eventsOf<T extends EngineEvent['type']>(
  db: Db,
  runId: string,
  type: T,
): Extract<EngineEvent, { type: T }>[] {
  return loadEngineEvents(db, runId).filter(
    (e): e is Extract<EngineEvent, { type: T }> => e.type === type,
  );
}

const cancelSources = (db: Db, runId: string): CancelSource[] =>
  eventsOf(db, runId, 'run.cancelRequested').map((e) => e.source);

/** Poll until `pred` holds or `ms` elapses — bounded, so a broken propagation
 * fails its assertions instead of hanging the suite. */
async function until(pred: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 2));
  }
  return true;
}

/** Enough macrotask turns for the tap's microtask, a poke and a queued drive to
 * have acted — used before asserting that something did NOT happen. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("CX3 — a parent's cancel reaches its live, non-detached children", () => {
  it('cancelling a parent with a live pump cancels its waiting child, and the parent ends cancelled', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    // `sib` keeps the parent's PUMP live, so the cancel folds through its poke
    // while the call node is waiting on the child.
    const parentPv = seedVersion(db, fanOut([leaf('sib'), callNode('caller', childPv)]));
    const parent = seedRun(db, parentPv);
    const b = boundary(db, new Set(['sib', 'work']));

    const started = b.drives.serialize(parent.id, () => startRun(b, parent));
    await b.leaves.hanging(2);
    const children = listRuns(db, { parentRunId: parent.id });
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(status(db, child.id)).toBe('running');

    expect(b.canceller.cancel(parent.id)).toEqual({ kind: 'accepted', state: 'requested' });
    expect(await until(() => isTerminal(db, parent.id) && isTerminal(db, child.id))).toBe(true);
    await started;

    // The child was asked through the route's own path, naming its parent.
    expect(cancelSources(db, child.id)).toEqual([
      { kind: 'parent_cancelled', parentRunId: parent.id },
    ]);
    expect(status(db, child.id)).toBe('cancelled');
    expect(eventsOf(db, child.id, 'run.finished')).toMatchObject([{ outcome: 'cancelled' }]);
    expect(b.leaves.aborts).toEqual([parent.id, child.id]);

    // The parent folded its cancel in its own pump, before `sib`'s failure.
    const parentTypes = types(db, parent.id);
    expect(parentTypes.indexOf('run.cancelRequested')).toBeLessThan(
      parentTypes.indexOf('node.failed'),
    );
    expect(cancelSources(db, parent.id)).toEqual([{ kind: 'operator' }]);
    // The child's cancelled outcome came back as such, so the parent's cancel
    // counts it as work it stopped: `cancelled`, not `failure` (D3).
    expect(eventsOf(db, parent.id, 'call.returned')).toMatchObject([
      { childRunId: child.id, childOutcome: 'cancelled' },
    ]);
    expect(eventsOf(db, parent.id, 'run.finished')).toMatchObject([{ outcome: 'cancelled' }]);
    expect(status(db, parent.id)).toBe('cancelled');
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });

  it('is TRANSITIVE: cancelling a parent cancels its grandchild, which names the CHILD as its parent', async () => {
    const { db } = freshDb();
    const grandPv = seedVersion(db, [leaf('gwork')]);
    const childPv = seedVersion(db, [callNode('ccall', grandPv)]);
    const parentPv = seedVersion(db, fanOut([leaf('sib'), callNode('caller', childPv)]));
    const parent = seedRun(db, parentPv);
    const b = boundary(db, new Set(['sib', 'gwork']));

    const started = b.drives.serialize(parent.id, () => startRun(b, parent));
    await b.leaves.hanging(2);
    const child = listRuns(db, { parentRunId: parent.id })[0]!;
    const grandchild = listRuns(db, { parentRunId: child.id })[0]!;
    expect(grandchild).toBeDefined();
    expect(status(db, grandchild.id)).toBe('running');

    b.canceller.cancel(parent.id);
    expect(
      await until(() => [parent.id, child.id, grandchild.id].every((id) => isTerminal(db, id))),
    ).toBe(true);
    await started;

    expect(cancelSources(db, grandchild.id)).toEqual([
      { kind: 'parent_cancelled', parentRunId: child.id },
    ]);
    expect(status(db, grandchild.id)).toBe('cancelled');
    expect(cancelSources(db, child.id)).toEqual([
      { kind: 'parent_cancelled', parentRunId: parent.id },
    ]);
    expect(status(db, child.id)).toBe('cancelled');
    // The CHILD has no live pump (its only node waits on the grandchild), so
    // its cancel folds through the serialized drive, whose cancel-mode resume
    // fails the waiting call node at once (`resumeCancelled`): it finishes
    // without waiting for the grandchild's return (D8: best-effort, not awaited).
    expect(eventsOf(db, child.id, 'run.finished')).toMatchObject([{ outcome: 'cancelled' }]);
    expect(status(db, parent.id)).toBe('cancelled');
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });

  it('a DETACHED child (wait:false) is not cancelled when its parent is cancelled and ends: it runs on', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, fanOut([leaf('sib'), callNode('caller', childPv, false)]));
    const parent = seedRun(db, parentPv);
    const b = boundary(db, new Set(['sib', 'work']));

    const started = b.drives.serialize(parent.id, () => startRun(b, parent));
    await b.leaves.hanging(2);
    const child = listRuns(db, { parentRunId: parent.id })[0]!;
    expect(await until(() => types(db, parent.id).includes('call.detached'))).toBe(true);

    b.canceller.cancel(parent.id);
    expect(await until(() => isTerminal(db, parent.id))).toBe(true);
    await started;
    // Both routes have had their chance: the cancel fold (`parent_cancelled`)
    // and the parent's terminal through the tap (`parent_terminal`).
    await flush();
    expect(status(db, parent.id)).toBe('cancelled');

    expect(types(db, child.id)).not.toContain('run.cancelRequested');
    expect(b.cancels.pending(child.id)).toBe(false);
    expect(b.leaves.aborts).toEqual([parent.id]);
    expect(status(db, child.id)).toBe('running');

    // ...and it genuinely runs on to its own end.
    b.leaves.complete(child.id, 'work');
    expect(await until(() => isTerminal(db, child.id))).toBe(true);
    expect(status(db, child.id)).toBe('success');
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });
});

describe('CX3 / #1056 — a run that ENDS asks its live children to stop', () => {
  it('a parent reaching a terminal fact while its announced child is live cancels the child with parent_terminal', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const parent = seedRun(db, parentPv);
    const b = boundary(db, new Set(['work']));

    // The parent's drive returns with the call node WAITING on its child.
    await b.drives.serialize(parent.id, () => startRun(b, parent));
    await b.leaves.hanging(1);
    const child = listRuns(db, { parentRunId: parent.id })[0]!;
    expect(status(db, child.id)).toBe('running');

    // Any terminal fact, through the bus the tap watches.
    appendEngineEvent(db, { type: 'run.interrupted', runId: parent.id, reason: 'test' }, b.bus);
    expect(await until(() => isTerminal(db, child.id))).toBe(true);

    expect(cancelSources(db, child.id)).toEqual([
      { kind: 'parent_terminal', parentRunId: parent.id },
    ]);
    expect(status(db, child.id)).toBe('cancelled');
    expect(b.leaves.aborts).toEqual([child.id]);
    // The parent is over: nothing was cancelled on it, and the child's result
    // was delivered to nobody.
    await flush();
    expect(types(db, parent.id)).toEqual(['run.started', 'call.started', 'run.interrupted']);
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });

  it('an UNANNOUNCED child row (no call.started in the parent log) is not reached; an announced sibling is', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const parent = seedRun(db, parentPv);
    const unannounced = seedRun(db, childPv, parent.id);
    const announced = seedRun(db, childPv, parent.id);
    // The parent's log, appended WITHOUT the bus so nothing reacts to it: it
    // announced one child and is over (so a child's return is a no-op).
    appendEngineEvent(db, {
      type: 'call.started',
      runId: parent.id,
      callNodeId: 'caller',
      attemptId: 'att-1',
      childRunId: announced.id,
    });
    appendEngineEvent(db, { type: 'run.interrupted', runId: parent.id, reason: 'test' });
    const b = boundary(db, new Set());

    b.cancels.cancelChildren(parent.id, { kind: 'parent_terminal', parentRunId: parent.id });
    expect(await until(() => isTerminal(db, announced.id))).toBe(true);
    await flush();

    // The positive control: the same call reached the announced child.
    expect(types(db, announced.id)).toEqual(['run.cancelRequested', 'run.finished']);
    expect(status(db, announced.id)).toBe('cancelled');
    // The unannounced one was never touched.
    expect(types(db, unannounced.id)).toEqual([]);
    expect(b.cancels.pending(unannounced.id)).toBe(false);
    expect(status(db, unannounced.id)).toBe('pending');
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });
});

describe('CX3 — a child that STARTS after its parent was cancelled or ended', () => {
  it('kick of a child announced after the parent cancel folded starts it cancelled (parent_cancelled), with no run.started', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const parent = seedRun(db, parentPv);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Hold the parent's `call.started`: the child ROW exists, but the parent
    // has not announced it, so the parent's cancel propagation must skip it.
    const b = boundary(db, new Set(), { holdCallStarted: () => gate });

    const started = b.drives.serialize(parent.id, () => startRun(b, parent));
    expect(await until(() => listRuns(db, { parentRunId: parent.id }).length === 1)).toBe(true);
    const child = listRuns(db, { parentRunId: parent.id })[0]!;

    b.canceller.cancel(parent.id);
    expect(await until(() => types(db, parent.id).includes('run.cancelRequested'))).toBe(true);
    await flush();
    // Propagation could not reach it (unannounced)...
    expect(b.cancels.pending(child.id)).toBe(false);
    expect(types(db, child.id)).toEqual([]);

    // ...so the announcement lands, the child is kicked, and `kick` applies the
    // parent's cancel itself.
    release();
    expect(await until(() => isTerminal(db, child.id) && isTerminal(db, parent.id))).toBe(true);
    await started;

    expect(types(db, child.id)).toEqual(['run.cancelRequested', 'run.finished']);
    expect(cancelSources(db, child.id)).toEqual([
      { kind: 'parent_cancelled', parentRunId: parent.id },
    ]);
    expect(status(db, child.id)).toBe('cancelled');
    expect(b.leaves.dispatched).toEqual([]);
    expect(eventsOf(db, parent.id, 'call.returned')).toMatchObject([
      { childRunId: child.id, childOutcome: 'cancelled' },
    ]);
    expect(status(db, parent.id)).toBe('cancelled');
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });

  it('kick of an announced child whose parent is already TERMINAL starts it cancelled (parent_terminal), with no run.started', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const parent = seedRun(db, parentPv);
    const b = boundary(db, new Set(), { holdKicks: true });

    await b.drives.serialize(parent.id, () => startRun(b, parent));
    const child = listRuns(db, { parentRunId: parent.id })[0]!;
    expect(types(db, parent.id)).toEqual(['run.started', 'call.started']);
    // Terminal WITHOUT the bus, so the tap's propagation does not get there
    // first: this isolates `kick`'s own reading of the parent.
    appendEngineEvent(db, { type: 'run.interrupted', runId: parent.id, reason: 'test' });

    b.releaseKicks();
    expect(await until(() => isTerminal(db, child.id))).toBe(true);

    expect(types(db, child.id)).toEqual(['run.cancelRequested', 'run.finished']);
    expect(cancelSources(db, child.id)).toEqual([
      { kind: 'parent_terminal', parentRunId: parent.id },
    ]);
    expect(status(db, child.id)).toBe('cancelled');
    expect(b.leaves.dispatched).toEqual([]);
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });

  it('a startChild still queued behind the per-run cap when the cancel folds creates NO child and returns cancelled', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    // Four hanging siblings fill the per-run cap (4); the call node is fifth.
    // Ready nodes are dispatched in node-id order, hence `zcall`.
    const siblings = ['a', 'b', 'c', 'd'];
    const parentPv = seedVersion(
      db,
      fanOut([...siblings.map((id) => leaf(id)), callNode('zcall', childPv)]),
    );
    const parent = seedRun(db, parentPv);
    const b = boundary(db, new Set(siblings));

    const started = b.drives.serialize(parent.id, () => startRun(b, parent));
    await b.leaves.hanging(4);
    // Set-up check: the call node's stream has not started.
    expect(listRuns(db, { parentRunId: parent.id })).toEqual([]);
    expect(types(db, parent.id)).not.toContain('call.started');

    b.canceller.cancel(parent.id);
    expect(await until(() => isTerminal(db, parent.id))).toBe(true);
    await started;
    await flush();

    expect(b.leaves.dispatched).toEqual(['root', ...siblings]);
    expect(listRuns(db, { parentRunId: parent.id })).toEqual([]);
    expect(types(db, parent.id)).not.toContain('call.started');
    const returned = eventsOf(db, parent.id, 'call.returned');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toEqual({
      type: 'call.returned',
      runId: parent.id,
      callNodeId: 'zcall',
      attemptId: expect.any(String) as string,
      childRunId: expect.any(String) as string,
      childOutcome: 'cancelled',
      outputs: {},
    });
    expect(eventsOf(db, parent.id, 'run.finished')).toMatchObject([{ outcome: 'cancelled' }]);
    expect(status(db, parent.id)).toBe('cancelled');
    expect(b.errors).toEqual([]);
    b.unsubscribe();
  });
});

describe("CX3 — result() passes a child's cancelled outcome through", () => {
  it('reports cancelled for a child whose log ends run.finished{cancelled}, and still failure for interrupted', () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parent = seedRun(db, seedVersion(db, [callNode('caller', childPv)]));
    const cancelled = seedRun(db, childPv, parent.id);
    const interrupted = seedRun(db, childPv, parent.id);
    appendEngineEvent(db, { type: 'run.finished', runId: cancelled.id, outcome: 'cancelled' });
    appendEngineEvent(db, { type: 'run.interrupted', runId: interrupted.id, reason: 'test' });
    const b = boundary(db, new Set());
    const childRuns = createChildRuns(b);

    expect(childRuns.result(cancelled.id).outcome).toBe('cancelled');
    expect(childRuns.result(interrupted.id).outcome).toBe('failure');
    b.unsubscribe();
  });
});

describe('CX3 — the propagation is best-effort: nothing it calls can throw into its caller', () => {
  function capture(): { log: DriveLog; errors: string[] } {
    const errors: string[] = [];
    return { log: { error: (_obj, msg) => errors.push(msg ?? '') }, errors };
  }

  /** A parent that ANNOUNCED two live children, so both are reachable. */
  function parentWithTwoChildren(db: Db) {
    const childPv = seedVersion(db, [leaf('w')]);
    const parent = seedRun(db, seedVersion(db, [callNode('c1', childPv), callNode('c2', childPv)]));
    const kids = ['c1', 'c2'].map((callNodeId) => {
      const child = seedRun(db, childPv, parent.id);
      appendEngineEvent(db, {
        type: 'call.started',
        runId: parent.id,
        callNodeId,
        attemptId: `${callNodeId}#0`,
        childRunId: child.id,
      });
      return child;
    });
    return { parent, kids };
  }

  it('cancelLiveChildren: a child whose cancel THROWS is logged, and the next child is still asked', () => {
    const { db } = freshDb();
    const { parent, kids } = parentWithTwoChildren(db);
    const { log, errors } = capture();
    const asked: string[] = [];
    const canceller: RunCanceller = {
      cancel(runId) {
        asked.push(runId);
        if (asked.length === 1) throw new Error('boom');
        return { kind: 'accepted', state: 'requested' };
      },
    };

    expect(() =>
      cancelLiveChildren({ db, resolveDoc: resolveDocFor(db), canceller, log }, parent.id, {
        kind: 'parent_cancelled',
        parentRunId: parent.id,
      }),
    ).not.toThrow();
    expect([...asked].sort()).toEqual(kids.map((k) => k.id).sort());
    expect(errors).toEqual(['run cancel: cancelling a child run failed']);
  });

  it('cancelLiveChildren: a parent log that cannot be read reaches NO child, and does not throw', () => {
    const { db, sqlite } = freshDb();
    const { parent } = parentWithTwoChildren(db);
    // The log is APPEND-ONLY, so the corruption is a poison APPENDED row (the
    // `events.test.ts` precedent).
    sqlite
      .prepare(
        'INSERT INTO run_events (id, run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('evt_poison', parent.id, 999, 'x', 'not json', 1_700_000_000_000);
    const { log, errors } = capture();
    const asked: string[] = [];
    const canceller: RunCanceller = {
      cancel(runId) {
        asked.push(runId);
        return { kind: 'accepted', state: 'requested' };
      },
    };

    expect(() =>
      cancelLiveChildren({ db, resolveDoc: resolveDocFor(db), canceller, log }, parent.id, {
        kind: 'parent_terminal',
        parentRunId: parent.id,
      }),
    ).not.toThrow();
    expect(asked).toEqual([]);
    expect(errors).toEqual(['run cancel: listing child runs failed']);
  });

  it('onCancelFolded: a throwing child propagation neither throws nor stops the abort', () => {
    const { log, errors } = capture();
    const aborted: string[] = [];
    expect(() =>
      onCancelFolded(
        {
          executor: { abortRun: (runId) => aborted.push(runId) },
          cancels: {
            cancelChildren: () => {
              throw new Error('boom');
            },
          },
          log,
        },
        'r1',
      ),
    ).not.toThrow();
    expect(aborted).toEqual(['r1']);
    expect(errors).toEqual(['run cancel: reaching child runs failed']);
  });

  it('the terminal tap: a throwing child propagation is logged, never thrown out of its microtask', async () => {
    const { db } = freshDb();
    const run = seedRun(db, seedVersion(db, [leaf('w')]));
    const bus = createRunEventBus();
    const errors: string[] = [];
    const unsubscribe = subscribeChildReturns({
      db,
      resolveDoc: resolveDocFor(db),
      executor: abortableExecutor(new Set()),
      alarms: stubAlarms(),
      drives: createRunDrives(),
      bus,
      log: { error: (_obj, msg) => errors.push(msg ?? '') },
      cancels: {
        ...createRunCancels(),
        cancelChildren: () => {
          throw new Error('boom');
        },
      },
      childRuns: createChildRuns({
        db,
        resolveDoc: resolveDocFor(db),
        executor: abortableExecutor(new Set()),
        alarms: stubAlarms(),
        drives: createRunDrives(),
      }),
    });
    appendEngineEvent(db, { type: 'run.interrupted', runId: run.id, reason: 'test' }, bus);
    await flush();
    unsubscribe();
    expect(errors).toEqual(['cancelling the child runs of an ended run failed']);
  });
});
