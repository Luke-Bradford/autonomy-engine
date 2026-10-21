/**
 * #1600 OR41 C9c — writing a session log to a folder (activity catalogue §5):
 * one CSV file per attempt, with the columns `SESSION_LOG_COLUMNS` names. The
 * lines are collected by the shared `SessionLog`; Delete writes them here, and
 * Copy streams them through `SessionLogWriter` (C6c-1a, below).
 *
 * The file is written once, at the end, through `atomicReplace`, under a name
 * that carries the run, node and attempt, so no two attempts share one. It is a
 * plain rename rather than `noClobber`'s `link`, which a file system without
 * hard links (FAT, exFAT, some SMB mounts) refuses. It is `util/csv.ts`'s CSV,
 * so a cell a spreadsheet would read as a formula (a file named `=cmd…`) gets a
 * leading `'`.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_LOG_COLUMNS, type SessionLogLine } from '@autonomy-studio/shared';
import { CSV_BOM, csvLine, toCsv, type CsvValue } from '../util/csv.js';
import { O_NOFOLLOW, resolveWithinRootsOrMissing } from './confine.js';
import { direntType, lstatOrNull } from './fs-select.js';
import { atomicReplace, closeQuietly } from './fs-write.js';

/**
 * How long the write may take. It also runs after a cancel or timeout, so it
 * has its own bound rather than the attempt's signal: a hung mount must not
 * hold a cancelled attempt open. `open`, `sync` and `rename` take no signal, so
 * the bound is a race. A write still under way when it passes is reported as
 * failed; it removes its own temp if it then fails, as `atomicReplace` always
 * does, and its file appears if it then succeeds.
 */
export const SESSION_LOG_WRITE_TIMEOUT_MS = 10_000;

/** The longest file name, in bytes, that the common file systems accept. */
const NAME_MAX_BYTES = 255;

/**
 * The file name of an attempt's log, from `makeTmpSuffix`'s unique suffix. A
 * suffix too long for a file name (a long node id) is hashed instead, so the
 * write cannot fail on the name after the deletes.
 */
export function sessionLogFileName(suffix: string): string {
  const name = `session-log.${suffix}.csv`;
  if (Buffer.byteLength(name) <= NAME_MAX_BYTES) return name;
  return `session-log.${createHash('sha256').update(suffix).digest('hex').slice(0, 40)}.csv`;
}

type Written = { ok: true; path: string } | { ok: false; error: string };

/**
 * Write `lines` to `<dir>/<name>`. `dir` is canonical and already confined
 * (`fs-delete.ts` resolves it within the connection's roots).
 */
export async function writeSessionLogFile(
  dir: string,
  name: string,
  tmpSuffix: string,
  lines: readonly SessionLogLine[],
  timeoutMs: number = SESSION_LOG_WRITE_TIMEOUT_MS,
): Promise<Written> {
  const path = join(dir, name);
  const csv = toCsv(SESSION_LOG_COLUMNS, lines.map(sessionLogRow));
  const signal = AbortSignal.timeout(timeoutMs);
  const write = atomicReplace(path, tmpSuffix, signal, async (fh) => {
    await fh.writeFile(csv, { encoding: 'utf8', signal });
  }).then((r): Written =>
    r === undefined
      ? { ok: true, path }
      : { ok: false, error: r.type === 'failed' ? r.error : 'the write failed' },
  );
  try {
    return await bounded(write, timeoutMs, 'the write');
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/** One line's cells, in `SESSION_LOG_COLUMNS`' order: both writers' row. */
function sessionLogRow(line: SessionLogLine): CsvValue[] {
  return [line.timestamp, line.level, line.operation, line.item, line.message];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Checked = { ok: true; dir: string } | { ok: false; error: string };

/**
 * #1600 OR41 C6c-1a — the log folder, checked before the activity does
 * anything: within the connection's roots, there, a folder, and writable. Its
 * canonical path on success. Delete's checks (C9c), shared with Copy's. A throw
 * (a cancel, an I/O error) is the caller's to classify.
 */
export async function checkSessionLogFolder(
  roots: readonly string[],
  folder: string,
): Promise<Checked> {
  const resolved = await resolveWithinRootsOrMissing(roots, folder, 'fs');
  if (!resolved.ok) return { ok: false, error: `the log folder: ${resolved.error}` };
  const st = await lstatOrNull(resolved.path);
  if (st === null || direntType(st) !== 'directory') {
    return {
      ok: false,
      error: `the log folder '${folder}' ${st === null ? 'does not exist' : 'is not a folder'}`,
    };
  }
  // The log is written after the work starts, so a folder it cannot write to
  // is refused now, before anything is done.
  try {
    await access(resolved.path, fsConstants.W_OK);
  } catch {
    return { ok: false, error: `the log folder '${folder}' is not writable` };
  }
  return { ok: true, dir: await realpath(resolved.path) };
}

/** The part of a file handle the writer uses, so a test can hang or fail it. */
interface LogHandle {
  write(data: string): Promise<unknown>;
  close(): Promise<void>;
}

/** How much the writer buffers before it writes: a write per 64 KiB, not per line. */
const SESSION_LOG_FLUSH_BYTES = 64 * 1024;

type WriterOptions = { timeoutMs?: number; flushBytes?: number };

/**
 * `work`, or an error naming `what` once `timeoutMs` passes. The loser is left
 * to settle: `open`, `write`, `sync`, `rename` and `close` take no signal, so a
 * bound on a hung mount can only be a race.
 */
async function bounded<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} took longer than ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * #1600 OR41 C6c-1a — a session log written as it is kept, for Copy, whose log
 * can run to a line per skipped row (§4.1): one CSV file per attempt, in
 * `writeSessionLogFile`'s format, under the attempt's own name.
 *
 * Written to its FINAL name as it goes, not a temp renamed at the end: the
 * name is the attempt's own and created exclusively, so nothing is ever
 * overwritten, and a server that dies mid-copy leaves the lines written so far
 * rather than an orphaned temp. The header is written at open. Lines are
 * buffered and written in order, one write at a time, once
 * `SESSION_LOG_FLUSH_BYTES` are held (`flushIfFull`, which the activity awaits
 * between items, so a slow mount holds the copy back rather than the buffer
 * growing) and at `close`.
 *
 * Each write has `SESSION_LOG_WRITE_TIMEOUT_MS`, as Delete's does, so a hung
 * mount cannot hold a cancelled attempt open. The first failure is kept: no
 * later line is written, and `close` reports it.
 */
export class SessionLogWriter {
  private buffer: string[] = [];
  private bytes = 0;
  private chain: Promise<void> = Promise.resolve();
  private error: string | undefined;
  private closing: Promise<Written> | undefined;
  private readonly timeoutMs: number;
  private readonly flushBytes: number;

  private constructor(
    private readonly fh: LogHandle,
    readonly path: string,
    opts: WriterOptions,
  ) {
    this.timeoutMs = opts.timeoutMs ?? SESSION_LOG_WRITE_TIMEOUT_MS;
    this.flushBytes = opts.flushBytes ?? SESSION_LOG_FLUSH_BYTES;
  }

  /** Create `<dir>/<name>` (never over a file there) and write its header. */
  static async open(
    dir: string,
    name: string,
    opts: WriterOptions = {},
  ): Promise<{ ok: true; writer: SessionLogWriter } | { ok: false; error: string }> {
    const path = join(dir, name);
    const timeoutMs = opts.timeoutMs ?? SESSION_LOG_WRITE_TIMEOUT_MS;
    const opening = open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o644,
    );
    // A file this created and could not start is removed, never left empty.
    const discard = () => unlink(path).catch(() => undefined);
    let fh: Awaited<typeof opening>;
    try {
      fh = await bounded(opening, timeoutMs, 'opening the log');
    } catch (err) {
      // An open that finishes after the bound is closed and removed, never leaked.
      void opening.then(
        (late) => closeQuietly(late).then(discard),
        () => undefined,
      );
      return { ok: false, error: errorText(err) };
    }
    const writer = new SessionLogWriter(fh, path, opts);
    writer.buffer.push(CSV_BOM + csvLine(SESSION_LOG_COLUMNS));
    await writer.flush();
    if (writer.error !== undefined) {
      await closeQuietly(fh);
      await discard();
      return { ok: false, error: writer.error };
    }
    return { ok: true, writer };
  }

  /** A writer over `fh`: the test seam for a write that hangs or fails. */
  static over(fh: LogHandle, path: string, opts: WriterOptions = {}): SessionLogWriter {
    return new SessionLogWriter(fh, path, opts);
  }

  /** Buffer one line. Nothing is written here: `flushIfFull` and `close` write. */
  append(line: SessionLogLine): void {
    if (this.error !== undefined || this.closing !== undefined) return;
    const row = csvLine(sessionLogRow(line));
    this.buffer.push(row);
    this.bytes += Buffer.byteLength(row);
  }

  /**
   * The first write that failed, once one has: the activity stops rather than
   * carry on with a log it asked for and is no longer getting.
   */
  get failure(): string | undefined {
    return this.error;
  }

  /** Write the buffer once it holds `flushBytes`. */
  async flushIfFull(): Promise<void> {
    if (this.bytes >= this.flushBytes) await this.flush();
  }

  /** Write what is buffered, after every earlier write. */
  private flush(): Promise<void> {
    const data = this.buffer.join('');
    this.buffer = [];
    this.bytes = 0;
    if (data === '') return this.chain;
    this.chain = this.chain.then(async () => {
      if (this.error !== undefined) return;
      const writing = this.fh.write(data);
      try {
        await bounded(writing, this.timeoutMs, 'the write');
      } catch (err) {
        // A write still under way when the bound passes is left to settle.
        writing.catch(() => undefined);
        this.error = errorText(err);
      }
    });
    return this.chain;
  }

  /**
   * Write the rest and close the file: its path, or the first failure. Once:
   * a second call is answered by the first, so a terminal and a `finally`
   * can both ask.
   */
  close(): Promise<Written> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<Written> {
    await this.flush();
    const closing = this.fh.close();
    try {
      await bounded(closing, this.timeoutMs, 'closing the log');
    } catch (err) {
      closing.catch(() => undefined);
      this.error ??= errorText(err);
    }
    return this.error === undefined
      ? { ok: true, path: this.path }
      : { ok: false, error: this.error };
  }
}
