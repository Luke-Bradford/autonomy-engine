import pLimit from 'p-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBounded, type BoundedStop } from '../bounded-attempt.js';

type Answer =
  | { ok: true; value: string }
  | { ok: false; stop: BoundedStop; admitted: boolean }
  | { ok: false; thrown: string };

function attempt(
  limit: ReturnType<typeof pLimit>,
  work: (signal: AbortSignal) => Promise<string>,
  options: { backstopMs?: number; signal?: AbortSignal } = {},
): Promise<Answer> {
  return runBounded<Answer>({
    limit,
    backstopMs: options.backstopMs ?? 1_000,
    signal: options.signal,
    work: async (signal) => ({ ok: true as const, value: await work(signal) }),
    onStop: (stop, admitted) => ({ ok: false as const, stop, admitted }),
    onThrow: (err) => ({ ok: false as const, thrown: String(err) }),
  });
}

/** A work body that stays pending until `release` is called. */
function hung() {
  let release!: () => void;
  const started = vi.fn();
  const done = new Promise<string>((resolve) => (release = () => resolve('late')));
  return {
    started,
    release: () => release(),
    work: (signal: AbortSignal) => {
      started(signal);
      return done;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runBounded', () => {
  it('answers with the work’s own result and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const answer = await attempt(pLimit(1), () => Promise.resolve('rows'));
    expect(answer).toEqual({ ok: true, value: 'rows' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps a thrown work body through onThrow rather than rejecting', async () => {
    const answer = await attempt(pLimit(1), () => Promise.reject(new Error('boom')));
    expect(answer).toEqual({ ok: false, thrown: 'Error: boom' });
  });

  it('answers on the backstop as admitted, and aborts the work’s signal', async () => {
    vi.useFakeTimers();
    const body = hung();
    const answer = attempt(pLimit(1), body.work, { backstopMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(await answer).toEqual({ ok: false, stop: 'backstop', admitted: true });
    expect((body.started.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    body.release();
  });

  it('keeps the slot until the work really settles, and a queued attempt answered meanwhile never starts', async () => {
    vi.useFakeTimers();
    const limit = pLimit(1);
    const first = hung();
    const second = hung();
    const firstAnswer = attempt(limit, first.work, { backstopMs: 50 });
    const secondAnswer = attempt(limit, second.work, { backstopMs: 50 });

    await vi.advanceTimersByTimeAsync(50);
    expect(await firstAnswer).toMatchObject({ stop: 'backstop', admitted: true });
    // Never admitted: the slot is still held by the hung first attempt.
    expect(await secondAnswer).toEqual({ ok: false, stop: 'backstop', admitted: false });
    expect(limit.activeCount).toBe(1);

    first.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(limit.activeCount).toBe(0);
    expect(second.started).not.toHaveBeenCalled();
  });

  it('answers a caller that leaves as cancelled, and aborts the work’s signal', async () => {
    const caller = new AbortController();
    const body = hung();
    const answer = attempt(pLimit(1), body.work, { signal: caller.signal });
    await vi.waitFor(() => expect(body.started).toHaveBeenCalled());
    caller.abort();
    expect(await answer).toEqual({ ok: false, stop: 'cancelled', admitted: true });
    expect((body.started.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    body.release();
  });

  it('never starts the work for a caller that has already gone', async () => {
    const caller = new AbortController();
    caller.abort();
    const body = hung();
    const limit = pLimit(1);
    expect(await attempt(limit, body.work, { signal: caller.signal })).toEqual({
      ok: false,
      stop: 'cancelled',
      admitted: false,
    });
    await vi.waitFor(() => expect(limit.activeCount + limit.pendingCount).toBe(0));
    expect(body.started).not.toHaveBeenCalled();
  });

  it('stops listening to the caller once answered', async () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    await attempt(pLimit(1), () => Promise.resolve('rows'), { signal: caller.signal });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('clears its timer once answered by the backstop or by the caller leaving', async () => {
    vi.useFakeTimers();
    const slow = hung();
    const backstopped = attempt(pLimit(1), slow.work, { backstopMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await backstopped;
    expect(vi.getTimerCount()).toBe(0);

    const caller = new AbortController();
    const left = hung();
    const cancelled = attempt(pLimit(1), left.work, { signal: caller.signal });
    caller.abort();
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
    slow.release();
    left.release();
  });

  it('answers a caller that leaves while queued, and that attempt never starts', async () => {
    const limit = pLimit(1);
    const holder = hung();
    const held = attempt(limit, holder.work);
    const caller = new AbortController();
    const queued = hung();
    const answer = attempt(limit, queued.work, { signal: caller.signal });
    await vi.waitFor(() => expect(holder.started).toHaveBeenCalled());
    caller.abort();
    expect(await answer).toEqual({ ok: false, stop: 'cancelled', admitted: false });
    holder.release();
    await held;
    await vi.waitFor(() => expect(limit.activeCount + limit.pendingCount).toBe(0));
    expect(queued.started).not.toHaveBeenCalled();
  });

  it('does not map a rejection that arrives after the caller was answered', async () => {
    vi.useFakeTimers();
    let reject!: (err: Error) => void;
    const onThrow = vi.fn(() => 'thrown');
    const limit = pLimit(1);
    const answer = runBounded({
      limit,
      backstopMs: 50,
      work: () => new Promise<string>((_resolve, fail) => (reject = fail)),
      onStop: () => 'stopped',
      onThrow,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(await answer).toBe('stopped');
    reject(new Error('aborted'));
    await vi.advanceTimersByTimeAsync(0);
    expect(limit.activeCount).toBe(0);
    expect(onThrow).not.toHaveBeenCalled();
  });

  it('never holds the process open for a hung attempt', () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, 'setTimeout').mockReturnValueOnce({ unref } as never);
    void attempt(pLimit(1), hung().work);
    expect(unref).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
