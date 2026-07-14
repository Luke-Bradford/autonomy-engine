import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { EngineEvent, RunEvent } from '@autonomy-studio/shared';
import { useRunStream, type SocketLike } from './useRunStream';

let seq = 0;
function envelope(event: EngineEvent): RunEvent {
  return {
    id: `evt_${seq}`,
    runId: event.runId,
    seq: seq++,
    type: event.type,
    payload: event,
    ts: seq,
  };
}

class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  // ---- test drivers (wrapped in act by callers) ----
  open() {
    this.onopen?.({});
  }
  send(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  sendRaw(data: unknown) {
    this.onmessage?.({ data });
  }
  fireClose(code?: number) {
    this.onclose?.({ code, reason: '' });
  }
  fireError() {
    this.onerror?.({});
  }
}

/** A factory with a stable identity (defined once) that records every socket. */
function makeFactory() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

afterEach(() => cleanup());

describe('useRunStream', () => {
  it('walks connecting → replaying → live and collects replayed then live events', () => {
    const { factory, sockets } = makeFactory();
    const { result } = renderHook(() => useRunStream('run_1', factory));

    expect(result.current.phase).toBe('connecting');
    const sock = sockets[0]!;
    expect(sock.url).toContain('/api/runs/run_1/events/stream');

    act(() => sock.open());
    expect(result.current.phase).toBe('replaying');

    act(() =>
      sock.send({
        kind: 'event',
        event: envelope({
          type: 'run.started',
          runId: 'run_1',
          pipelineVersionId: 'pv',
          params: {},
        }),
      }),
    );
    act(() => sock.send({ kind: 'replay_complete', throughSeq: result.current.events[0]!.seq }));
    expect(result.current.phase).toBe('live');
    expect(result.current.events).toHaveLength(1);

    act(() =>
      sock.send({
        kind: 'event',
        event: envelope({
          type: 'node.dispatched',
          runId: 'run_1',
          nodeId: 'a',
          attemptId: 'a#0',
          idempotent: true,
        }),
      }),
    );
    expect(result.current.events).toHaveLength(2);
  });

  it('dedupes a re-sent seq', () => {
    const { factory, sockets } = makeFactory();
    const { result } = renderHook(() => useRunStream('run_1', factory));
    const sock = sockets[0]!;
    const ev = {
      kind: 'event' as const,
      event: envelope({ type: 'run.started', runId: 'run_1', pipelineVersionId: 'pv', params: {} }),
    };
    act(() => sock.open());
    act(() => sock.send(ev));
    act(() => sock.send(ev));
    expect(result.current.events).toHaveLength(1);
  });

  it('a clean 1000 close moves to closed', () => {
    const { factory, sockets } = makeFactory();
    const { result } = renderHook(() => useRunStream('run_1', factory));
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.fireClose(1000));
    expect(result.current.phase).toBe('closed');
  });

  it('a 4404 close surfaces an access error', () => {
    const { factory, sockets } = makeFactory();
    const { result } = renderHook(() => useRunStream('run_x', factory));
    act(() => sockets[0]!.fireClose(4404));
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toMatch(/not found or not accessible/);
  });

  it('a malformed frame errors and closes the socket', () => {
    const { factory, sockets } = makeFactory();
    const { result } = renderHook(() => useRunStream('run_1', factory));
    act(() => sockets[0]!.open());
    act(() => sockets[0]!.send({ kind: 'nonsense' }));
    expect(result.current.phase).toBe('error');
    expect(sockets[0]!.closed).toBe(true);
  });

  it('closes the socket on unmount and drops late callbacks', () => {
    const { factory, sockets } = makeFactory();
    const { result, unmount } = renderHook(() => useRunStream('run_1', factory));
    act(() => sockets[0]!.open());
    unmount();
    expect(sockets[0]!.closed).toBe(true);
    // A late frame from the torn-down socket must not throw or mutate state.
    act(() =>
      sockets[0]!.send({
        kind: 'event',
        event: envelope({ type: 'run.finished', runId: 'run_1', outcome: 'success' }),
      }),
    );
    expect(result.current.events).toHaveLength(0);
  });

  it('reconnects a fresh socket when runId changes', () => {
    const { factory, sockets } = makeFactory();
    const { result, rerender } = renderHook(({ id }) => useRunStream(id, factory), {
      initialProps: { id: 'run_1' },
    });
    act(() => sockets[0]!.open());
    rerender({ id: 'run_2' });
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toContain('run_2');
    expect(result.current.phase).toBe('connecting');
  });

  it('stays idle for a falsy runId', () => {
    const { factory, sockets } = makeFactory();
    const { result } = renderHook(() => useRunStream(null, factory));
    expect(sockets).toHaveLength(0);
    expect(result.current.phase).toBe('connecting');
  });
});
