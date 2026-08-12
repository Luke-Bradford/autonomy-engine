import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NewPipelineVersion, Node } from '@autonomy-studio/shared';
import { CATALOG_VERSION, MAX_CALL_DEPTH } from '@autonomy-studio/shared';
import { archivePipelineRow, createPipeline } from '../../repo/pipelines.js';
import { createPipelineVersion, getPipelineVersion } from '../../repo/pipeline-versions.js';
import { createRun, getRun, listRuns } from '../../repo/runs.js';

import { createConnectorRegistry } from '../../connectors/registry.js';
import { createChildRuns, subscribeChildReturns, type ChildRuns } from '../child.js';
import { createRunDrives } from '../drives.js';
import { createRunEventBus } from '../event-bus.js';
import { createExecutor } from '../executor.js';
import { loadEngineEvents } from '../events.js';
import { startRun, type DocResolver, type Executor, type ExecutorCommand } from '../driver.js';
import { freshDb } from '../../repo/__tests__/helpers.js';
import { makeStubExecutor, type StubExecutorOptions } from './stub-executor.js';
import { refuseToArm } from './stub-alarms.js';
import type { Supervisor } from '../../workers/process-supervisor.js';

type Db = ReturnType<typeof freshDb>['db'];

const noopSupervisor: Supervisor = {
  spawnSupervised: () => {
    throw new Error("no adapter should run: the child pipeline's leaf is stubbed");
  },
  reapAllSupervised: () => Promise.resolve(),
};

/**
 * #796 (P3b) — `call_pipeline` CHILD EXECUTION, end to end.
 *
 * The seam under test is REAL: the real `createExecutor`'s `startChild` branch,
 * the real `createChildRuns` spawn/adopt logic, the real child-return reactor,
 * the real driver and a real DB. Only the LEAF activity dispatch is stubbed —
 * the child pipeline's own nodes resolve through `makeStubExecutor`, exactly as
 * every other driver test resolves a node without standing up a connector.
 */

let KEY: Uint8Array;
beforeAll(async () => {
  await sodium.ready;
  KEY = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
});

let seq = 0;
/** A leaf whose OUTPUT CONTRACT is declared on the node (F13a's `config.outputs`
 * override), so the stub can produce a named output the fold accepts. */
function leaf(id: string, outputs: { name: string; type: 'number' | 'string' }[] = []): Node {
  seq += 1;
  return {
    id,
    type: 'http_request',
    config: outputs.length > 0 ? { outputs } : {},
    position: { x: seq, y: 0 },
  };
}

function callNode(id: string, pipelineVersionId: string): Node {
  seq += 1;
  return {
    id,
    type: 'call_pipeline',
    config: {},
    position: { x: seq, y: 0 },
    call: { pipelineVersionId, params: {} },
  };
}

function seedVersion(db: Db, nodes: Node[], ownerId = 'local'): string {
  const pipeline = createPipeline(db, { ownerId, name: `P${(seq += 1)}` });
  const input: NewPipelineVersion = {
    pipelineId: pipeline.id,
    params: [],
    outputs: [],
    nodes,
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
  return createPipelineVersion(db, input).id;
}

function seedRun(db: Db, pvId: string, ownerId = 'local') {
  return createRun(db, {
    ownerId,
    pipelineVersionId: pvId,
    triggerId: null,
    parentRunId: null,
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

/**
 * A driver boundary whose executor runs the REAL `startChild` branch and stubs
 * only `dispatchNode`. Composed rather than mocked so the code path a real
 * server takes — executor → `childRuns` → driver → executor — is the one under
 * test, closed with the same lazy closure `index.ts` uses.
 */
function boundary(
  db: Db,
  nodeOutputs: Record<string, Record<string, unknown>> = {},
  nodePlans: StubExecutorOptions['nodes'] = {},
) {
  const resolveDoc = resolveDocFor(db);
  const drives = createRunDrives();
  const bus = createRunEventBus();
  const stub = makeStubExecutor({
    nodes: {
      ...Object.fromEntries(
        Object.entries(nodeOutputs).map(([id, outputs]) => [id, { outcome: 'success', outputs }]),
      ),
      ...nodePlans,
    },
  });
  // Assigned once, below — the lazy closure the executor holds resolves it long
  // after this function returns, exactly as `index.ts`'s wiring does.
  // eslint-disable-next-line prefer-const
  let childRuns: ChildRuns;
  const real = createExecutor({
    db,
    masterKey: KEY,
    resolveDoc,
    adapters: createConnectorRegistry({ supervisor: noopSupervisor }),
    childRuns: {
      ensure: (c, p) => childRuns.ensure(c, p),
      kick: (r) => childRuns.kick(r),
      result: (id) => childRuns.result(id),
    },
  });
  const executor: Executor = {
    perform: (command: ExecutorCommand, runId: string) =>
      command.type === 'startChild' ? real.perform(command, runId) : stub.perform(command, runId),
  };
  const deps = { db, resolveDoc, executor, alarms: refuseToArm, drives, bus };
  childRuns = createChildRuns(deps);
  const unsubscribe = subscribeChildReturns({ ...deps, bus, childRuns });
  return { ...deps, childRuns, unsubscribe, stub };
}

/** Let the reactor's `queueMicrotask` + the kicked child's drive settle. */
async function settle(drives: ReturnType<typeof createRunDrives>): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
    await drives.whenIdle();
    if (drives.idle()) return;
  }
}

describe('#796 — a call node runs a REAL child', () => {
  it('spawns the child, announces it, and folds its outputs when it finishes', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work', [{ name: 'answer', type: 'number' }])]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const run = seedRun(db, parentPv);
    const b = boundary(db, { work: { answer: 42 } });

    // The parent's own drive returns with the call node WAITING — the child is
    // in flight, not awaited. That is the whole design (see `child.ts`).
    // Through the drive LOCK, as the launcher does — otherwise the reactor's
    // own `driveRun` can interleave with the parent's first pump.
    const state = await b.drives.serialize(run.id, () => startRun(b, run));
    expect(state.nodes.caller!.status).toBe('waiting');
    // The announcement precedes the result, always: the child row exists before
    // `call.started` is appended, and the result cannot be folded before it.
    const early = types(db, run.id);
    expect(early.slice(0, 2)).toEqual(['run.started', 'call.started']);

    await settle(b.drives);

    // The child ran as a real run, linked to its parent.
    const children = listRuns(db, { parentRunId: run.id });
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child.status).toBe('success');
    expect(child.ownerId).toBe('local');
    expect(child.triggerId).toBeNull();

    // Its id IS the reducer's deterministic childRunId — that identity is what
    // makes the spawn idempotent, and the reducer re-derives it to accept the
    // result.
    const announced = loadEngineEvents(db, run.id).find((e) => e.type === 'call.started');
    expect(announced).toMatchObject({ callNodeId: 'caller', childRunId: child.id });

    // …and the parent finished, folding the child's outputs under the call node.
    expect(types(db, run.id)).toEqual([
      'run.started',
      'call.started',
      'call.returned',
      'run.finished',
    ]);
    const returned = loadEngineEvents(db, run.id).find((e) => e.type === 'call.returned');
    expect(returned).toMatchObject({ childOutcome: 'success', outputs: { answer: 42 } });
    expect(getRun(db, run.id)!.status).toBe('success');
    b.unsubscribe();
  });

  it('a FAILING child fails the parent and still hands back what it produced', async () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const run = seedRun(db, parentPv);
    // An EXPLICIT failure plan. An unplanned node would also end the child
    // `failure`, but for an unrelated reason — the stub defaults to SUCCESS with
    // `{}` outputs, which the fold then rejects against `http_request`'s declared
    // `status`/`body`/`headers` contract. Saying "the stub fails it" would have
    // been a comment describing a mechanism that is not the one running.
    const b = boundary(db, {}, { work: { outcome: 'failure', error: 'boom' } });

    await startRun(b, run);
    await settle(b.drives);

    const returned = loadEngineEvents(db, run.id).find((e) => e.type === 'call.returned');
    expect(returned).toMatchObject({ childOutcome: 'failure' });
    expect(getRun(db, run.id)!.status).toBe('failure');
    b.unsubscribe();
  });

  it('RESUMES an adopted child whose log is already seeded (crash mid-child)', async () => {
    // The path a fresh spawn never exercises, and the one that deadlocked before
    // it had a test: `kick` on a child that has a log but no terminal event.
    // `startRun` refuses a non-empty log, so this must go through `driveRun` —
    // which takes the child's OWN drive lock, and `drives.serialize` is a
    // non-reentrant `pLimit(1)`, so kicking from inside the lock hangs forever.
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work', [{ name: 'answer', type: 'number' }])]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const run = seedRun(db, parentPv);

    // Crash the child mid-dispatch: the stub emits `node.dispatched` and no
    // terminal, so the child comes to rest `running` with a seeded log.
    const crashing = boundary(db, {}, { work: { hang: true } });
    await crashing.drives.serialize(run.id, () => startRun(crashing, run));
    await settle(crashing.drives);
    const child = listRuns(db, { parentRunId: run.id })[0]!;
    expect(loadEngineEvents(db, child.id).length).toBeGreaterThan(0);
    expect(child.status).toBe('running');
    crashing.unsubscribe();

    // Restart: a boundary that CAN complete the leaf re-kicks the same child.
    const b = boundary(db, { work: { answer: 7 } });
    await Promise.race([
      (async () => {
        b.childRuns.kick(child);
        await settle(b.drives);
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('kick deadlocked')), 4000)),
    ]);

    // The property under test is that the kick SETTLES rather than hanging (the
    // race above is the assertion) and spawns no twin. It deliberately does NOT
    // assert the child completed: recovering a node crashed mid-dispatch is the
    // BOOT RECONCILER's job, not a plain re-drive's, and `driveRun` correctly
    // leaves an in-flight `dispatched` node alone.
    expect(listRuns(db, { parentRunId: run.id })).toHaveLength(1);
    b.unsubscribe();
  });

  it('ADOPTS an existing child on a re-emitted startChild — never a second run', async () => {
    // The crash-replay path: boot reconcile re-emits `startChild` for a
    // `waiting` call node. The deterministic id must find the child that
    // already exists rather than spawn a twin.
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work', [{ name: 'answer', type: 'number' }])]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const run = seedRun(db, parentPv);
    const b = boundary(db, { work: { answer: 1 } });

    await startRun(b, run);
    await settle(b.drives);
    const first = listRuns(db, { parentRunId: run.id });
    expect(first).toHaveLength(1);

    // Re-issue the SAME command the reducer would re-emit after a restart.
    const command = {
      type: 'startChild' as const,
      callNodeId: 'caller',
      attemptId: 'caller#0',
      childRunId: first[0]!.id,
      pipelineVersionId: childPv,
      params: {},
    };
    const again = b.childRuns.ensure(command, run.id);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.run.id).toBe(first[0]!.id);
    expect(again.terminal).toBe(true); // already finished → resolve, don't re-kick
    expect(again.announced).toBe(true); // already announced → don't double-announce
    expect(listRuns(db, { parentRunId: run.id })).toHaveLength(1);
    b.unsubscribe();
  });
});

describe('#796 — the spawn seam REFUSES rather than throwing', () => {
  let probe = 0;
  function ensureAgainst(db: Db, pvId: string, parentRunId: string) {
    const b = boundary(db);
    probe += 1;
    const out = b.childRuns.ensure(
      {
        type: 'startChild',
        callNodeId: 'caller',
        attemptId: 'caller#0',
        // A DISTINCT id per probe: `ensure` adopts an existing child before it
        // re-checks anything, so a shared id would make the second probe a
        // no-op adoption and silently pass whatever it meant to refuse.
        childRunId: `child_probe${probe}`,
        pipelineVersionId: pvId,
        params: {},
      },
      parentRunId,
    );
    b.unsubscribe();
    return out;
  }

  it('refuses a child pipeline owned by ANOTHER owner', () => {
    // `validateCallGraph` resolves callees through an owner-scoped resolver and
    // SKIPS one it cannot see, so a cross-owner target passes save-time checks.
    const { db } = freshDb();
    const foreignPv = seedVersion(db, [leaf('work')], 'someone-else');
    const parentPv = seedVersion(db, [callNode('caller', foreignPv)]);
    const run = seedRun(db, parentPv);
    const out = ensureAgainst(db, foreignPv, run.id);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/different owner/);
    expect(listRuns(db, { parentRunId: run.id })).toHaveLength(0);
  });

  it('refuses an ARCHIVED child pipeline (the dispatch guard `fire()` applies)', () => {
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    const run = seedRun(db, parentPv);
    archivePipelineRow(db, getPipelineVersion(db, childPv)!.pipelineId);
    const out = ensureAgainst(db, childPv, run.id);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/archived/);
  });

  it('refuses an UNRESOLVABLE child version (A9/#516) instead of throwing', () => {
    const { db } = freshDb();
    const parentPv = seedVersion(db, [leaf('a')]);
    const run = seedRun(db, parentPv);
    const out = ensureAgainst(db, 'pv_gone', run.id);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toMatch(/cannot be resolved/);
  });

  it('refuses past MAX_CALL_DEPTH hops, counted over the parentRunId chain', () => {
    // The save-time DFS follows LITERAL targets only, so a `${}` target reaches
    // this seam unbounded (#1011). Build a chain of ancestor rows by hand and
    // check the boundary exactly: MAX_CALL_DEPTH hops are legal, one more is not.
    const { db } = freshDb();
    const childPv = seedVersion(db, [leaf('work')]);
    const parentPv = seedVersion(db, [callNode('caller', childPv)]);
    let ancestorId: string | null = null;
    const chain: string[] = [];
    for (let i = 0; i <= MAX_CALL_DEPTH; i += 1) {
      const r: { id: string } = createRun(db, {
        ownerId: 'local',
        pipelineVersionId: parentPv,
        triggerId: null,
        parentRunId: ancestorId,
        params: {},
      });
      chain.push(r.id);
      ancestorId = r.id;
    }
    // chain[MAX_CALL_DEPTH - 1] is at MAX_CALL_DEPTH - 1 hops: its child is the
    // MAX_CALL_DEPTH-th hop and is allowed.
    expect(ensureAgainst(db, childPv, chain[MAX_CALL_DEPTH - 1]!).ok).toBe(true);
    // chain[MAX_CALL_DEPTH] is at MAX_CALL_DEPTH hops: its child would be one too many.
    const tooDeep = ensureAgainst(db, childPv, chain[MAX_CALL_DEPTH]!);
    expect(tooDeep.ok).toBe(false);
    expect(tooDeep.ok === false && tooDeep.reason).toMatch(/depth/);
  });
});

function types(db: Db, runId: string): string[] {
  return loadEngineEvents(db, runId).map((e) => e.type);
}
