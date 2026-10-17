/**
 * #1600 OR41 C9c — writing a session log to a folder (activity catalogue §5):
 * one CSV file per attempt, with the columns `SESSION_LOG_COLUMNS` names. The
 * lines are collected by the shared `SessionLog`; Delete writes them here.
 *
 * The file is written once, at the end, through `atomicReplace`, under a name
 * that carries the run, node and attempt, so no two attempts share one. It is a
 * plain rename rather than `noClobber`'s `link`, which a file system without
 * hard links (FAT, exFAT, some SMB mounts) refuses. It is `util/csv.ts`'s CSV,
 * so a cell a spreadsheet would read as a formula (a file named `=cmd…`) gets a
 * leading `'`.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_LOG_COLUMNS, type SessionLogLine } from '@autonomy-studio/shared';
import { toCsv } from '../util/csv.js';
import { atomicReplace } from './fs-write.js';

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
  const csv = toCsv(
    SESSION_LOG_COLUMNS,
    lines.map((l) => [l.timestamp, l.level, l.operation, l.item, l.message]),
  );
  const signal = AbortSignal.timeout(timeoutMs);
  const write = atomicReplace(path, tmpSuffix, signal, async (fh) => {
    await fh.writeFile(csv, { encoding: 'utf8', signal });
  }).then((r): Written =>
    r === undefined
      ? { ok: true, path }
      : { ok: false, error: r.type === 'failed' ? r.error : 'the write failed' },
  );
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<Written>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `the write took longer than ${timeoutMs / 1000} s` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([write, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
