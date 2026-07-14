import { useEffect, useState } from 'react';
import { RunStreamServerMessageSchema, type RunEvent } from '@autonomy-studio/shared';
import { runStreamUrl } from './runSummary';

/**
 * The live-run WebSocket lifecycle, as a hook. It opens
 * `GET /api/runs/:id/events/stream`, which streams the run's `run_events`
 * **replay-then-tail**: the whole durable log first, a one-shot
 * `replay_complete` marker, then live appends. Every frame is parsed through
 * the shared `RunStreamServerMessageSchema` (the one FE/BE contract) — a frame
 * that violates it is a real bug, surfaced as `error`, never rendered blindly.
 *
 * Correctness the view leans on:
 * - **Dedupe by `seq`**: the server already forwards each `seq` once, but a
 *   `seen` set makes replay-vs-live idempotent regardless, so no event is ever
 *   doubled. Events arrive `seq`-ascending, so the array stays ordered.
 * - **Single connection per run**: the effect is keyed on `runId`; changing it
 *   (or unmounting) closes the old socket before opening any new one, and a
 *   `disposed` guard drops any late callback from a torn-down socket so it can
 *   never `setState` after cleanup.
 * - **Terminal & auth closes**: the server closes `1000` after a terminal event
 *   (→ `closed`) and `4404` for an unknown/other-owner run (→ `error`), so a
 *   run you cannot see is indistinguishable from one that does not exist.
 */
export type StreamPhase = 'connecting' | 'replaying' | 'live' | 'closed' | 'error';

export interface RunStreamState {
  /** The run's events so far, `seq`-ascending, deduped. */
  events: RunEvent[];
  phase: StreamPhase;
  /** A human-readable reason when `phase === 'error'`. */
  error: string | undefined;
}

/** The minimal socket surface the hook drives — satisfied by the DOM
 * `WebSocket` and by a fake in tests (so no real network in jsdom). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close: () => void;
}

export type SocketFactory = (url: string) => SocketLike;

// Module-level so the default factory has a STABLE identity across renders —
// otherwise the effect's `makeSocket` dep would change every render and
// reconnect in a loop. Callers that inject a factory must likewise pass a
// stable reference (define it once, not inline per render).
// A real `WebSocket` is structurally close to `SocketLike` but its DOM event
// params (`Event`/`MessageEvent`/`CloseEvent`) are narrower than the
// `unknown`/minimal shapes the hook reads, so it is not directly assignable
// under `strictFunctionTypes`. This is the one DOM boundary — cast here; the
// hook only ever reads `ev.data` / `ev.code`, both present at runtime.
const defaultMakeSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const INITIAL: RunStreamState = { events: [], phase: 'connecting', error: undefined };

/**
 * Subscribe to a run's live event stream. Pass a falsy `runId` (e.g. before a
 * route param resolves) to stay idle. `makeSocket` is injectable for tests.
 */
export function useRunStream(
  runId: string | null | undefined,
  makeSocket: SocketFactory = defaultMakeSocket,
): RunStreamState {
  const [state, setState] = useState<RunStreamState>(INITIAL);

  useEffect(() => {
    if (!runId) {
      setState(INITIAL);
      return;
    }
    let disposed = false;
    const seen = new Set<number>();
    setState({ events: [], phase: 'connecting', error: undefined });

    let socket: SocketLike;
    try {
      socket = makeSocket(runStreamUrl(runId));
    } catch (err) {
      setState({ events: [], phase: 'error', error: toMessage(err) });
      return;
    }

    socket.onopen = () => {
      if (disposed) return;
      setState((s) => (s.phase === 'connecting' ? { ...s, phase: 'replaying' } : s));
    };

    socket.onmessage = (ev) => {
      if (disposed) return;
      let parsed;
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        parsed = RunStreamServerMessageSchema.parse(JSON.parse(raw));
      } catch (err) {
        setState((s) => ({
          ...s,
          phase: 'error',
          error: `malformed stream frame: ${toMessage(err)}`,
        }));
        try {
          socket.close();
        } catch {
          // closing a broken socket is best-effort
        }
        return;
      }
      if (parsed.kind === 'replay_complete') {
        setState((s) => (s.phase === 'error' ? s : { ...s, phase: 'live' }));
        return;
      }
      const { event } = parsed;
      if (seen.has(event.seq)) return;
      seen.add(event.seq);
      setState((s) => (s.phase === 'error' ? s : { ...s, events: [...s.events, event] }));
    };

    socket.onerror = () => {
      if (disposed) return;
      setState((s) =>
        s.phase === 'closed' || s.phase === 'error'
          ? s
          : { ...s, phase: 'error', error: s.error ?? 'stream connection error' },
      );
    };

    socket.onclose = (ev) => {
      if (disposed) return;
      setState((s) => {
        if (s.phase === 'error') return s;
        if (ev?.code === 4404) {
          return { ...s, phase: 'error', error: 'run not found or not accessible' };
        }
        return { ...s, phase: 'closed' };
      });
    };

    return () => {
      disposed = true;
      try {
        socket.close();
      } catch {
        // best-effort teardown
      }
    };
  }, [runId, makeSocket]);

  return state;
}
