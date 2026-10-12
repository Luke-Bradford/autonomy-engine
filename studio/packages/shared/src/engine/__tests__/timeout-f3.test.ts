/**
 * #1600 OR41 C0a (#1 F3) — `policy.timeoutSeconds` is enforced on execution
 * activities only, so the save refuses it where nothing would enforce it: a node
 * the engine evaluates instead of running, and a pipeline call. The F4 precedent
 * (`secure-f4.test.ts`): an accepted promise the run would not keep is fail-open.
 */
import { describe, expect, it } from 'vitest';
import type { Node } from '../types.js';
import { validatePipelineDoc } from '../validate-pipeline.js';

let seq = 0;
function node(id: string, over: Partial<Node>): Node {
  seq += 1;
  return { id, type: 'agent_task', config: { task: 't' }, position: { x: seq, y: 0 }, ...over };
}
const errs = (n: Node) =>
  validatePipelineDoc({ params: [], variables: [], nodes: [n], edges: [], containers: [] }).join('\n');
const TIMEOUT = { policy: { timeoutSeconds: 60 } } as const;

describe('#1600 C0a — validateDoc refuses a timeout nothing would enforce', () => {
  it('on a webhook, pointing at its own timeout', () => {
    const n = node('w', { type: 'webhook', config: { timeoutSeconds: '${600}' }, ...TIMEOUT });
    expect(errs(n)).toContain(
      "node 'w': policy.timeoutSeconds is not supported on 'webhook' — it waits for its callback; set its own Timeout instead",
    );
  });

  it('on a wait', () => {
    const n = node('t', { type: 'wait', config: { seconds: '${5}' }, ...TIMEOUT });
    expect(errs(n)).toContain("node 't': policy.timeoutSeconds is not supported on 'wait'");
  });

  it('on an engine-evaluated activity (if)', () => {
    const n = node('i', { type: 'if', config: { condition: '${true}' }, ...TIMEOUT });
    expect(errs(n)).toContain(
      "node 'i': policy.timeoutSeconds is not supported on 'if' — the engine evaluates it instantly, so there is nothing to time out",
    );
  });

  it('on a pipeline call', () => {
    const n = node('c', {
      type: 'execute_pipeline',
      config: {},
      call: { pipelineVersionId: 'pv2', params: {} },
      ...TIMEOUT,
    });
    expect(errs(n)).toContain("node 'c': policy.timeoutSeconds is not supported on a pipeline call");
  });

  it('accepts it on an execution activity', () => {
    expect(errs(node('a', TIMEOUT))).not.toContain('timeoutSeconds');
    expect(
      errs(node('h', { type: 'http_request', config: { url: 'https://x' }, ...TIMEOUT })),
    ).not.toContain('timeoutSeconds');
  });

  it('says nothing when no timeout is set', () => {
    expect(errs(node('i', { type: 'if', config: { condition: '${true}' } }))).not.toContain(
      'timeoutSeconds',
    );
  });
});
