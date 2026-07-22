import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@autonomy-studio/shared';
import { createRunEventBus } from '../event-bus.js';

function evt(runId: string, seq: number): RunEvent {
  return {
    id: `evt_${runId}_${seq}`,
    runId,
    seq,
    type: 'node.output',
    payload: { type: 'node.output', runId, nodeId: 'n1', name: 'chunk', value: seq },
    ts: seq,
  };
}

describe('createRunEventBus', () => {
  it('delivers an event only to subscribers of that run', () => {
    const bus = createRunEventBus();
    const a: RunEvent[] = [];
    const b: RunEvent[] = [];
    bus.subscribe('run_a', (e) => a.push(e));
    bus.subscribe('run_b', (e) => b.push(e));

    bus.publish(evt('run_a', 0));

    expect(a).toHaveLength(1);
    expect(a[0]!.seq).toBe(0);
    expect(b).toHaveLength(0);
  });

  it('fans out to every subscriber of the same run', () => {
    const bus = createRunEventBus();
    const seen: number[] = [];
    bus.subscribe('run_a', () => seen.push(1));
    bus.subscribe('run_a', () => seen.push(2));

    bus.publish(evt('run_a', 0));

    expect(seen.sort()).toEqual([1, 2]);
    expect(bus.subscriberCount('run_a')).toBe(2);
  });

  it('stops delivering after unsubscribe and cleans up the run key', () => {
    const bus = createRunEventBus();
    const seen: RunEvent[] = [];
    const off = bus.subscribe('run_a', (e) => seen.push(e));

    bus.publish(evt('run_a', 0));
    off();
    bus.publish(evt('run_a', 1));

    expect(seen).toHaveLength(1);
    expect(bus.subscriberCount('run_a')).toBe(0);
  });

  it('is idempotent on repeated unsubscribe and never touches a co-subscriber', () => {
    const bus = createRunEventBus();
    const other: RunEvent[] = [];
    const off = bus.subscribe('run_a', () => {});
    bus.subscribe('run_a', (e) => other.push(e));

    off();
    off(); // must not throw or remove the second subscriber

    bus.publish(evt('run_a', 0));
    expect(other).toHaveLength(1);
    expect(bus.subscriberCount('run_a')).toBe(1);
  });

  it('isolates a throwing subscriber: others still receive, error is reported', () => {
    const onListenerError = vi.fn();
    const bus = createRunEventBus({ onListenerError });
    const good: RunEvent[] = [];
    bus.subscribe('run_a', () => {
      throw new Error('boom');
    });
    bus.subscribe('run_a', (e) => good.push(e));

    expect(() => bus.publish(evt('run_a', 0))).not.toThrow();
    expect(good).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(onListenerError.mock.calls[0]![1]).toBe('run_a');
  });

  it('lets a subscriber unsubscribe from within its own callback safely', () => {
    const bus = createRunEventBus();
    const seen: number[] = [];
    const off = bus.subscribe('run_a', (e) => {
      seen.push(e.seq);
      off();
    });

    bus.publish(evt('run_a', 0));
    bus.publish(evt('run_a', 1));

    expect(seen).toEqual([0]);
    expect(bus.subscriberCount('run_a')).toBe(0);
  });

  it('publish to a run with no subscribers is a no-op', () => {
    const bus = createRunEventBus();
    expect(() => bus.publish(evt('run_x', 0))).not.toThrow();
    expect(bus.subscriberCount('run_x')).toBe(0);
  });
});

// #629 — the GLOBAL subscription mode: a cross-run reactor (the launcher's queue
// drain) that must react to a run's terminal event regardless of its runId,
// which the per-run `subscribe` cannot serve (it is keyed by a runId known in
// advance; the target case is a run the reactor never subscribed to).
describe('createRunEventBus — subscribeAll (cross-run tap)', () => {
  it('delivers EVERY published event to a global subscriber, whatever the runId', () => {
    const bus = createRunEventBus();
    const seen: RunEvent[] = [];
    bus.subscribeAll((e) => seen.push(e));

    bus.publish(evt('run_a', 0));
    bus.publish(evt('run_b', 1));

    expect(seen.map((e) => e.runId)).toEqual(['run_a', 'run_b']);
  });

  it('delivers to BOTH the run subscriber and a global subscriber', () => {
    const bus = createRunEventBus();
    const perRun: RunEvent[] = [];
    const global: RunEvent[] = [];
    bus.subscribe('run_a', (e) => perRun.push(e));
    bus.subscribeAll((e) => global.push(e));

    bus.publish(evt('run_a', 0));

    expect(perRun).toHaveLength(1);
    expect(global).toHaveLength(1);
  });

  it('stops delivering after unsubscribe, idempotently', () => {
    const bus = createRunEventBus();
    const seen: RunEvent[] = [];
    const off = bus.subscribeAll((e) => seen.push(e));

    bus.publish(evt('run_a', 0));
    off();
    off(); // must not throw
    bus.publish(evt('run_a', 1));

    expect(seen).toHaveLength(1);
  });

  it('isolates a throwing global subscriber: per-run + other globals still receive, error reported', () => {
    const onListenerError = vi.fn();
    const bus = createRunEventBus({ onListenerError });
    const perRun: RunEvent[] = [];
    const otherGlobal: RunEvent[] = [];
    bus.subscribe('run_a', (e) => perRun.push(e));
    bus.subscribeAll(() => {
      throw new Error('boom');
    });
    bus.subscribeAll((e) => otherGlobal.push(e));

    expect(() => bus.publish(evt('run_a', 0))).not.toThrow();
    expect(perRun).toHaveLength(1);
    expect(otherGlobal).toHaveLength(1);
    expect(onListenerError).toHaveBeenCalledOnce();
    expect(onListenerError.mock.calls[0]![1]).toBe('run_a');
  });

  it('lets a global subscriber unsubscribe from within its own callback safely', () => {
    const bus = createRunEventBus();
    const seen: number[] = [];
    const off = bus.subscribeAll((e) => {
      seen.push(e.seq);
      off();
    });

    bus.publish(evt('run_a', 0));
    bus.publish(evt('run_a', 1));

    expect(seen).toEqual([0]);
  });
});
