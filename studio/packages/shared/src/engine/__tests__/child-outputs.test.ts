import { describe, expect, it } from 'vitest';
import { projectChildRunOutputs } from '../child-outputs.js';
import { instanceKey } from '../instance-key.js';
import type { RunState } from '../types.js';

/** A doc shaped just enough for the projection — it reads node ids only. */
function doc(...ids: string[]): { nodes: { id: string }[] } {
  return { nodes: ids.map((id) => ({ id })) };
}

function state(outputs: Record<string, Record<string, unknown>>): Pick<RunState, 'outputs'> {
  return { outputs } as Pick<RunState, 'outputs'>;
}

describe('#796 projectChildRunOutputs', () => {
  it('merges every doc node output map into one flat record', () => {
    const out = projectChildRunOutputs(
      doc('fetch', 'parse') as never,
      state({ fetch: { body: 'raw' }, parse: { count: 2 } }),
    );
    expect(out).toEqual({ body: 'raw', count: 2 });
  });

  it('resolves a NAME COLLISION last-wins in sorted node-id order', () => {
    // Same rule as the container projection (`mergeChildOutputs`): sorted ids,
    // last key wins — so the answer does not depend on doc author order.
    const forward = projectChildRunOutputs(
      doc('a', 'z') as never,
      state({ a: { result: 'from-a' }, z: { result: 'from-z' } }),
    );
    const reversed = projectChildRunOutputs(
      doc('z', 'a') as never,
      state({ a: { result: 'from-a' }, z: { result: 'from-z' } }),
    );
    expect(forward).toEqual({ result: 'from-z' });
    expect(reversed).toEqual(forward);
  });

  it('does NOT leak a parallel-foreach INSTANCE key into the parent', () => {
    // `state.outputs` is keyed by node id AND by `<nodeId>@<i>` instance keys; a
    // raw key walk would hand the caller per-item loop internals.
    const body = 'body';
    const out = projectChildRunOutputs(
      doc('body', 'summary') as never,
      state({
        [instanceKey(body, 0)]: { item: 'first' },
        [instanceKey(body, 1)]: { item: 'second' },
        summary: { total: 2 },
      }),
    );
    expect(out).toEqual({ total: 2 });
  });

  it('is {} for a child that produced nothing, and never invents a declared name', () => {
    expect(projectChildRunOutputs(doc('a', 'b') as never, state({}))).toEqual({});
  });

  it('projects what a FAILED child managed to produce (the findings loop)', () => {
    // `call.returned`'s schema permits outputs on a failure; the parent's failure
    // edge decides whether they may be used, not this function.
    expect(
      projectChildRunOutputs(doc('scan') as never, state({ scan: { findings: ['x'] } })),
    ).toEqual({ findings: ['x'] });
  });
});
