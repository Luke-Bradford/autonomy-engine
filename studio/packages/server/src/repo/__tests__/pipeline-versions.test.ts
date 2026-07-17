import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  PipelineVersionSchema,
  type NewPipelineVersion,
  type Node,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { openDb } from '../../db/client.js';
import { pipelineVersions } from '../../db/schema.js';
import {
  InvalidPipelineDocError,
  createPipelineVersion,
  getLatestPipelineVersion,
  getPipelineVersion,
  listPipelineVersions,
} from '../pipeline-versions.js';
import * as pipelineVersionsRepo from '../pipeline-versions.js';
import { createPipeline } from '../pipelines.js';
import { freshDb } from './helpers.js';

/**
 * A valid `loop` child + its exit condition, for the #473 container-persistence
 * fixtures. A loop must have at least one child and an `exitWhen` that reads a
 * CHILD's output (never a constant) — see `validate-doc.test.ts`, which owns
 * those rules. The write path enforces them as of #444.
 */
const LOOP_CHILD_NODE: Node = {
  id: 'node_2',
  type: 'llm_call',
  config: { outputs: [{ name: 'done', type: 'boolean' }] },
  position: { x: 0, y: 0 },
};
const CHILD_EXIT_WHEN = '${nodes.node_2.output.done}';

function buildVersionInput(pipelineId: string): NewPipelineVersion {
  return {
    pipelineId,
    params: [{ name: 'topic', type: 'string', required: true }],
    outputs: [{ name: 'summary', type: 'string' }],
    nodes: [{ id: 'node_1', type: 'llm_call', config: {}, position: { x: 0, y: 0 } }],
    edges: [],
    catalogVersion: CATALOG_VERSION,
  };
}

describe('pipeline-versions repo — the write gate (#444)', () => {
  it('REFUSES a forward cycle (the #491 doc) — nothing is written', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const input: NewPipelineVersion = {
      ...buildVersionInput(pipeline.id),
      params: [],
      nodes: [
        { id: 'a', type: 'agent_task', config: {}, position: { x: 0, y: 0 } },
        { id: 'b', type: 'agent_task', config: {}, position: { x: 0, y: 0 } },
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'b', on: 'success' },
        { id: 'e2', from: 'b', to: 'a', on: 'success' },
      ],
    };

    expect(() => createPipelineVersion(db, input)).toThrow(InvalidPipelineDocError);
    // The refusal is a REFUSAL, not a partial write: a version row would be
    // immutable (DB triggers RAISE(ABORT) on update), so a doc that lands here
    // could never be repaired, only re-authored.
    expect(listPipelineVersions(db, pipeline.id)).toEqual([]);
  });

  it("REFUSES a container's ghost child (the #487 doc)", () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    expect(() =>
      createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        containers: [{ id: 'c1', kind: 'stage', children: ['ghost'], join: 'all' }],
      }),
    ).toThrow(InvalidPipelineDocError);
  });

  it('REFUSES an undeclared `${params.x}` ref (validateRefs is wired, not just validateDoc)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    expect(() =>
      createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        params: [],
        nodes: [
          {
            id: 'node_1',
            type: 'llm_call',
            config: { prompt: '${params.nope}' },
            position: { x: 0, y: 0 },
          },
        ],
      }),
    ).toThrow(InvalidPipelineDocError);
  });

  // #547 (F1) — a json param DEFAULT carrying a non-finite is refused on write.
  // resolveRunParams applies the default and coerce passes a json value through
  // untouched, so an Infinity default would reach run.started and JSON.stringify
  // to null; the immutable version could never be repaired, only re-authored.
  it('REFUSES a non-finite json param default (#547 F1)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    expect(() =>
      createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        params: [{ name: 'cfg', type: 'json', required: false, default: { x: Infinity } }],
      }),
    ).toThrow(InvalidPipelineDocError);
    expect(listPipelineVersions(db, pipeline.id)).toEqual([]);
    // A finite default is fine.
    expect(() =>
      createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        params: [{ name: 'cfg', type: 'json', required: false, default: { x: 1e308 } }],
      }),
    ).not.toThrow();
  });

  it('carries EVERY issue on the error, not just the first', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    let caught: InvalidPipelineDocError | undefined;
    try {
      createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        params: [],
        nodes: [
          {
            id: 'node_1',
            type: 'llm_call',
            config: { prompt: '${params.nope}' },
            position: { x: 0, y: 0 },
          },
        ],
        containers: [{ id: 'c1', kind: 'stage', children: ['ghost'], join: 'all' }],
      });
    } catch (err) {
      caught = err as InvalidPipelineDocError;
    }
    expect(caught).toBeInstanceOf(InvalidPipelineDocError);
    // One from each validator — proves the guard reports the whole doc's
    // problems in one round-trip rather than making the author play whack-a-mole.
    expect(caught?.issues).toEqual(
      expect.arrayContaining([
        "container 'c1': child 'ghost' is not a node in this pipeline",
        'nodes.node_1.config.prompt: ${params.nope} is not a declared param',
      ]),
    );
  });

  it('ACCEPTS a valid doc — the gate refuses invalid docs, not all docs', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    expect(() => createPipelineVersion(db, buildVersionInput(pipeline.id))).not.toThrow();
    expect(listPipelineVersions(db, pipeline.id)).toHaveLength(1);
  });
});

describe('pipeline-versions repo — the write gate call-graph (#495)', () => {
  // A version whose single node CALLS another version. Built leaf-first so each
  // callee already exists when its caller is authored — the only way a call
  // chain can exist given immutable, server-minted version ids (you cannot
  // forward-reference an unminted id).
  function callVersionInput(pipelineId: string, calleeVersionId: string): NewPipelineVersion {
    return {
      pipelineId,
      params: [],
      outputs: [],
      nodes: [
        {
          id: 'caller',
          type: 'call_pipeline',
          config: {},
          position: { x: 0, y: 0 },
          call: { pipelineVersionId: calleeVersionId, params: {} },
        },
      ],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
  }
  function leafVersionInput(pipelineId: string): NewPipelineVersion {
    return {
      pipelineId,
      params: [],
      outputs: [],
      nodes: [{ id: 'leaf', type: 'agent_task', config: {}, position: { x: 0, y: 0 } }],
      edges: [],
      catalogVersion: CATALOG_VERSION,
    };
  }

  /** Build an owned call chain head→…→leaf of the given depth, leaf-first, all
   * under one pipeline. Returns the HEAD version (the one a further caller would
   * call). `linkDepth` = number of call hops from the head to the leaf. */
  function buildOwnedChain(
    db: ReturnType<typeof freshDb>['db'],
    ownerId: string,
    linkDepth: number,
  ) {
    const pipeline = createPipeline(db, { ownerId, name: `chain-${ownerId}` });
    let callee = createPipelineVersion(db, leafVersionInput(pipeline.id));
    for (let i = 0; i < linkDepth; i += 1) {
      callee = createPipelineVersion(db, callVersionInput(pipeline.id, callee.id));
    }
    return callee; // the head of the chain
  }

  it('REFUSES a call chain that exceeds maxCallDepth — nothing is written', () => {
    const { db } = freshDb();
    // head → vB → vC → leaf : head is 3 hops above the leaf. A new caller of
    // head makes new(0)→head(1)→vB(2)→vC(3)→leaf(4): entering leaf at depth 4 > 3.
    const head = buildOwnedChain(db, 'local', 3);
    const caller = createPipeline(db, { ownerId: 'local', name: 'caller' });

    expect(() => createPipelineVersion(db, callVersionInput(caller.id, head.id))).toThrow(
      InvalidPipelineDocError,
    );
    // A refusal is a refusal — no partial write (immutable rows can't be repaired).
    expect(listPipelineVersions(db, caller.id)).toEqual([]);
  });

  it('ACCEPTS a call chain within maxCallDepth', () => {
    const { db } = freshDb();
    // head → vB → leaf : new(0)→head(1)→vB(2)→leaf(3): deepest entry is depth 3,
    // which is allowed (the rule refuses depth > 3).
    const head = buildOwnedChain(db, 'local', 2);
    const caller = createPipeline(db, { ownerId: 'local', name: 'caller' });

    expect(() => createPipelineVersion(db, callVersionInput(caller.id, head.id))).not.toThrow();
    expect(listPipelineVersions(db, caller.id)).toHaveLength(1);
  });

  it('ACCEPTS a single owned call — the gate refuses over-depth, not all calls', () => {
    const { db } = freshDb();
    const leaf = buildOwnedChain(db, 'local', 0); // just the leaf
    const caller = createPipeline(db, { ownerId: 'local', name: 'caller' });
    expect(() => createPipelineVersion(db, callVersionInput(caller.id, leaf.id))).not.toThrow();
  });

  it('does NOT traverse — nor echo the ids of — ANOTHER owner’s versions (owner-scoped resolver)', () => {
    const { db } = freshDb();
    // An OVER-DEPTH chain owned by someone else. A non-owner-scoped resolver
    // WOULD walk into it and 400 the caller, echoing the other owner's version
    // ids in the error body — the exact leak #444's echo-safety argument did not
    // cover across the transitive graph.
    const otherHead = buildOwnedChain(db, 'other', 3);
    const caller = createPipeline(db, { ownerId: 'local', name: 'caller' });

    let caught: InvalidPipelineDocError | undefined;
    try {
      createPipelineVersion(db, callVersionInput(caller.id, otherHead.id));
    } catch (err) {
      caught = err as InvalidPipelineDocError;
    }
    // The resolver returns undefined for a cross-owner callee, so the call graph
    // is not analysed past the boundary: no depth error is raised at all.
    expect(caught).toBeUndefined();
    expect(listPipelineVersions(db, caller.id)).toHaveLength(1);
  });
});

describe('InvalidPipelineDocError message (#496)', () => {
  it('keeps every issue on `.issues` but bounds the human message', () => {
    const issues = Array.from({ length: 150 }, (_v, i) => `issue ${i}`);
    const err = new InvalidPipelineDocError(issues);
    // The structured list is COMPLETE — the cap lives at the HTTP boundary
    // (errors.ts), never on the error object itself.
    expect(err.issues).toHaveLength(150);
    // The message names the total + the remainder, and drops the tail rather
    // than joining an O(doc) string.
    expect(err.message).toContain('150 issues');
    expect(err.message).toContain('…and 50 more');
    expect(err.message).not.toContain('issue 149');
  });

  it('joins a small list whole, with no "…and N more" suffix', () => {
    const err = new InvalidPipelineDocError(['a', 'b']);
    expect(err.message).toContain('a; b');
    expect(err.message).not.toContain('more');
  });
});

describe('pipeline-versions repo', () => {
  it('creates version 1 for a brand-new pipeline', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    expect(v1.version).toBe(1);
    expect(v1.pipelineId).toBe(pipeline.id);
    expect(getPipelineVersion(db, v1.id)).toEqual(v1);
  });

  it('auto-increments version per pipelineId on successive creates', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    const v2 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    const v3 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    expect([v1.version, v2.version, v3.version]).toEqual([1, 2, 3]);
  });

  it('numbers versions independently per pipeline', () => {
    const { db } = freshDb();
    const pipelineA = createPipeline(db, { ownerId: 'local', name: 'A' });
    const pipelineB = createPipeline(db, { ownerId: 'local', name: 'B' });
    createPipelineVersion(db, buildVersionInput(pipelineA.id));
    const bV1 = createPipelineVersion(db, buildVersionInput(pipelineB.id));
    expect(bV1.version).toBe(1);
  });

  it('lists versions oldest-first and getLatestPipelineVersion returns the newest', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const v1 = createPipelineVersion(db, buildVersionInput(pipeline.id));
    const v2 = createPipelineVersion(db, buildVersionInput(pipeline.id));

    expect(listPipelineVersions(db, pipeline.id).map((v) => v.id)).toEqual([v1.id, v2.id]);
    expect(getLatestPipelineVersion(db, pipeline.id)).toEqual(v2);
  });

  // #473 — the DATA-LOSS regression (full rationale in the 0006 migration).
  //
  // Note WHY the existing suite never caught this. It is not that these tests
  // assert on `createPipelineVersion`'s return value — 'creates version 1'
  // above genuinely re-reads via `getPipelineVersion`. It is that the shared
  // fixture has NO containers, so the assertion compared `[]` to `[]` and the
  // bug had nothing to destroy. A re-read only proves persistence if the thing
  // under test is actually PRESENT in the fixture.
  it('PERSISTS containers — a container survives the round-trip to storage (#473)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const containers = [
      { id: 'c1', kind: 'stage' as const, children: ['node_1'], join: 'all' as const },
      {
        id: 'c2',
        kind: 'loop' as const,
        children: ['node_2'],
        maxRounds: 3,
        exitWhen: CHILD_EXIT_WHEN,
      },
    ];

    // `node_2` + a child-output `exitWhen` are what make `c2` a VALID loop, now
    // that the write path enforces the doc rules (#444). The invalidity was
    // always incidental to what this test proves (containers reach storage) —
    // it was only ever reachable because nothing validated. Persistence is
    // still asserted on the FULL two-container shape, unweakened.
    const created = createPipelineVersion(db, {
      ...buildVersionInput(pipeline.id),
      nodes: [...buildVersionInput(pipeline.id).nodes, LOOP_CHILD_NODE],
      containers,
    });

    // The create RESPONSE is built from the in-memory input, so it looked
    // correct even while the write dropped the field — assert the RE-READ.
    expect(getPipelineVersion(db, created.id)?.containers).toEqual(containers);
    expect(listPipelineVersions(db, pipeline.id)[0]?.containers).toEqual(containers);
    expect(getLatestPipelineVersion(db, pipeline.id)?.containers).toEqual(containers);
  });

  it('PERSISTS containers across a real reopen — the user-visible #473 path', () => {
    // The bug's actual symptom was "author a stage, reload the page, it's
    // gone", so this is deliberately NOT run against `:memory:`: a real file,
    // genuinely CLOSED, genuinely re-opened. Same idiom (and same reason) as
    // the S1 restart test in `scheduled-wakeups.test.ts`. The in-memory case
    // above already catches the dropped INSERT; this one proves the fix is
    // DURABLE rather than an artefact of a single connection's session.
    const dir = mkdtempSync(join(tmpdir(), 'studio-473-'));
    const file = join(dir, 'containers.db');
    const containers = [{ id: 'c1', kind: 'stage' as const, children: ['node_1'] }];
    try {
      const first = openDb(file);
      const pipeline = createPipeline(first.db, { ownerId: 'local', name: 'P' });
      const created = createPipelineVersion(first.db, {
        ...buildVersionInput(pipeline.id),
        containers,
      });
      first.sqlite.close(); // the reload

      const reopened = openDb(file);
      try {
        expect(getPipelineVersion(reopened.db, created.id)?.containers).toEqual(containers);
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #485 — loss point 1 as a CLASS guard, not a snapshot. #473 proved a single
  // field (`containers`) survives create -> re-read; but a field added to
  // `PipelineVersionSchema` later slips past a one-field test. This authors
  // EVERY persistable field with a value that DIFFERS from its schema default
  // (a defaulted field dropped -> default reads back equal and proves nothing —
  // the exact trap the pre-#473 fixture fell into, see the note on the
  // containers test above), asserts the fixture COVERS every non-server key
  // (so a new schema field fails here until this test is extended), then
  // asserts the RE-READ — never the in-memory create response — deep-equals
  // the authored value for every one of those keys.
  //
  // This guards the PERSIST/serialization path (loss point 1); the two
  // hand-written builders (loss point 2) are guarded per-class in
  // `portability/__tests__/import.test.ts` and `web`'s `canvasDoc.test.ts`.
  it('PERSISTS every field — a class round-trip over the whole PipelineVersion (#485)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });

    const authored: NewPipelineVersion = {
      pipelineId: pipeline.id,
      params: [{ name: 'topic', type: 'string', required: true }],
      outputs: [{ name: 'summary', type: 'string' }],
      // Each known-type node declares an EXPLICIT `config.outputs` so F13b
      // lowering (#456) is a no-op here — this test guards the persist/round-trip
      // path (loss point 1), not the catalog-default seeding, so an author
      // override keeps the two concerns decoupled and the round-trip exact.
      nodes: [
        {
          id: 'node_1',
          type: 'llm_call',
          config: { model: 'x', outputs: [{ name: 'text', type: 'string' }] },
          position: { x: 3, y: 4 },
        },
        {
          id: 'node_3',
          type: 'agent_task',
          config: { outputs: [{ name: 'output', type: 'string' }] },
          position: { x: 5, y: 6 },
        },
        LOOP_CHILD_NODE,
      ],
      // A top-level edge (neither endpoint is a container child) so the doc is
      // valid — an edge crossing a container boundary is refused by the gate.
      edges: [{ id: 'e1', from: 'node_1', to: 'node_3', on: 'success' }],
      // Non-empty AND non-default: a dropped `containers` would default to `[]`
      // and read back equal, masking the loss.
      containers: [
        { id: 'c1', kind: 'loop', children: ['node_2'], maxRounds: 3, exitWhen: CHILD_EXIT_WHEN },
      ],
      // Deliberately NOT CATALOG_VERSION — a dropped `catalogVersion` defaults to
      // the current one, so an equal read-back would prove nothing. The write
      // gate does not constrain this value (no catalog refs in `validatePipelineDoc`).
      catalogVersion: CATALOG_VERSION - 1,
    };

    // CLASS assertion: the fixture must populate every field the schema expects
    // to persist. A field added to `PipelineVersionSchema` with no fixture value
    // fails HERE, forcing this test to be extended rather than silently
    // under-covering — the same class-guard shape as `schema-table-parity`.
    const SERVER_ASSIGNED = ['id', 'version', 'createdAt'];
    const persistable = Object.keys(PipelineVersionSchema.shape).filter(
      (key) => !SERVER_ASSIGNED.includes(key),
    );
    expect(persistable.filter((key) => !(key in authored))).toEqual([]);

    const created = createPipelineVersion(db, authored);
    const reread = getPipelineVersion(db, created.id);
    expect(reread).not.toBeNull();

    // Assert on the RE-READ, never the create response — the response is built
    // from the in-memory input (`{ id, ...parsed }`), so it looks correct even
    // while a write drops the field (#473's headline lesson).
    for (const key of persistable) {
      expect(reread![key as keyof PipelineVersion]).toEqual(
        authored[key as keyof NewPipelineVersion],
      );
    }
  });

  // #456 (F13b) — the catalog default is LOWERED into a node's `config.outputs`
  // at save time, so a version stored via the API/import/CLI carries the same
  // contract the web palette seeds client-side. Before F13b a known-type node
  // created by any non-web client persisted `absent` (no contract), and the
  // reducer stored the whole payload while `validateRefs` name-checked nothing.
  describe('#456 (F13b) — catalog-default lowering', () => {
    it('SEEDS an absent config.outputs from the catalog for a known type (persisted)', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const created = createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        nodes: [
          { id: 'h', type: 'http_request', config: { url: 'https://x' }, position: { x: 0, y: 0 } },
        ],
      });
      // The RE-READ carries the catalog contract, not just the create response.
      const node = getPipelineVersion(db, created.id)!.nodes.find((n) => n.id === 'h')!;
      expect(node.config['outputs']).toEqual([
        { name: 'status', type: 'number' },
        { name: 'body', type: 'string' },
        { name: 'headers', type: 'json' },
      ]);
      // The rest of the config is untouched.
      expect(node.config['url']).toBe('https://x');
    });

    it('RESPECTS an author-declared config.outputs — the override is never overwritten', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      const declared = [{ name: 'only', type: 'string' }];
      const created = createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        nodes: [
          {
            id: 'h',
            type: 'http_request',
            config: { url: 'https://x', outputs: declared },
            position: { x: 0, y: 0 },
          },
        ],
      });
      const node = getPipelineVersion(db, created.id)!.nodes.find((n) => n.id === 'h')!;
      expect(node.config['outputs']).toEqual(declared);
    });

    it('leaves an uncatalogued type absent — no catalog default to seed', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      // `set_variable` is not in the MVP catalog, so it has no default contract.
      const created = createPipelineVersion(db, {
        ...buildVersionInput(pipeline.id),
        nodes: [{ id: 'u', type: 'set_variable', config: {}, position: { x: 0, y: 0 } }],
      });
      const node = getPipelineVersion(db, created.id)!.nodes.find((n) => n.id === 'u')!;
      expect(node.config['outputs']).toBeUndefined();
    });

    it('ACCEPTS a ${nodes.X.output.<catalogName>} ref against the seeded contract', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      // `status` is one of http_request's catalog outputs — the ref resolves
      // against the LOWERED contract even though the producer declared none.
      expect(() =>
        createPipelineVersion(db, {
          ...buildVersionInput(pipeline.id),
          params: [],
          nodes: [
            {
              id: 'p',
              type: 'http_request',
              config: { url: 'https://x' },
              position: { x: 0, y: 0 },
            },
            {
              id: 'c',
              type: 'llm_call',
              config: { prompt: '${nodes.p.output.status}' },
              position: { x: 1, y: 0 },
            },
          ],
          edges: [{ id: 'e', from: 'p', to: 'c', on: 'success' }],
        }),
      ).not.toThrow();
    });

    it('REFUSES a ${nodes.X.output.<bogus>} ref now that the producer carries a contract (API/web alignment)', () => {
      const { db } = freshDb();
      const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
      // Before F13b this SAVED: the API-created producer had no contract, so
      // validateRefs name-checked nothing. After F13b the producer carries its
      // catalog contract, so a ref to an undeclared name is refused on write —
      // the same verdict the web palette path always gave.
      expect(() =>
        createPipelineVersion(db, {
          ...buildVersionInput(pipeline.id),
          params: [],
          nodes: [
            {
              id: 'p',
              type: 'http_request',
              config: { url: 'https://x' },
              position: { x: 0, y: 0 },
            },
            {
              id: 'c',
              type: 'llm_call',
              config: { prompt: '${nodes.p.output.bogus}' },
              position: { x: 1, y: 0 },
            },
          ],
          edges: [{ id: 'e', from: 'p', to: 'c', on: 'success' }],
        }),
      ).toThrow(InvalidPipelineDocError);
    });
  });

  it('has no update path — the module exports no updatePipelineVersion (immutability invariant)', () => {
    expect(
      (pipelineVersionsRepo as unknown as Record<string, unknown>)['updatePipelineVersion'],
    ).toBeUndefined();
  });

  it('rejects creating a version for a nonexistent pipeline (FK enforced)', () => {
    const { db } = freshDb();
    expect(() => createPipelineVersion(db, buildVersionInput('pipe_does_not_exist'))).toThrow();
  });

  it('rejects a duplicate (pipelineId, version) pair at the DB layer (unique index enforced)', () => {
    const { db } = freshDb();
    const pipeline = createPipeline(db, { ownerId: 'local', name: 'P' });
    const input = buildVersionInput(pipeline.id);

    const row = {
      id: 'pv_dup_1',
      ...input,
      // `containers` is optional in `NewPipelineVersion` (`z.input`, via the
      // write-side `.default([])`) but NOT NULL on the table, so a raw insert
      // must name it — the repo path gets it from Zod's default instead.
      containers: input.containers ?? [],
      catalogVersion: input.catalogVersion ?? CATALOG_VERSION,
      version: 1,
      createdAt: Date.now(),
    };
    db.insert(pipelineVersions).values(row).run();

    expect(() =>
      db
        .insert(pipelineVersions)
        .values({ ...row, id: 'pv_dup_2' })
        .run(),
    ).toThrow();
  });
});
