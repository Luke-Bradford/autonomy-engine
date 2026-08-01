import { describe, expect, it } from 'vitest';
import type { Node, PipelineVersion } from '@autonomy-studio/shared';
import { describeCallbackBody, owesCallback, parkedDocNode, waitKey } from './externalWaits';

function webhook(id: string, outputs?: unknown): Node {
  return {
    id,
    type: 'webhook',
    config:
      outputs === undefined ? { timeoutSeconds: '${600}' } : { timeoutSeconds: '${600}', outputs },
    position: { x: 0, y: 0 },
  } as Node;
}

function doc(nodes: Node[]): PipelineVersion {
  return { nodes } as PipelineVersion;
}

describe('owesCallback', () => {
  it('is true only for an EXTERNAL park', () => {
    expect(owesCallback('waiting_external')).toBe(true);
  });

  it('is false for a timer park — a `wait` node owes no callback', () => {
    // The bug this gate exists to prevent: gating on the bare `waiting` status
    // would fetch on every timer park and render an empty section under a
    // heading claiming a callback is owed.
    expect(owesCallback('waiting_timer')).toBe(false);
  });

  it('is false when the reason is unknown (the REST row carries none)', () => {
    expect(owesCallback(null)).toBe(false);
  });
});

describe('parkedDocNode', () => {
  it('resolves a plain parked node id', () => {
    expect(parkedDocNode(doc([webhook('approve')]), 'approve')?.id).toBe('approve');
  });

  it('resolves a parallel foreach INSTANCE key to its doc node', () => {
    // The engine parks `approve@1`; the doc only ever has `approve`. Without the
    // instance-suffix strip this surface would say nothing about the node it is
    // asking the operator to unpark.
    expect(parkedDocNode(doc([webhook('approve')]), 'approve@1')?.id).toBe('approve');
  });

  it('prefers an EXACT match over the suffix strip', () => {
    // A legacy sequential doc may carry a literal `x@2` node. It must resolve to
    // itself, not to `x`.
    const d = doc([webhook('x'), webhook('x@2')]);
    expect(parkedDocNode(d, 'x@2')?.id).toBe('x@2');
  });

  it('is null when the bound version did not resolve', () => {
    expect(parkedDocNode(null, 'approve')).toBeNull();
  });

  it('is null when the doc has no such node', () => {
    expect(parkedDocNode(doc([webhook('other')]), 'approve')).toBeNull();
  });
});

describe('describeCallbackBody', () => {
  it('says nothing when there is no node to read a contract off', () => {
    expect(describeCallbackBody(null)).toBeNull();
  });

  it('says a no-outputs webhook needs no body AND discards what it is sent', () => {
    /* Both halves matter. The callback returns 204 either way, so an operator who
       sends a payload has no way to discover it was dropped
       (`checkInboundOutputs` never stores an undeclared body). */
    const text = describeCallbackBody(webhook('w'))!;
    expect(text).toContain('declares no outputs');
    expect(text).toContain('discarded');
  });

  it('treats a LOWERED empty declaration the same as an absent one', () => {
    // `config.outputs: []` is what the save path lowers "declares nothing" to, so
    // it must not read as "a contract with no keys".
    expect(describeCallbackBody(webhook('w', []))).toBe(describeCallbackBody(webhook('w')));
  });

  it('names every REQUIRED declared output with its type', () => {
    const text = describeCallbackBody(
      webhook('w', [
        { name: 'decision', type: 'string' },
        { name: 'score', type: 'number' },
      ]),
    )!;
    expect(text).toContain('must be JSON supplying');
    expect(text).toContain('“decision” (string)');
    expect(text).toContain('“score” (number)');
  });

  it('separates optional outputs from required ones', () => {
    const text = describeCallbackBody(
      webhook('w', [
        { name: 'decision', type: 'string' },
        { name: 'note', type: 'string', optional: true },
      ]),
    )!;
    // A required key omitted is a 422 that leaves the node parked; an optional one
    // is not. Collapsing the two would send the operator into that 422.
    expect(text).toMatch(/must be JSON supplying “decision” \(string\)\./);
    expect(text).toContain('Optional: “note” (string)');
  });

  it('says an all-optional contract accepts an empty body', () => {
    const text = describeCallbackBody(
      webhook('w', [{ name: 'note', type: 'string', optional: true }]),
    )!;
    expect(text).toContain('empty body is accepted');
    expect(text).toContain('“note” (string)');
  });

  it('admits when the declared contract cannot be read', () => {
    // Only reachable on a pre-F13a row, and `checkInboundOutputs` calls it a
    // `contract` failure no caller can correct — so the honest answer is to say
    // the body cannot be described, never to imply "no body needed".
    const text = describeCallbackBody(webhook('w', { not: 'an array' }))!;
    expect(text).toContain('cannot be read');
    expect(text).not.toContain('declares no outputs');
  });
});

describe('waitKey', () => {
  it('distinguishes two parks of the SAME node on different attempts', () => {
    expect(waitKey({ nodeId: 'w', attemptId: 'a1' })).not.toBe(
      waitKey({ nodeId: 'w', attemptId: 'a2' }),
    );
  });

  it('distinguishes two nodes parked on the same attempt number', () => {
    expect(waitKey({ nodeId: 'w1', attemptId: 'a1' })).not.toBe(
      waitKey({ nodeId: 'w2', attemptId: 'a1' }),
    );
  });
});
