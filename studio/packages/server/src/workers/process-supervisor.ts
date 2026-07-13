/**
 * ProcessSupervisor — a cross-platform supervisor for spawning agent-CLI /
 * arbitrary subprocess workers (the `agent_cli` connector's execution seam).
 *
 * SHUTDOWN / SURVIVE-RESTART CONTRACT (read this before wiring this in):
 * - Every child is spawned with `detached: true` so it becomes the leader of
 *   its own process GROUP — that is the only way to reliably signal its
 *   whole subtree (`kill(-pid, …)`) later. A side effect of `setsid()` is
 *   that the child is NOT tied to this process's session; if this process
 *   dies with no cleanup, the child does *not* get reclaimed by the OS — it
 *   is reparented to init and keeps running. Detached does not mean
 *   self-terminating.
 * - This module is a LIBRARY, not the host process — it does NOT own
 *   `SIGTERM`/`SIGINT` or call `process.exit()`. A library that exits the
 *   process on its own signal handler would hard-terminate the whole server
 *   ahead of the host's own graceful-shutdown sequence (e.g. Fastify's
 *   `close()`/connection-drain), racing or short-circuiting it. It
 *   compensates by tracking every live supervised pid in a module-level map
 *   and exporting `reapAllSupervised()` — the HOST app MUST call this from
 *   ITS OWN graceful-shutdown sequence (e.g. a Fastify `onClose` hook,
 *   BEFORE the process actually exits) so an in-flight subprocess tree does
 *   not survive a restart/deploy. This module does not decide when the
 *   process exits; it only reaps what it's told to, when it's told to.
 * - As a last-resort backstop (NOT a substitute for the host wiring
 *   `reapAllSupervised()` into its own shutdown), this module installs one
 *   synchronous `process.on('exit', …)` handler that best-effort SIGKILLs
 *   the process GROUP of every still-live supervised child. `'exit'`
 *   handlers run synchronously while the process is already committed to
 *   exiting — they cannot be async, cannot delay or prevent the exit, and
 *   do not suppress Node's default signal handling, so installing this
 *   backstop is always safe for a library to do.
 * - Graceful shutdown (the tree actually getting reaped) happens IFF the
 *   host wires `reapAllSupervised()` into its shutdown path; the `'exit'`
 *   backstop only covers what it can catch synchronously and is
 *   best-effort, not a guarantee. A hard `SIGKILL`/panic of the server
 *   process itself is unrecoverable from in-process code — no in-process
 *   code can run once the process is killed with `SIGKILL` or the machine
 *   loses power, so any subprocess tree from an in-flight run in that
 *   scenario is orphaned and left running. That case is NOT this module's
 *   job to fix: recovering from it is the run-recovery model's problem (per
 *   `docs/2026-07-12-target-architecture.md`), reconciling any run left in
 *   `running` state to `interrupted` on the next boot, not by silently
 *   re-attaching to a surviving PID.
 */

import { execa } from 'execa';

export interface SpawnSupervisedOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Hard wall-clock timeout. Exceeding it tree-kills the process. */
  timeoutMs?: number;
  /**
   * Total bytes of line output (stdout+stderr combined) buffered/emitted
   * before the supervisor stops accumulating and marks `truncated: true`.
   * Streaming continues to be drained (so the child never blocks on a full
   * pipe) but no further `line` events are emitted and no more memory is
   * retained. Default 10 MiB.
   */
  maxOutputBytes?: number;
  /** Cancellation — aborting tree-kills the process. */
  signal?: AbortSignal;
}

export type OutputStreamName = 'stdout' | 'stderr';

export interface OutputLineEvent {
  stream: OutputStreamName;
  line: string;
}

export interface SupervisedResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** True whenever the supervisor itself sent a kill signal to the tree. */
  killed: boolean;
  truncated: boolean;
}

export interface SupervisedProcess {
  /** Line-framed stdout/stderr, in arrival order, interleaved across streams. */
  events: AsyncIterable<OutputLineEvent>;
  /** Resolves once the process (and its tree) has fully exited. */
  result: Promise<SupervisedResult>;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Grace period between SIGTERM and the SIGKILL escalation. */
const KILL_GRACE_MS = 500;

/**
 * A minimal async push/pull queue used to expose the line-framed output as
 * an `AsyncIterable`. Consumers pull with `for await`; producers `push` as
 * data arrives and `close` once the process has exited.
 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffered.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          // Non-null assertion is safe: length check above guarantees an
          // element is present.
          const value = this.buffered.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.waiting.push(resolve);
        });
      },
    };
  }
}

/**
 * A byte budget shared across two (or more) `LineFramer`s so that a combined
 * "stdout+stderr" cap is enforced as ONE ceiling rather than one per stream.
 * Without this, each framer independently allowed up to `maxBytes`, so the
 * real ceiling was ~2× the documented "combined" limit.
 */
class SharedByteBudget {
  private used = 0;
  exceeded = false;

  constructor(private readonly maxBytes: number) {}

  /**
   * Charges `bytes` against the shared total. Returns `false` (and flips
   * `exceeded` for good, across every framer sharing this budget) once the
   * combined total would exceed `maxBytes`.
   */
  tryConsume(bytes: number): boolean {
    if (this.exceeded) return false;
    this.used += bytes;
    if (this.used > this.maxBytes) {
      this.exceeded = true;
      return false;
    }
    return true;
  }

  /** Trips the budget directly, with no byte accounting (see the unbounded
   * single-line guard in `LineFramer.push`). */
  markExceeded(): void {
    this.exceeded = true;
  }
}

/**
 * Buffers a raw byte stream into complete lines (splitting on `\n`,
 * tolerating a trailing `\r`), bounded so emitted output never grows past a
 * shared byte budget regardless of how the source behaves (no newlines, huge
 * single line, or a flood of small lines). Once the budget is exhausted
 * (from this framer OR the sibling framer sharing the same budget) it stops
 * retaining/emitting further data and reports `truncated`.
 */
class LineFramer {
  private partial = '';

  constructor(
    private readonly maxBytes: number,
    private readonly budget: SharedByteBudget,
    private readonly onLine: (line: string) => void,
  ) {}

  get truncated(): boolean {
    return this.budget.exceeded;
  }

  push(chunk: Buffer): void {
    if (this.budget.exceeded) return;

    this.partial += chunk.toString('utf8');

    let newlineIndex: number;
    while ((newlineIndex = this.partial.indexOf('\n')) !== -1) {
      const raw = this.partial.slice(0, newlineIndex);
      this.partial = this.partial.slice(newlineIndex + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      this.emit(line);
      if (this.budget.exceeded) {
        this.partial = '';
        return;
      }
    }

    // No newline found yet — guard against an unbounded single "line" (e.g.
    // a flood with no `\n`) growing the retained buffer forever. This check
    // runs AFTER the chunk has already been appended above, so `partial` can
    // transiently overshoot `maxBytes` by up to one stream chunk (Node's
    // default highWaterMark, ~64 KiB) before being cleared here — bounded
    // and acceptable, not a hard cap.
    if (Buffer.byteLength(this.partial, 'utf8') > this.maxBytes) {
      this.budget.markExceeded();
      this.partial = '';
    }
  }

  /** Call once the source has ended to flush any trailing partial line. */
  flush(): void {
    if (this.budget.exceeded) {
      this.partial = '';
      return;
    }
    if (this.partial.length > 0) {
      this.emit(this.partial);
      this.partial = '';
    }
  }

  private emit(line: string): void {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (!this.budget.tryConsume(bytes)) {
      return;
    }
    this.onLine(line);
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs no-op existence/permission checks only.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tree-kills the process rooted at `pid`. On POSIX, `pid` must be the
 * leader of its own process group (spawned with `detached: true`); sending
 * the signal to `-pid` reaches every descendant in that group, including
 * children the worker itself spawned. On Windows, `taskkill /T /F` walks
 * the process tree explicitly since there is no process-group equivalent.
 */
async function killTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { reject: false });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // The process group is already gone — there is nothing left to
      // signal, so this is a successful (no-op) tree-kill.
      return;
    }
    // Anything else (most commonly EPERM) means we could not reach the
    // group and do NOT know whether descendants are still alive. We
    // deliberately do NOT fall back to `process.kill(pid, signal)` here:
    // that would only reach the direct child while silently reporting
    // "killed", leaving any grandchildren running under a false sense of
    // success. Best-effort and non-fatal (this is fired-and-forgotten by
    // callers), but surfaced loudly so it isn't mistaken for a clean kill.
    console.error(
      `killTree: failed to signal process group -${pid} with ${signal} ` +
        `(${code ?? 'unknown error'}); descendants may still be running`,
    );
  }
}

/** Live pids currently under supervision, keyed by pid, with a callback to
 * mark that spawn's own result as "killed" when reaped via
 * `reapAllSupervised` (a graceful-shutdown reap, not a timeout/abort). */
const liveSupervised = new Map<number, { markKilled: () => void }>();

let shutdownHandlersInstalled = false;

/**
 * Registers the process-level `'exit'` backstop exactly once (across
 * however many times `spawnSupervised` is called). This module does NOT
 * install `SIGTERM`/`SIGINT` handlers and does NOT call `process.exit()` —
 * see the module-level contract doc for why a library must not own process
 * exit. The HOST app is responsible for calling `reapAllSupervised()` from
 * its own graceful-shutdown sequence; this backstop only covers whatever
 * that reap couldn't finish (or wasn't given the chance to run) before the
 * event loop drains.
 */
function installShutdownHandlersOnce(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  // 'exit' handlers must be synchronous, cannot prevent the process from
  // exiting, and do not suppress Node's default signal handling — so this
  // is always safe for a library to install. Best-effort SIGKILL straight
  // to each live process group; no waiting for grace periods.
  process.on('exit', () => {
    for (const pid of liveSupervised.keys()) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Best-effort; nothing more we can do synchronously during exit.
      }
    }
  });
}

/**
 * Best-effort tree-kill of every currently-supervised child: SIGTERM, a
 * grace period, then SIGKILL for anything still alive. This is the
 * deliberate graceful-shutdown reap.
 *
 * THE HOST APP MUST CALL THIS from its own graceful-shutdown sequence
 * (e.g. a Fastify `onClose` hook, or its own `SIGTERM`/`SIGINT` handler)
 * BEFORE the process actually exits — this module deliberately does NOT
 * install its own `SIGTERM`/`SIGINT` handlers or call `process.exit()` (see
 * the module-level contract doc: a library must not own process exit, and
 * must not swallow the default terminate-on-signal behaviour either). If
 * the host never wires this in, only the synchronous best-effort `'exit'`
 * backstop applies, and a hard `SIGKILL`/panic of the server process itself
 * is unrecoverable from in-process code either way — that case reconciles
 * via the boot-time run-recovery reconciler (`running` → `interrupted`),
 * not via this function.
 */
export async function reapAllSupervised(): Promise<void> {
  const entries = Array.from(liveSupervised.entries());
  if (entries.length === 0) return;

  for (const [, entry] of entries) entry.markKilled();

  await Promise.all(entries.map(([pid]) => killTree(pid, 'SIGTERM')));
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
  await Promise.all(
    entries.map(([pid]) => (isAlive(pid) ? killTree(pid, 'SIGKILL') : Promise.resolve())),
  );
}

export function spawnSupervised(opts: SpawnSupervisedOptions): SupervisedProcess {
  installShutdownHandlersOnce();

  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const queue = new AsyncEventQueue<OutputLineEvent>();

  const state = {
    timedOut: false,
    aborted: false,
    killed: false,
    truncated: false,
  };

  const child = execa(opts.command, opts.args ?? [], {
    cwd: opts.cwd,
    env: opts.env,
    // Detached so the child becomes the leader of its own process group —
    // required for the `-pid` tree-kill below. See the "no survive
    // restart" doc comment at the top of this file.
    detached: process.platform !== 'win32',
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // We do our own bounded line-framing; don't let execa additionally
    // accumulate the full output in memory.
    buffer: false,
    reject: false,
    windowsHide: true,
  });

  const pid = child.pid;

  let settled = false;
  let escalateTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

  function triggerKill(markState: 'timedOut' | 'aborted'): void {
    if (settled) return;
    if (pid === undefined) return;
    state[markState] = true;
    // A kill is already in flight (from the other trigger, e.g. both the
    // timeout and an abort firing close together) — don't reschedule the
    // escalate timer, that would leave the first one to fire as a stray.
    if (state.killed) return;
    state.killed = true;
    void killTree(pid, 'SIGTERM');
    escalateTimer = setTimeout(() => {
      if (!settled && isAlive(pid)) {
        void killTree(pid, 'SIGKILL');
      }
    }, KILL_GRACE_MS);
  }

  if (opts.timeoutMs !== undefined) {
    hardTimeoutTimer = setTimeout(() => triggerKill('timedOut'), opts.timeoutMs);
  }

  let onAbort: (() => void) | undefined;
  if (opts.signal) {
    if (opts.signal.aborted) {
      triggerKill('aborted');
    } else {
      onAbort = () => triggerKill('aborted');
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  if (pid !== undefined) {
    liveSupervised.set(pid, {
      markKilled: () => {
        state.killed = true;
      },
    });
  }

  const outputBudget = new SharedByteBudget(maxOutputBytes);
  const stdoutFramer = new LineFramer(maxOutputBytes, outputBudget, (line) => {
    queue.push({ stream: 'stdout', line });
  });
  const stderrFramer = new LineFramer(maxOutputBytes, outputBudget, (line) => {
    queue.push({ stream: 'stderr', line });
  });

  child.stdout?.on('data', (chunk: Buffer) => stdoutFramer.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrFramer.push(chunk));

  const result: Promise<SupervisedResult> = child.then((execaResult) => {
    settled = true;
    clearTimeout(hardTimeoutTimer);
    clearTimeout(escalateTimer);
    // A long-lived, shared AbortSignal (e.g. one cancellation controller
    // spanning many spawns) would otherwise accumulate a listener per call
    // that never fires — remove ours as soon as this spawn settles.
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    if (pid !== undefined) liveSupervised.delete(pid);

    stdoutFramer.flush();
    stderrFramer.flush();
    queue.close();

    return {
      exitCode: execaResult.exitCode ?? null,
      signal: (execaResult.signal as NodeJS.Signals | undefined) ?? null,
      timedOut: state.timedOut,
      aborted: state.aborted,
      killed: state.killed,
      truncated: stdoutFramer.truncated || stderrFramer.truncated,
    };
  });

  return { events: queue, result };
}
