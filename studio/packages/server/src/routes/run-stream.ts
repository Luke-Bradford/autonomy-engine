import type { FastifyPluginAsync } from 'fastify';
import { TERMINAL_RUN_EVENT } from '@autonomy-studio/shared';
import type { RunEvent, RunStreamServerMessage } from '@autonomy-studio/shared';
import { getRun, listRunEvents } from '../repo/index.js';
import { requireOwned } from './util.js';

/**
 * P6 — the live run monitor's server half: a per-run WebSocket that streams a
 * run's `run_events` log, replay-then-tail, so the web canvas can watch a run
 * unfold. Read-only (the client sends nothing); the wire vocabulary is the
 * shared `RunStreamServerMessageSchema`.
 *
 * LATE-JOINER CORRECTNESS (the load-bearing property). On connect the handler:
 *   1. SUBSCRIBES to the in-process bus FIRST (buffering live appends);
 *   2. REPLAYS the durable log from the DB (a synchronous read — with no `await`
 *      between (1) and (2), and Node single-threaded + appends synchronous, no
 *      append can interleave, so the snapshot is a clean prefix);
 *   3. flushes the buffer, forwarding only events with `seq` beyond the replay.
 * The monotonic per-run `seq` is the dedupe key end to end: an event that was in
 * the snapshot AND also arrived live (a connect racing an append) is sent once.
 *
 * DEBOUNCE. Live events are coalesced into ~100ms batches (per the architecture:
 * "debounced ~100ms") so a chatty run (many `node.output` chunks) doesn't wake
 * the client per event. A terminal event (`run.finished`/`run.interrupted`)
 * closes the socket cleanly (1000) once flushed — the run can produce no more.
 *
 * AUTH. The socket is authorized exactly like the REST run routes: the run must
 * exist AND be owned by the request principal, else the same not-found outcome
 * (a 4404 close) — a run under another owner is never observable over the wire.
 */

/** Coalescing window for LIVE events (replay is flushed immediately). */
const DEBOUNCE_MS = 100;

/**
 * `ws` readyState OPEN. Compared as a literal (the standard WebSocket value) so
 * this module needs no value import of `ws` (a transitive dep of the plugin).
 */
const WS_OPEN = 1;

/** Application close code (4000–4999) for an unauthorized / unknown run. */
const CLOSE_NOT_FOUND = 4404;
/** Normal closure once a terminal event has been delivered. */
const CLOSE_NORMAL = 1000;

/**
 * Whether a durable envelope carries the run's terminal fact (the stream then
 * closes). `TERMINAL_RUN_EVENT` is the engine's SSOT for that set (#443); the
 * envelope's `type` column mirrors its payload's, so widen to `string` to test it
 * — the same pattern `TERMINAL_RUN`'s callers use.
 */
function isTerminalEvent(event: RunEvent): boolean {
  return (TERMINAL_RUN_EVENT as ReadonlySet<string>).has(event.type);
}

export const runStreamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    '/api/runs/:id/events/stream',
    { websocket: true },
    (socket, request) => {
      const { db, runEventBus } = fastify;
      const runId = request.params.id;

      // Authorize like every by-id run route: exists AND owned, else the same
      // not-found outcome — never reveal another owner's run over the socket.
      // Any read fault is treated as not-found too (fail closed).
      try {
        requireOwned(getRun(db, runId), request.principal, 'run', runId);
      } catch {
        socket.close(CLOSE_NOT_FOUND, 'run not found');
        return;
      }

      let closed = false;
      let seen = -1; // highest `seq` already forwarded to the client
      let terminalSent = false;
      const pending: RunEvent[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      const send = (msg: RunStreamServerMessage): void => {
        if (closed || socket.readyState !== WS_OPEN) return;
        // `send` runs from a bare `setTimeout(flush)` callback (no ambient
        // try/catch), so a throw here would be an UNCAUGHT exception, not a
        // handled per-connection fault. `JSON.stringify` cannot throw on a
        // validated envelope, but a broken/half-closed `socket.send` can — so
        // isolate it: tear this tail down rather than crash the process.
        try {
          socket.send(JSON.stringify(msg));
        } catch (err) {
          fastify.log.warn({ err, runId }, 'run-events WS send failed; tearing down tail');
          teardown();
        }
      };

      const teardown = (): void => {
        if (closed) return;
        closed = true;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        unsubscribe();
      };

      const closeNormally = (): void => {
        // Snapshot before teardown flips `closed` (which would gate `send`), then
        // close the raw socket cleanly.
        teardown();
        socket.close(CLOSE_NORMAL, 'run finished');
      };

      const flush = (): void => {
        flushTimer = null;
        if (closed || pending.length === 0) return;
        // Sort + dedupe by `seq`; forward only what the client has not seen (from
        // the replay or an earlier live batch), so a connect-racing-append event
        // that was also in the snapshot is never sent twice.
        pending.sort((a, b) => a.seq - b.seq);
        const batch = pending.splice(0);
        for (const event of batch) {
          if (event.seq <= seen) continue;
          send({ kind: 'event', event });
          seen = event.seq;
          if (isTerminalEvent(event)) terminalSent = true;
        }
        if (terminalSent) closeNormally();
      };

      const scheduleFlush = (): void => {
        if (closed || flushTimer !== null) return;
        flushTimer = setTimeout(flush, DEBOUNCE_MS);
      };

      // 1. Subscribe FIRST: from here on every append is buffered, so the replay
      //    below is a consistent prefix and no live event slips through the gap.
      const unsubscribe = runEventBus.subscribe(runId, (event) => {
        pending.push(event);
        scheduleFlush();
      });

      // 2. Replay the durable log (synchronous; no append can interleave — see
      //    the module doc). Anything appended DURING the async sends here is
      //    already captured in `pending` and seq-filtered by the flush below.
      const snapshot = listRunEvents(db, runId);
      for (const event of snapshot) {
        send({ kind: 'event', event });
        seen = event.seq;
        if (isTerminalEvent(event)) terminalSent = true;
      }
      send({ kind: 'replay_complete', throughSeq: seen });

      // 3. If the run was already terminal in the log, there is nothing to tail.
      if (terminalSent) {
        closeNormally();
        return;
      }

      // Attach lifecycle handlers BEFORE draining the buffer: a client that
      // disconnected mid-replay must still trigger teardown.
      socket.on('close', teardown);
      socket.on('error', teardown);

      // Drain anything the subscriber buffered during replay, then tail live.
      if (pending.length > 0) flush();
    },
  );
};
