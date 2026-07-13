/**
 * ProcessSupervisor — a cross-platform supervisor for spawning agent-CLI /
 * arbitrary subprocess workers (the `agent_cli` connector's execution seam).
 *
 * NO SURVIVE RESTART CONTRACT: a process spawned by `spawnSupervised` is a
 * direct child of THIS server process. It is never detached from the
 * server's own lifecycle — if the server exits (crash, restart, deploy), the
 * OS reclaims the child (and this module tree-kills its descendants on
 * every deliberate stop). There is no persistence layer here, no re-attach
 * on boot. A run backed by a supervised process that was in flight when the
 * server went down cannot be resumed: per the run-recovery model in
 * `docs/2026-07-12-target-architecture.md`, it must be reconciled to
 * `interrupted` on boot, not silently re-attached to some surviving PID.
 * `detached: true` below is used ONLY to give the child its own process
 * GROUP so we can reliably kill its whole subtree — it does NOT mean the
 * child can outlive the server on purpose.
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
 * Buffers a raw byte stream into complete lines (splitting on `\n`,
 * tolerating a trailing `\r`), bounded so it never grows past `maxBytes`
 * regardless of how the source behaves (no newlines, huge single line, or a
 * flood of small lines). Once the byte budget is exhausted it stops
 * retaining/emitting further data and reports `truncated`.
 */
class LineFramer {
  private partial = '';
  private emittedBytes = 0;
  private suppressed = false;
  truncated = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.suppressed) return;

    this.partial += chunk.toString('utf8');

    let newlineIndex: number;
    while ((newlineIndex = this.partial.indexOf('\n')) !== -1) {
      const raw = this.partial.slice(0, newlineIndex);
      this.partial = this.partial.slice(newlineIndex + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      this.emit(line);
      if (this.suppressed) {
        this.partial = '';
        return;
      }
    }

    // No newline found yet — guard against an unbounded single "line" (e.g.
    // a flood with no `\n`) growing the retained buffer forever.
    if (Buffer.byteLength(this.partial, 'utf8') > this.maxBytes) {
      this.truncated = true;
      this.suppressed = true;
      this.partial = '';
    }
  }

  /** Call once the source has ended to flush any trailing partial line. */
  flush(): void {
    if (this.suppressed) {
      this.partial = '';
      return;
    }
    if (this.partial.length > 0) {
      this.emit(this.partial);
      this.partial = '';
    }
  }

  private emit(line: string): void {
    this.emittedBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (this.emittedBytes > this.maxBytes) {
      this.truncated = true;
      this.suppressed = true;
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
  } catch {
    // Group already gone (ESRCH) or we lack permission to signal it —
    // fall back to signalling just the direct child.
    try {
      process.kill(pid, signal);
    } catch {
      // Already dead; nothing to do.
    }
  }
}

export function spawnSupervised(opts: SpawnSupervisedOptions): SupervisedProcess {
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
    if (pid === undefined) return;
    state[markState] = true;
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

  if (opts.signal) {
    if (opts.signal.aborted) {
      triggerKill('aborted');
    } else {
      opts.signal.addEventListener('abort', () => triggerKill('aborted'), { once: true });
    }
  }

  const stdoutFramer = new LineFramer(maxOutputBytes, (line) => {
    queue.push({ stream: 'stdout', line });
  });
  const stderrFramer = new LineFramer(maxOutputBytes, (line) => {
    queue.push({ stream: 'stderr', line });
  });

  child.stdout?.on('data', (chunk: Buffer) => stdoutFramer.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrFramer.push(chunk));

  const result: Promise<SupervisedResult> = child.then((execaResult) => {
    settled = true;
    clearTimeout(hardTimeoutTimer);
    clearTimeout(escalateTimer);

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
