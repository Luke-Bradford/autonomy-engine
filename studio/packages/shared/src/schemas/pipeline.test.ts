import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION } from './version.js';
import {
  CallConfigSchema,
  ContainerSchema,
  EdgeOnSchema,
  EdgeSchema,
  NewPipelineSchema,
  NewPipelineVersionSchema,
  NodePolicySchema,
  NodeSchema,
  OutputSchema,
  OutputTypeSchema,
  ParamSchema,
  ParamTypeSchema,
  PipelineSchema,
  PipelineVersionSchema,
  PositionSchema,
} from './pipeline.js';

describe('ParamTypeSchema', () => {
  it.each(['string', 'number', 'boolean', 'json', 'secret'])('accepts %s', (t) => {
    expect(ParamTypeSchema.parse(t)).toBe(t);
  });

  it('rejects an unknown type', () => {
    expect(() => ParamTypeSchema.parse('date')).toThrow();
  });
});

describe('ParamSchema', () => {
  it('round-trips a required param with no default', () => {
    const param = { name: 'topic', type: 'string', required: true };
    expect(ParamSchema.parse(param)).toEqual(param);
  });

  it('round-trips an optional param with a default', () => {
    const param = { name: 'retries', type: 'number', required: false, default: 3 };
    expect(ParamSchema.parse(param)).toEqual(param);
  });

  it('rejects an empty name', () => {
    expect(() => ParamSchema.parse({ name: '', type: 'string', required: true })).toThrow();
  });
});

describe('OutputTypeSchema', () => {
  it.each(['string', 'number', 'boolean', 'json'])('accepts %s', (t) => {
    expect(OutputTypeSchema.parse(t)).toBe(t);
  });

  it('rejects secret (an output is never secret-typed — no leak channel)', () => {
    expect(() => OutputTypeSchema.parse('secret')).toThrow();
  });
});

describe('OutputSchema', () => {
  it('round-trips a valid output', () => {
    const output = { name: 'summary', type: 'string' };
    expect(OutputSchema.parse(output)).toEqual(output);
  });

  it.each(['number', 'boolean', 'json'])('round-trips a %s-typed output', (type) => {
    const output = { name: 'x', type };
    expect(OutputSchema.parse(output)).toEqual(output);
  });

  it('rejects a secret-typed output (outputs are never stripped downstream)', () => {
    expect(() => OutputSchema.parse({ name: 'summary', type: 'secret' })).toThrow();
  });
});

describe('PositionSchema', () => {
  it('round-trips x/y', () => {
    expect(PositionSchema.parse({ x: 10, y: -5.5 })).toEqual({ x: 10, y: -5.5 });
  });

  it('rejects a non-numeric coordinate', () => {
    expect(() => PositionSchema.parse({ x: '10', y: 0 })).toThrow();
  });
});

describe('NodeSchema', () => {
  const node = {
    id: 'node_1',
    type: 'llm_call',
    config: { prompt: 'hi' },
    connectionId: 'conn_1',
    position: { x: 0, y: 0 },
  };

  it('round-trips a node with a connectionId', () => {
    expect(NodeSchema.parse(node)).toEqual(node);
  });

  it('accepts a node without a connectionId', () => {
    const { connectionId, ...rest } = node;
    void connectionId;
    expect(NodeSchema.parse(rest)).toEqual(rest);
  });

  it('rejects a missing position', () => {
    const { position, ...rest } = node;
    void position;
    expect(() => NodeSchema.parse(rest)).toThrow();
  });

  // #2 L13b — per-dispatch connection-parameter bindings.
  it('round-trips connectionParams (values stay untyped: literals or ${} strings)', () => {
    const value = {
      ...node,
      connectionParams: { model: '${params.model}', maxTokens: 1024, flags: { beta: true } },
    };
    expect(NodeSchema.parse(value)).toEqual(value);
  });

  it('rejects a non-record connectionParams', () => {
    expect(() => NodeSchema.parse({ ...node, connectionParams: ['model'] })).toThrow();
  });
});

describe('EdgeOnSchema', () => {
  it.each(['success', 'failure', 'completion', 'skipped'])('accepts %s', (on) => {
    expect(EdgeOnSchema.parse(on)).toBe(on);
  });

  it('rejects an unknown edge condition', () => {
    expect(() => EdgeOnSchema.parse('retry')).toThrow();
  });

  // `EdgeOnSchema` is the OPERATIONAL set only. Business routing (`branch`) is a
  // separate member of the `EdgeSchema` union and must never leak in here — the
  // canvas renders this enum as its condition dropdown, and an operational
  // outcome is not a business branch (spec #1 D5 / #4 A0).
  it('rejects branch — business routing is not an operational outcome', () => {
    expect(() => EdgeOnSchema.parse('branch')).toThrow();
  });

  it('is exactly the four operational outcomes', () => {
    expect(EdgeOnSchema.options).toEqual(['success', 'failure', 'completion', 'skipped']);
  });
});

describe('EdgeSchema', () => {
  it('round-trips a plain forward edge', () => {
    const edge = { id: 'e1', from: 'node_1', to: 'node_2', on: 'success' };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('round-trips a back-edge with a bounce cap', () => {
    const edge = {
      id: 'e2',
      from: 'node_2',
      to: 'node_1',
      on: 'completion',
      back: true,
      maxBounces: 5,
    };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('rejects a negative maxBounces', () => {
    expect(() =>
      EdgeSchema.parse({ id: 'e1', from: 'a', to: 'b', on: 'success', maxBounces: -1 }),
    ).toThrow();
  });

  it('round-trips an operational skipped edge', () => {
    const edge = { id: 'e3', from: 'a', to: 'handler', on: 'skipped' };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  // --- the business `branch` member (#1 owns the union, T3; #4 A0 implements
  // `if`/`switch` against it) -----------------------------------------------

  it('round-trips a business branch edge carrying its label', () => {
    const edge = { id: 'e4', from: 'if_1', to: 'node_2', on: 'branch', branch: 'true' };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('rejects a branch edge with no label — the label IS the routing key', () => {
    expect(() => EdgeSchema.parse({ id: 'e4', from: 'if_1', to: 'n', on: 'branch' })).toThrow();
  });

  it('rejects an empty branch label', () => {
    expect(() =>
      EdgeSchema.parse({ id: 'e4', from: 'if_1', to: 'n', on: 'branch', branch: '' }),
    ).toThrow();
  });

  // Round-3 fold: "A business `branch` edge MAY also carry a bounce-cap
  // `back:true`" — a 3-way switch can loop on one arm (approval needs-changes →
  // redraft), so the loop machinery must compose with branch routing.
  it('round-trips a branch edge that is also a capped back-edge', () => {
    const edge = {
      id: 'e5',
      from: 'switch_1',
      to: 'redraft',
      on: 'branch',
      branch: 'needs-changes',
      back: true,
      maxBounces: 3,
    };
    expect(EdgeSchema.parse(edge)).toEqual(edge);
  });

  it('rejects an unknown discriminant', () => {
    expect(() => EdgeSchema.parse({ id: 'e1', from: 'a', to: 'b', on: 'retry' })).toThrow();
  });

  // A `branch` label is meaningless on an operational edge; the union strips it
  // rather than carrying a field the reducer would never read.
  it('strips a stray branch label from an operational edge', () => {
    expect(EdgeSchema.parse({ id: 'e1', from: 'a', to: 'b', on: 'success', branch: 'x' })).toEqual({
      id: 'e1',
      from: 'a',
      to: 'b',
      on: 'success',
    });
  });
});

describe('ContainerSchema', () => {
  it('round-trips a stage container', () => {
    const c = { id: 'stg', kind: 'stage', children: ['a', 'b'] };
    expect(ContainerSchema.parse(c)).toEqual(c);
  });

  it('round-trips a loop container with exitWhen/maxRounds/join', () => {
    const c = {
      id: 'lp',
      kind: 'loop',
      children: ['w', 'check'],
      exitWhen: '${nodes.check.output.done}',
      maxRounds: 5,
      join: 'all',
    };
    expect(ContainerSchema.parse(c)).toEqual(c);
  });

  it('rejects an unknown kind', () => {
    expect(() => ContainerSchema.parse({ id: 'x', kind: 'fan', children: [] })).toThrow();
  });

  it('round-trips a loop container with a wall-clock timeout (#4 A17)', () => {
    const c = {
      id: 'lp',
      kind: 'loop',
      children: ['w', 'check'],
      exitWhen: '${nodes.check.output.done}',
      timeout: 3600,
    };
    expect(ContainerSchema.parse(c)).toEqual(c);
  });

  it('rejects a non-positive / non-integer timeout (#4 A17)', () => {
    const base = { id: 'lp', kind: 'loop', children: ['w'], exitWhen: '${x}' };
    expect(() => ContainerSchema.parse({ ...base, timeout: 0 })).toThrow();
    expect(() => ContainerSchema.parse({ ...base, timeout: -5 })).toThrow();
    expect(() => ContainerSchema.parse({ ...base, timeout: 1.5 })).toThrow();
  });

  it('rejects a non-positive maxRounds', () => {
    expect(() =>
      ContainerSchema.parse({ id: 'x', kind: 'loop', children: [], maxRounds: 0 }),
    ).toThrow();
  });
});

describe('CallConfigSchema', () => {
  it('round-trips an empty-params call', () => {
    const c = { pipelineVersionId: 'pv_2', params: {} };
    expect(CallConfigSchema.parse(c)).toEqual(c);
  });

  it('round-trips params + wait', () => {
    const c = { pipelineVersionId: '${params.child}', params: { topic: 'x' }, wait: true };
    expect(CallConfigSchema.parse(c)).toEqual(c);
  });

  it('requires params (no implicit default)', () => {
    expect(() => CallConfigSchema.parse({ pipelineVersionId: 'pv_2' })).toThrow();
  });
});

describe('NodeSchema call variant', () => {
  it('round-trips a call_pipeline node with a call config', () => {
    const n = {
      id: 'caller',
      type: 'call_pipeline',
      config: {},
      position: { x: 0, y: 0 },
      call: { pipelineVersionId: 'pv_2', params: {} },
    };
    expect(NodeSchema.parse(n)).toEqual(n);
  });

  it('a plain node (no call) still parses unchanged (backward-tolerant)', () => {
    const n = { id: 'plain', type: 'agent_task', config: {}, position: { x: 0, y: 0 } };
    expect(NodeSchema.parse(n)).toEqual(n);
    expect(NodeSchema.parse(n)).not.toHaveProperty('call');
  });
});

const pipeline = {
  id: 'pipe_1',
  resourceId: 'res_pipe1',
  ownerId: null,
  name: 'My pipeline',
  concurrency: null,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

describe('PipelineSchema', () => {
  it('round-trips a valid pipeline', () => {
    expect(PipelineSchema.parse(pipeline)).toEqual(pipeline);
  });

  it('rejects an empty name', () => {
    expect(() => PipelineSchema.parse({ ...pipeline, name: '' })).toThrow();
  });

  // #5 S6b — per-pipeline concurrency cap (#1 D1 field, F8b enforcement).
  it('defaults concurrency to null (uncapped) for a pre-S6b row without the key', () => {
    const { concurrency, ...preS6b } = pipeline;
    void concurrency;
    expect(PipelineSchema.parse(preS6b).concurrency).toBeNull();
  });

  it('round-trips a positive-integer concurrency cap', () => {
    expect(PipelineSchema.parse({ ...pipeline, concurrency: 3 }).concurrency).toBe(3);
  });

  it('READ path is lenient: a corrupted cap parses (use sites fail closed)', () => {
    // The read schema must never brick GET/PATCH on a row corrupted out-of-band
    // (older-export restore, manual SQL) — same read-tolerant/write-strict
    // asymmetry as StrictNodeSchema (F13a) and trigger's ConcurrencySchema.
    expect(PipelineSchema.parse({ ...pipeline, concurrency: 0 }).concurrency).toBe(0);
    expect(PipelineSchema.parse({ ...pipeline, concurrency: 1.5 }).concurrency).toBe(1.5);
  });
});

describe('NewPipelineSchema', () => {
  it('accepts a payload without server-set fields', () => {
    const { id, resourceId, createdAt, updatedAt, ...insert } = pipeline;
    void id;
    void resourceId;
    void createdAt;
    void updatedAt;
    expect(NewPipelineSchema.parse(insert)).toEqual(insert);
  });

  // #5 S6b — WRITE path is strict: only a positive integer (or null) cap.
  it('defaults concurrency to null when absent', () => {
    expect(NewPipelineSchema.parse({ ownerId: null, name: 'p' }).concurrency).toBeNull();
  });

  it('accepts a positive-integer cap and an explicit null (clear)', () => {
    expect(NewPipelineSchema.parse({ ownerId: null, name: 'p', concurrency: 2 }).concurrency).toBe(
      2,
    );
    expect(
      NewPipelineSchema.parse({ ownerId: null, name: 'p', concurrency: null }).concurrency,
    ).toBeNull();
  });

  it('rejects zero, negative, and non-integer caps on write', () => {
    expect(() => NewPipelineSchema.parse({ ownerId: null, name: 'p', concurrency: 0 })).toThrow();
    expect(() => NewPipelineSchema.parse({ ownerId: null, name: 'p', concurrency: -1 })).toThrow();
    expect(() => NewPipelineSchema.parse({ ownerId: null, name: 'p', concurrency: 1.5 })).toThrow();
  });
});

const pipelineVersion = {
  id: 'pv_1',
  resourceId: 'res_pv1',
  pipelineId: 'pipe_1',
  version: 1,
  params: [{ name: 'topic', type: 'string', required: true }],
  outputs: [{ name: 'summary', type: 'string' }],
  nodes: [
    {
      id: 'node_1',
      type: 'llm_call',
      config: {},
      position: { x: 0, y: 0 },
    },
  ],
  edges: [],
  containers: [],
  catalogVersion: CATALOG_VERSION,
  createdAt: 1700000000000,
};

describe('PipelineVersionSchema', () => {
  it('round-trips a valid pipeline version', () => {
    expect(PipelineVersionSchema.parse(pipelineVersion)).toEqual(pipelineVersion);
  });

  it('rejects version 0 (must be positive)', () => {
    expect(() => PipelineVersionSchema.parse({ ...pipelineVersion, version: 0 })).toThrow();
  });

  it('rejects a malformed node inside nodes[]', () => {
    expect(() =>
      PipelineVersionSchema.parse({
        ...pipelineVersion,
        nodes: [{ id: 'bad' }],
      }),
    ).toThrow();
  });

  it('defaults containers to [] when the key is absent (backward-tolerant)', () => {
    const { containers, ...withoutContainers } = pipelineVersion;
    void containers;
    const parsed = PipelineVersionSchema.parse(withoutContainers);
    expect(parsed.containers).toEqual([]);
  });

  // F13a — the READ path stays tolerant ON PURPOSE. This schema parses every
  // stored row (`repo/pipeline-versions.ts` getPipelineVersion/list), so
  // refusing a malformed `config.outputs` here would make an already-stored row
  // unreadable: the pipeline could not be opened in the UI to be REPAIRED, and
  // runs bound to that version could not load. A corrupt contract is refused on
  // WRITE (NewPipelineVersionSchema) and FAILS THE NODE at run time
  // (`engine/outputs.ts`) — it is never silently honoured, but it stays
  // readable. Same principle as NodeSchema's shape-only `type` and the
  // backward-tolerant `containers` default above.
  it('still READS a stored row whose config.outputs is malformed (repairable, not bricked)', () => {
    const legacy = {
      ...pipelineVersion,
      nodes: [
        {
          id: 'node_1',
          type: 'llm_call',
          config: { outputs: [{ name: 'text', type: 'nonsense' }] },
          position: { x: 0, y: 0 },
        },
      ],
    };
    expect(() => PipelineVersionSchema.parse(legacy)).not.toThrow();
  });

  // #458 — the READ path stays tolerant for pipeline-level `params`/`outputs`
  // name-uniqueness too, for the SAME brick-guard reason as config.outputs
  // above: `params`/`outputs` are IMMUTABLE once written, so refusing a stored
  // duplicate-carrying row here would make it unopenable in the UI that must
  // re-author it. The duplicate is refused on WRITE only (see below).
  it('still READS a stored row with duplicate param names (repairable, not bricked)', () => {
    const legacy = {
      ...pipelineVersion,
      params: [
        { name: 'topic', type: 'string', required: true },
        { name: 'topic', type: 'number', required: false },
      ],
    };
    expect(() => PipelineVersionSchema.parse(legacy)).not.toThrow();
  });

  it('still READS a stored row with duplicate output names (repairable, not bricked)', () => {
    const legacy = {
      ...pipelineVersion,
      outputs: [
        { name: 'summary', type: 'string' },
        { name: 'summary', type: 'number' },
      ],
    };
    expect(() => PipelineVersionSchema.parse(legacy)).not.toThrow();
  });
});

// F13a — the WRITE path is where a corrupt `config.outputs` is refused. These
// cases are the counterpart to PipelineVersionSchema's read-tolerance test.
describe('NewPipelineVersionSchema — config.outputs is refused on write (F13a)', () => {
  function withNodeConfig(config: Record<string, unknown>) {
    const { id, version, createdAt, ...rest } = pipelineVersion;
    void id;
    void version;
    void createdAt;
    return {
      ...rest,
      nodes: [{ id: 'node_1', type: 'llm_call', config, position: { x: 0, y: 0 } }],
    };
  }

  it('accepts a node with no declared outputs (absent = no contract)', () => {
    expect(() => NewPipelineVersionSchema.parse(withNodeConfig({}))).not.toThrow();
  });

  it('accepts a valid declared outputs override', () => {
    const parsed = NewPipelineVersionSchema.parse(
      withNodeConfig({ outputs: [{ name: 'text', type: 'string' }] }),
    );
    expect(parsed.nodes[0]?.config['outputs']).toEqual([{ name: 'text', type: 'string' }]);
  });

  it('rejects an unknown output type', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(withNodeConfig({ outputs: [{ name: 'text', type: 'nope' }] })),
    ).toThrow();
  });

  it('rejects a secret-typed output (a live credential-leak channel)', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(
        withNodeConfig({ outputs: [{ name: 'token', type: 'secret' }] }),
      ),
    ).toThrow();
  });

  it('rejects outputs that is not an array', () => {
    expect(() => NewPipelineVersionSchema.parse(withNodeConfig({ outputs: 'text' }))).toThrow();
  });

  // `storeOutputs` does Object.fromEntries(decl.map(...)) — duplicates silently
  // collapse last-wins, so a dupe is real state corruption, not a style nit.
  it('rejects duplicate output names', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(
        withNodeConfig({
          outputs: [
            { name: 'text', type: 'string' },
            { name: 'text', type: 'number' },
          ],
        }),
      ),
    ).toThrow();
  });

  // `refRoot` addresses `${nodes.<id>.output.<name>}` with a SINGLE-segment
  // name, so a dotted name is unaddressable as itself.
  it('rejects an output name the expression language cannot address', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(
        withNodeConfig({ outputs: [{ name: 'a.b', type: 'string' }] }),
      ),
    ).toThrow();
  });
});

// #458 — pipeline-level `params`/`outputs` name-uniqueness is the twin of the
// node-level `config.outputs` rule above (F13a). A duplicate NAME silently
// collapses last-wins wherever the list is indexed by name — `resolveRunParams`
// builds its `byName` map that way (`engine/params.ts`), so `${params.x}` with
// two `x`s resolves to whichever is LAST, and a doc reorder (canvas save, git
// round-trip) changes what the pipeline MEANS with no diff to its logic. Refused
// on the WRITE path only, matching F13a's read-tolerant/write-strict asymmetry.
describe('NewPipelineVersionSchema — duplicate pipeline-level param/output names are refused on write (#458)', () => {
  function writeDoc(overrides: Record<string, unknown>) {
    const { id, version, createdAt, ...rest } = pipelineVersion;
    void id;
    void version;
    void createdAt;
    return { ...rest, ...overrides };
  }

  it('accepts unique pipeline-level params and outputs (regression)', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(
        writeDoc({
          params: [
            { name: 'topic', type: 'string', required: true },
            { name: 'depth', type: 'number', required: false },
          ],
          outputs: [
            { name: 'summary', type: 'string' },
            { name: 'count', type: 'number' },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('rejects duplicate param names', () => {
    const result = NewPipelineVersionSchema.safeParse(
      writeDoc({
        params: [
          { name: 'topic', type: 'string', required: true },
          { name: 'topic', type: 'number', required: false },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      // Locks the shared refinement's `path: [i, 'name']` contract so a refactor
      // can't silently swap which field reports.
      const issue = result.error.issues.find((i) => i.message.includes('duplicate param name'));
      expect(issue?.path).toEqual(['params', 1, 'name']);
    }
  });

  it('rejects duplicate output names', () => {
    const result = NewPipelineVersionSchema.safeParse(
      writeDoc({
        outputs: [
          { name: 'summary', type: 'string' },
          { name: 'summary', type: 'number' },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.message.includes('duplicate output name'));
      expect(issue?.path).toEqual(['outputs', 1, 'name']);
    }
  });
});

describe('NodePolicySchema (#1 F2a)', () => {
  it('accepts a full policy', () => {
    const policy = { timeoutSeconds: 300, retry: 3, retryIntervalSeconds: 30 };
    expect(NodePolicySchema.parse(policy)).toEqual(policy);
  });

  it('accepts an empty policy (every knob is optional)', () => {
    expect(NodePolicySchema.parse({})).toEqual({});
  });

  // `retry: 0` is NOT the same fact as an absent `retry`. Absent = "policy says
  // nothing about retries"; 0 = the operator explicitly said "never retry".
  // F2b keys off the difference, so the schema must preserve it.
  it('accepts retry: 0 as an explicit never-retry', () => {
    expect(NodePolicySchema.parse({ retry: 0 })).toEqual({ retry: 0 });
  });

  it.each([-1, 1.5, Number.NaN])('rejects retry %p', (retry) => {
    expect(() => NodePolicySchema.parse({ retry })).toThrow();
  });

  // Bounds are spec #1 D4, verbatim: retryIntervalSeconds?(30–86400).
  it.each([30, 86400])('accepts retryIntervalSeconds %p (spec bound)', (s) => {
    expect(NodePolicySchema.parse({ retry: 1, retryIntervalSeconds: s })).toEqual({
      retry: 1,
      retryIntervalSeconds: s,
    });
  });

  it.each([29, 86401, 60.5])('rejects retryIntervalSeconds %p', (s) => {
    expect(() => NodePolicySchema.parse({ retry: 1, retryIntervalSeconds: s })).toThrow();
  });

  it.each([0, -1, 1.5])('rejects timeoutSeconds %p', (t) => {
    expect(() => NodePolicySchema.parse({ timeoutSeconds: t })).toThrow();
  });

  it('accepts a large timeoutSeconds (no invented ceiling — F3 owns any real bound)', () => {
    expect(NodePolicySchema.parse({ timeoutSeconds: 604800 })).toEqual({ timeoutSeconds: 604800 });
  });
});

describe('NodeSchema — policy (#1 F2a)', () => {
  const node = {
    id: 'node_1',
    type: 'llm_call',
    config: {},
    position: { x: 0, y: 0 },
  };

  // `createPipelineVersion` spreads the PARSED value into the stored row, and
  // `NodeSchema` is a plain z.object (strips unknown keys) — so a policy absent
  // from THIS schema would be dropped at write and never persist at all.
  it('round-trips a policy through the read schema', () => {
    const withPolicy = { ...node, policy: { retry: 2, retryIntervalSeconds: 60 } };
    expect(NodeSchema.parse(withPolicy)).toEqual(withPolicy);
  });

  it('accepts a node without a policy (absent = no policy, legal)', () => {
    expect(NodeSchema.parse(node)).toEqual(node);
  });

  it('rejects a policy that is not an object', () => {
    expect(() => NodeSchema.parse({ ...node, policy: 'retry-please' })).toThrow();
  });
});

describe('NewPipelineVersionSchema — policy is refused on write (#1 F2a)', () => {
  function withNodePolicy(policy: unknown) {
    const { id, version, createdAt, ...rest } = pipelineVersion;
    void id;
    void version;
    void createdAt;
    return {
      ...rest,
      nodes: [{ id: 'node_1', type: 'llm_call', config: {}, position: { x: 0, y: 0 }, policy }],
    };
  }

  it('accepts a valid policy', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(withNodePolicy({ retry: 2, retryIntervalSeconds: 60 })),
    ).not.toThrow();
  });

  // The motivating case: `secureOutput` ships with F4, the ticket that adds the
  // redaction making it true. Zod strips unknown keys by default, so without
  // `.strict()` this would be accepted and dropped — the operator would believe
  // the output was redacted while it still hit the event log in plaintext.
  it('refuses an unknown policy key such as an F4-era secureOutput', () => {
    expect(() => NewPipelineVersionSchema.parse(withNodePolicy({ secureOutput: true }))).toThrow();
  });

  // A fat-finger guard (review nitpick on #474), deliberately write-path-only:
  // a read-path range can only ever widen, so a ceiling there would be a guess
  // F3 could not take back.
  it('refuses a timeoutSeconds past the one-year sanity ceiling', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(withNodePolicy({ timeoutSeconds: 31_536_001 })),
    ).toThrow();
  });

  it('accepts a timeoutSeconds at the ceiling', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(withNodePolicy({ timeoutSeconds: 31_536_000 })),
    ).not.toThrow();
  });

  it('still READS a stored row whose timeoutSeconds is past the ceiling (write-path guard only)', () => {
    const legacy = {
      ...pipelineVersion,
      nodes: [
        {
          id: 'node_1',
          type: 'llm_call',
          config: {},
          position: { x: 0, y: 0 },
          policy: { timeoutSeconds: 31_536_001 },
        },
      ],
    };
    expect(PipelineVersionSchema.parse(legacy).nodes[0]!.policy).toEqual({
      timeoutSeconds: 31_536_001,
    });
  });

  it('refuses an out-of-range retryIntervalSeconds', () => {
    expect(() =>
      NewPipelineVersionSchema.parse(withNodePolicy({ retry: 1, retryIntervalSeconds: 5 })),
    ).toThrow();
  });

  // Dead config the operator believes is live: an interval with nothing to
  // space out. Cheap to refuse at save, and there are no legacy rows to brick.
  it.each([{ retryIntervalSeconds: 60 }, { retry: 0, retryIntervalSeconds: 60 }])(
    'refuses retryIntervalSeconds without a retry that would use it (%p)',
    (policy) => {
      expect(() => NewPipelineVersionSchema.parse(withNodePolicy(policy))).toThrow();
    },
  );

  // The F13a asymmetry, applied to policy: strict on WRITE, tolerant on READ.
  // A stored row must stay READABLE so the pipeline can be opened and repaired.
  it('still READS a stored row whose policy has an unknown key (repairable, not bricked)', () => {
    const legacy = {
      ...pipelineVersion,
      nodes: [
        {
          id: 'node_1',
          type: 'llm_call',
          config: {},
          position: { x: 0, y: 0 },
          policy: { retry: 1, secureOutput: true },
        },
      ],
    };
    expect(() => PipelineVersionSchema.parse(legacy)).not.toThrow();
  });
});

describe('NewPipelineVersionSchema', () => {
  it('accepts a payload without id/version/createdAt and defaults catalogVersion', () => {
    const { id, version, createdAt, ...rest } = pipelineVersion;
    void id;
    void version;
    void createdAt;
    const { catalogVersion, ...withoutCatalogVersion } = rest;
    void catalogVersion;
    const parsed = NewPipelineVersionSchema.parse(withoutCatalogVersion);
    expect(parsed.catalogVersion).toBe(CATALOG_VERSION);
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('version');
  });
});
