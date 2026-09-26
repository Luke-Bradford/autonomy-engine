/**
 * #1 F4 — `policy.secureInput`/`secureOutput`: emit-time redaction
 * (`Engine.redact`), the reducer's secure-mode contract check, the save-time
 * refusals (a ref to a secure output; the nodes a flag cannot hold on), and RS5
 * (a secure node is never copied by rerun-from-failed).
 */
import { describe, expect, it } from 'vitest';
import type { Container, Edge, EngineEvent, Node, NodeRunState, RunState } from '../types.js';
import { createEngine, type Engine } from '../reduce.js';
import { availableRefs, validatePipelineDoc } from '../params.js';
import {
  SECURE_ERROR_WITHHELD,
  SECURE_REDACTED,
  SECURE_REDACTED_INVALID,
  redactSecureEvent,
} from '../secure.js';

const RUN = 'R1';
let seq = 0;
function node(id: string, over: Partial<Node> = {}): Node {
  seq += 1;
  return { id, type: 'agent_task', config: {}, position: { x: seq, y: 0 }, ...over };
}
const SECURE = { policy: { secureOutput: true } } as const;
function declares(outputs: { name: string; type: string; optional?: boolean }[]) {
  return { config: { outputs } };
}
function edge(from: string, to: string): Edge {
  return { id: `${from}->${to}`, from, to, on: 'success' };
}
function engine(nodes: Node[], edges: Edge[] = [], containers: Container[] = []): Engine {
  return createEngine({ nodes, edges, containers });
}
function doc(nodes: Node[], edges: Edge[] = [], containers: Container[] = []) {
  return { params: [], nodes, edges, containers };
}
const succeeded = (nodeId: string, outputs: Record<string, unknown>): EngineEvent => ({
  type: 'node.succeeded',
  runId: RUN,
  nodeId,
  attemptId: `${nodeId}#0`,
  outputs,
});

describe('#1 F4 — Engine.redact (emit-time)', () => {
  const secret = node('s', { ...SECURE, ...declares([{ name: 'token', type: 'string' }]) });
  const plain = node('p', declares([{ name: 'token', type: 'string' }]));
  const eng = engine([secret, plain]);

  it("replaces a secure node's output VALUES with the marker and keeps the keys", () => {
    const ev = eng.redact(succeeded('s', { token: 'hunter2' }));
    expect(ev).toMatchObject({ outputs: { token: SECURE_REDACTED } });
    expect(JSON.stringify(ev)).not.toContain('hunter2');
  });

  it('leaves a node without the flag untouched', () => {
    expect(eng.redact(succeeded('p', { token: 'hunter2' }))).toEqual(
      succeeded('p', { token: 'hunter2' }),
    );
  });

  it('marks a value that does not match its declared type as INVALID', () => {
    const n = node('n', { ...SECURE, ...declares([{ name: 'count', type: 'number' }]) });
    const ev = createEngine({ nodes: [n], edges: [] }).redact(succeeded('n', { count: 'seven' }));
    expect(ev).toMatchObject({ outputs: { count: SECURE_REDACTED_INVALID } });
  });

  // Review NITPICK on #1313: the verdict is taken on the RAW value, so an output
  // that merely spells a marker cannot forge one.
  it('a raw value spelled like a marker cannot forge a verdict', () => {
    const str = node('t', { ...SECURE, ...declares([{ name: 's', type: 'string' }]) });
    const num = node('n', { ...SECURE, ...declares([{ name: 'count', type: 'number' }]) });
    const e = createEngine({ nodes: [str, num], edges: [] });
    expect(e.redact(succeeded('t', { s: SECURE_REDACTED_INVALID }))).toMatchObject({
      outputs: { s: SECURE_REDACTED },
    });
    expect(e.redact(succeeded('n', { count: SECURE_REDACTED }))).toMatchObject({
      outputs: { count: SECURE_REDACTED_INVALID },
    });
  });

  it('resolves a parallel-foreach INSTANCE id (`s@2`) to its doc node', () => {
    expect(eng.redact(succeeded('s@2', { token: 'hunter2' }))).toMatchObject({
      outputs: { token: SECURE_REDACTED },
    });
  });

  it('scrubs a streamed node.output value AND name', () => {
    const ev = eng.redact({
      type: 'node.output',
      runId: RUN,
      nodeId: 's',
      name: 'hunter2-name',
      value: 'hunter2',
    });
    expect(JSON.stringify(ev)).not.toContain('hunter2');
  });

  it('withholds failure prose but keeps kind/code (retry policy still applies)', () => {
    const ev = eng.redact({
      type: 'node.failed',
      runId: RUN,
      nodeId: 's',
      attemptId: 's#0',
      error: 'upstream said: hunter2',
      kind: 'transient',
      code: 'rate_limit',
    });
    expect(ev).toMatchObject({
      error: SECURE_ERROR_WITHHELD,
      kind: 'transient',
      code: 'rate_limit',
    });
  });

  it('secureInput alone withholds failure prose and hashes, but not outputs', () => {
    const n = node('i', { policy: { secureInput: true } });
    const e = createEngine({ nodes: [n], edges: [] });
    expect(e.redact(succeeded('i', { v: 1 }))).toEqual(succeeded('i', { v: 1 }));
    const failed = e.redact({
      type: 'node.failed',
      runId: RUN,
      nodeId: 'i',
      attemptId: 'i#0',
      error: 'bad input hunter2',
      kind: 'permanent',
    });
    expect(failed).toMatchObject({ error: SECURE_ERROR_WITHHELD });
    const tool = e.redact({
      type: 'activity.toolCalled',
      runId: RUN,
      nodeId: 'i',
      attemptId: 'i#0',
      round: 0,
      toolName: 't',
      argsChars: 3,
      argsHash: 'abc',
      resultChars: 3,
      resultHash: 'def',
      isError: false,
    });
    expect(tool).toMatchObject({ argsHash: SECURE_REDACTED, resultHash: SECURE_REDACTED });
  });

  it('scrubs every content hash on activity.captured (unsalted, so guessable)', () => {
    const ev = eng.redact({
      type: 'activity.captured',
      runId: RUN,
      nodeId: 's',
      attemptId: 's#0',
      provider: 'anthropic',
      model: 'm',
      latencyMs: 1,
      request: {
        messageCount: 1,
        system: { chars: 1, contentHash: 'h-sys' },
        messages: [{ role: 'user', chars: 1, contentHash: 'h-msg' }],
      },
      completion: { chars: 1, contentHash: 'h-out' },
    });
    expect(JSON.stringify(ev)).not.toMatch(/h-sys|h-msg|h-out/);
  });

  /* #605 L9b — a 'full' capture carries raw text. On a secure node every text
     becomes the marker (never dropped: an ABSENT text means "metadata mode", and
     the UI must be able to tell the two apart), `truncated` goes with it, and the
     lengths survive exactly as they do for the hashes. */
  it('withholds every captured TEXT on a secure node, keeping the lengths', () => {
    const ev = eng.redact({
      type: 'activity.captured',
      runId: RUN,
      nodeId: 's',
      attemptId: 's#0',
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      request: {
        messageCount: 1,
        system: { chars: 7, contentHash: 'h1', text: 'sys-txt' },
        messages: [
          { role: 'user', chars: 9, contentHash: 'h2', text: 'hunter2-p', truncated: true },
        ],
      },
      completion: { chars: 8, contentHash: 'h3', text: 'answer-x' },
    });
    expect(JSON.stringify(ev)).not.toMatch(/sys-txt|hunter2-p|answer-x/);
    expect(ev).toMatchObject({
      request: {
        system: { chars: 7, text: SECURE_REDACTED },
        messages: [{ chars: 9, text: SECURE_REDACTED }],
      },
      completion: { chars: 8, text: SECURE_REDACTED },
    });
    if (ev.type !== 'activity.captured') throw new Error('type changed');
    expect('truncated' in ev.request.messages[0]!).toBe(false);
  });

  it('leaves a metadata-mode capture with NO text key on a secure node', () => {
    const ev = eng.redact({
      type: 'activity.captured',
      runId: RUN,
      nodeId: 's',
      attemptId: 's#0',
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      request: { messageCount: 1, messages: [{ role: 'user', chars: 1, contentHash: 'h' }] },
    });
    if (ev.type !== 'activity.captured') throw new Error('type changed');
    expect('text' in ev.request.messages[0]!).toBe(false);
    expect('completion' in ev).toBe(false);
  });

  it("leaves a non-secure node's captured text untouched", () => {
    const ev = eng.redact({
      type: 'activity.captured',
      runId: RUN,
      nodeId: 'p',
      attemptId: 'p#0',
      provider: 'ollama',
      model: 'm',
      latencyMs: 1,
      request: {
        messageCount: 1,
        messages: [{ role: 'user', chars: 2, contentHash: 'h', text: 'hi' }],
      },
      completion: { chars: 2, contentHash: 'h', text: 'yo' },
    });
    expect(ev).toMatchObject({
      completion: { text: 'yo' },
      request: { messages: [{ text: 'hi' }] },
    });
  });

  const dispatched = (nodeId: string): EngineEvent => ({
    type: 'node.dispatched',
    runId: RUN,
    nodeId,
    attemptId: `${nodeId}#0`,
    idempotent: false,
    input: { text: '{"to":"alice@example.com","body":"hi"}', chars: 90, truncated: true },
  });

  it("#890 withholds a secure node's recorded INPUT text, keeping its length", () => {
    const inOnly = node('i', { policy: { secureInput: true } });
    for (const n of [secret, inOnly]) {
      const got = createEngine({ nodes: [n], edges: [], containers: [] }).redact(dispatched(n.id));
      expect(got).toMatchObject({ input: { text: SECURE_REDACTED, chars: 90 } });
      expect(got.type === 'node.dispatched' && got.input?.truncated).toBeUndefined();
    }
  });

  it('#890 resolves a foreach instance id on node.dispatched too', () => {
    expect(eng.redact(dispatched('s@3'))).toMatchObject({ input: { text: SECURE_REDACTED } });
  });

  it("#890 leaves a non-secure node's input, and a dispatch with no input, untouched", () => {
    const ev = dispatched('p');
    expect(eng.redact(ev)).toBe(ev);
    const bare: EngineEvent = {
      type: 'node.dispatched',
      runId: RUN,
      nodeId: 's',
      attemptId: 's#0',
      idempotent: false,
    };
    expect(eng.redact(bare)).toEqual(bare);
  });

  it('passes a run-level event through (no node to be secure)', () => {
    const ev: EngineEvent = {
      type: 'run.started',
      runId: RUN,
      pipelineVersionId: 'pv',
      params: {},
    };
    expect(eng.redact(ev)).toBe(ev);
    expect(redactSecureEvent(undefined, succeeded('x', { a: 1 }))).toEqual(
      succeeded('x', { a: 1 }),
    );
  });
});

describe('#1 F4 — the reducer folds a redacted success', () => {
  function runTo(e: Engine, id: string): RunState {
    let s = e.reduce(e.seedState(), {
      type: 'run.started',
      runId: RUN,
      pipelineVersionId: 'pv',
      params: {},
    }).state;
    s = e.reduce(s, {
      type: 'node.dispatched',
      runId: RUN,
      nodeId: id,
      attemptId: `${id}#0`,
      idempotent: true,
    }).state;
    return s;
  }

  it('a secure node with a declared NUMBER output still succeeds on the marker', () => {
    const n = node('n', { ...SECURE, ...declares([{ name: 'count', type: 'number' }]) });
    const e = createEngine({ nodes: [n], edges: [] });
    const r = e.reduce(runTo(e, 'n'), e.redact(succeeded('n', { count: 3 })));
    expect(r.state.nodes['n']!.status).toBe('success');
    expect(r.state.outputs['n']).toEqual({ count: SECURE_REDACTED });
  });

  it('a secure node whose output was MISTYPED still fails, with the usual diagnostic', () => {
    const n = node('n', { ...SECURE, ...declares([{ name: 'count', type: 'number' }]) });
    const e = createEngine({ nodes: [n], edges: [] });
    const r = e.reduce(runTo(e, 'n'), e.redact(succeeded('n', { count: 'seven' })));
    expect(r.state.nodes['n']!.status).toBe('failure');
    expect(r.diagnostics.join(' ')).toContain("output 'count' is not of declared type 'number'");
  });

  it('a declared STRING output does not pass on the INVALID marker', () => {
    const n = node('n', { ...SECURE, ...declares([{ name: 't', type: 'string' }]) });
    const e = createEngine({ nodes: [n], edges: [] });
    const r = e.reduce(runTo(e, 'n'), succeeded('n', { t: SECURE_REDACTED_INVALID }));
    expect(r.state.nodes['n']!.status).toBe('failure');
  });

  it('a NON-secure node emitting the marker string is type-checked as plain text', () => {
    const n = node('n', declares([{ name: 'count', type: 'number' }]));
    const e = createEngine({ nodes: [n], edges: [] });
    const r = e.reduce(runTo(e, 'n'), succeeded('n', { count: SECURE_REDACTED }));
    expect(r.state.nodes['n']!.status).toBe('failure');
  });
});

describe('#1 F4 — validateRefs refuses a ref to a secure output', () => {
  const producer = (secure: boolean) =>
    node('a', { ...(secure ? SECURE : {}), ...declares([{ name: 'v', type: 'string' }]) });
  const consumer = (expr: string) => node('b', { config: { prompt: expr } });
  const errs = (secure: boolean, expr: string) =>
    validatePipelineDoc(doc([producer(secure), consumer(expr)], [edge('a', 'b')])).join('\n');

  it('refuses a bare ref, and accepts the same ref to a non-secure producer', () => {
    expect(errs(true, '${nodes.a.output.v}')).toContain("node 'a' has secure outputs");
    expect(errs(false, '${nodes.a.output.v}')).toBe('');
  });

  it('refuses it inside default() too — the fallback would always fire', () => {
    expect(errs(true, '${default(nodes.a.output.v, "x")}')).toContain(
      "node 'a' has secure outputs",
    );
  });

  it('still allows ${nodes.a.status}', () => {
    expect(errs(true, '${nodes.a.status}')).toBe('');
  });

  it("refuses a ref to a CONTAINER with a secure child (its outputs merge the child's)", () => {
    const c: Container = { id: 'fe', kind: 'foreach', children: ['a'], items: '${params.xs}' };
    const d = doc(
      [producer(true), node('b', { config: { prompt: '${nodes.fe.output.results}' } })],
      [edge('fe', 'b')],
      [c],
    );
    expect(validatePipelineDoc(d).join('\n')).toContain("node 'fe' has secure outputs");
  });

  it("refuses a loop's exitWhen reading a secure child", () => {
    const n = node('a', { ...SECURE, ...declares([{ name: 'done', type: 'boolean' }]) });
    const c: Container = {
      id: 'lp',
      kind: 'loop',
      children: ['a'],
      exitWhen: '${nodes.a.output.done}',
    };
    expect(validatePipelineDoc(doc([n], [], [c])).join('\n')).toContain(
      "node 'a' has secure outputs",
    );
  });

  it("refuses a foreach's items reading a secure producer", () => {
    const n = node('a', { ...SECURE, ...declares([{ name: 'xs', type: 'json' }]) });
    const c: Container = {
      id: 'fe',
      kind: 'foreach',
      children: ['w'],
      items: '${nodes.a.output.xs}',
    };
    const d = doc([n, node('w')], [edge('a', 'fe')], [c]);
    expect(validatePipelineDoc(d).join('\n')).toContain("node 'a' has secure outputs");
  });

  it('the ref picker does not offer a secure producer', () => {
    const offered = (secure: boolean) =>
      availableRefs(doc([producer(secure), consumer('')], [edge('a', 'b')]), {
        kind: 'node',
        nodeId: 'b',
        field: 'prompt',
      }).map((s) => s.ref);
    expect(offered(false)).toContain('nodes.a.output.v');
    expect(offered(true)).not.toContain('nodes.a.output.v');
  });
});

describe('#1 F4 — validateDoc refuses a flag it cannot honour', () => {
  const errs = (n: Node) => validatePipelineDoc(doc([n])).join('\n');

  it('on a pipeline call node', () => {
    const n = node('c', {
      type: 'execute_pipeline',
      call: { pipelineVersionId: 'pv2', params: {} },
      policy: { secureInput: true },
    });
    expect(errs(n)).toContain('is not supported on a pipeline call');
  });

  it('on if / switch', () => {
    const n = node('i', { type: 'if', config: { condition: '${true}' }, ...SECURE });
    expect(errs(n)).toContain("is not supported on 'if'");
  });

  it('secureInput alone on a filter (its result is its input), but not with secureOutput', () => {
    const f = (policy: Node['policy']) =>
      node('f', {
        type: 'filter',
        config: { items: '${params.xs}', predicate: '${true}' },
        policy,
      });
    expect(errs(f({ secureInput: true }))).toContain('secureInput needs policy.secureOutput');
    expect(errs(f({ secureInput: true, secureOutput: true }))).not.toContain(
      'secureInput needs policy.secureOutput',
    );
  });

  it('secureInput alone on an llm_call that emits its transcript', () => {
    const n = node('l', {
      type: 'llm_call',
      config: { emitMessages: true },
      policy: { secureInput: true },
    });
    expect(errs(n)).toContain("'messages' transcript output carries its prompt");
  });

  it('accepts secureOutput on an ordinary activity', () => {
    expect(errs(node('a', SECURE))).not.toContain('secure');
  });
});

describe('RS5 — reseedFrontier never copies a secure node', () => {
  function ns(status: NodeRunState['status']): NodeRunState {
    return { status, attempts: 1, retries: 0 };
  }
  function state(
    nodes: Record<string, NodeRunState['status']>,
    containers: RunState['containers'] = {},
  ): RunState {
    return {
      runId: 'R1',
      pipelineVersionId: 'pv1',
      startedAt: null,
      params: {},
      status: 'failure',
      waitingReason: null,
      nodes: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, ns(v)])),
      outputs: {},
      containers,
      bounces: {},
      branches: {},
      sessions: {},
      triggerContext: null,
      cancelRequested: null,
    };
  }

  it('a secure success re-runs, and so does everything downstream of it', () => {
    const eng = engine(
      [node('a'), node('s', SECURE), node('b'), node('c')],
      [edge('a', 's'), edge('s', 'b'), edge('b', 'c')],
    );
    const r = eng.reseedFrontier(state({ a: 'success', s: 'success', b: 'success', c: 'failure' }));
    expect(r.frontier).toEqual(['a']);
  });

  it('a successful container with a secure child re-runs whole', () => {
    const eng = engine(
      [node('s', SECURE), node('b')],
      [edge('st', 'b')],
      [{ id: 'st', kind: 'stage', children: ['s'], join: 'all' }],
    );
    const r = eng.reseedFrontier(
      state({ s: 'success', b: 'failure' }, { st: { status: 'success', round: 0, outputs: {} } }),
    );
    expect(r.copiedContainers).toEqual({});
  });
});
