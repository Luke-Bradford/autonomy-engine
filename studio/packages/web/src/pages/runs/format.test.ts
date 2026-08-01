import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@autonomy-studio/shared';
import { eventGloss, failureClass } from './format';

function evt(payload: unknown): RunEvent {
  return { id: 'e', runId: 'r', seq: 1, type: 'x', payload, ts: 0 } as RunEvent;
}

describe('eventGloss', () => {
  it('glosses the well-known display fields', () => {
    expect(eventGloss(evt({ type: 'node.output', nodeId: 'a', name: 'text', value: 'hi' }))).toBe(
      'node=a name=text',
    );
  });

  it('names the failure CLASS, not just the message (#1 F0 / U24)', () => {
    // The regression: F0 moved the class out of the message and into fields, so
    // the feed showed `error=boom` for a throttle and for a bad credential
    // alike. The kind is the whole difference between "retry will fix it" and
    // "go and fix the connection".
    expect(
      eventGloss(
        evt({
          type: 'node.failed',
          nodeId: 'a',
          error: 'boom',
          kind: 'transient',
          code: 'rate_limit',
        }),
      ),
    ).toBe('node=a error=boom kind=transient code=rate_limit');
  });

  it('omits a class the event does not carry', () => {
    expect(eventGloss(evt({ type: 'node.failed', nodeId: 'a', error: 'boom' }))).toBe(
      'node=a error=boom',
    );
  });

  it('degrades to an empty gloss on an odd payload rather than throwing', () => {
    expect(eventGloss(evt(null))).toBe('');
    expect(eventGloss(evt({ nodeId: 42, kind: 7 }))).toBe('');
  });
});

describe('failureClass', () => {
  it('joins the kind and the code, and drops whichever is absent', () => {
    expect(failureClass('transient', 'rate_limit')).toBe('transient · rate_limit');
    expect(failureClass('permanent', undefined)).toBe('permanent');
    expect(failureClass(undefined, 'rate_limit')).toBe('rate_limit');
  });

  it('is empty when the failure carries NO class at all', () => {
    // A real state, not a gap: `externalWait.expired` fails a node with no
    // `node.failed` behind it. Callers render nothing rather than a default.
    expect(failureClass(undefined, undefined)).toBe('');
  });
});
