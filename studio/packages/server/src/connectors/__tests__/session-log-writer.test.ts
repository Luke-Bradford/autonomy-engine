import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SESSION_LOG_COLUMNS, type SessionLogLine } from '@autonomy-studio/shared';
import { toCsv } from '../../util/csv.js';
import { SessionLogWriter } from '../session-log-file.js';

/**
 * #1600 OR41 C6c-1a — Copy's folder log, written a line at a time: it can run
 * to a line per skipped row, so it is never held whole. The file is the same
 * CSV Delete writes at once (`writeSessionLogFile`).
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await realpath(await mkdtemp(join(tmpdir(), 'session-log-writer-')));
  dirs.push(d);
  return d;
}

const line = (item: string, level: SessionLogLine['level'] = 'Info'): SessionLogLine => ({
  timestamp: '2026-10-21T12:00:00.000Z',
  level,
  operation: 'FileRead',
  item,
  message: 'read 3 bytes',
});
const csvOf = (lines: SessionLogLine[]) =>
  toCsv(
    SESSION_LOG_COLUMNS,
    lines.map((l) => [l.timestamp, l.level, l.operation, l.item, l.message]),
  );

describe('SessionLogWriter', () => {
  it('writes the header at once, then every line appended, as Delete’s CSV', async () => {
    const dir = await tempDir();
    const opened = await SessionLogWriter.open(dir, 'log.csv');
    if (!opened.ok) throw new Error(opened.error);
    // The header is on disk before any line, so a copy that dies leaves a file.
    expect(await readFile(join(dir, 'log.csv'), 'utf8')).toBe(csvOf([]));
    const lines = [line('a.txt'), line('=cmd|x', 'Warning'), line('b, "c".txt')];
    for (const l of lines) opened.writer.append(l);
    expect(await opened.writer.close()).toEqual({ ok: true, path: join(dir, 'log.csv') });
    // A formula-like item gets its leading `'`, and a comma or quote is quoted.
    expect(await readFile(join(dir, 'log.csv'), 'utf8')).toBe(csvOf(lines));
  });

  it('flushes once its buffer is full, so the lines are on disk before the end', async () => {
    const dir = await tempDir();
    const opened = await SessionLogWriter.open(dir, 'log.csv', { flushBytes: 100 });
    if (!opened.ok) throw new Error(opened.error);
    opened.writer.append(line('a.txt'));
    await opened.writer.flushIfFull();
    // One line is under 100 bytes: still buffered.
    expect(await readFile(join(dir, 'log.csv'), 'utf8')).toBe(csvOf([]));
    opened.writer.append(line('b.txt'));
    await opened.writer.flushIfFull();
    expect(await readFile(join(dir, 'log.csv'), 'utf8')).toBe(
      csvOf([line('a.txt'), line('b.txt')]),
    );
    await opened.writer.close();
  });

  it('never writes over a file already there', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'log.csv'), 'kept');
    const opened = await SessionLogWriter.open(dir, 'log.csv');
    expect(opened.ok).toBe(false);
    expect(await readFile(join(dir, 'log.csv'), 'utf8')).toBe('kept');
  });

  it('gives up on a write that does not finish within its bound, and reports it at close', async () => {
    // A hung mount: the write never returns.
    const hung = {
      write: () => new Promise<never>(() => {}),
      close: () => Promise.resolve(),
    };
    const writer = SessionLogWriter.over(hung, '/logs/log.csv', { timeoutMs: 50 });
    writer.append(line('a.txt'));
    const started = Date.now();
    expect(await writer.close()).toEqual({
      ok: false,
      error: 'the write took longer than 0.05 s',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('closes once: a second close is answered by the first', async () => {
    let closes = 0;
    const fh = {
      write: () => Promise.resolve(),
      close: () => {
        closes += 1;
        return closes === 1 ? Promise.resolve() : Promise.reject(new Error('EBADF'));
      },
    };
    const writer = SessionLogWriter.over(fh, '/logs/log.csv');
    expect(await writer.close()).toEqual({ ok: true, path: '/logs/log.csv' });
    expect(await writer.close()).toEqual({ ok: true, path: '/logs/log.csv' });
    expect(closes).toBe(1);
  });

  it('reports the first failed write at close, and writes nothing after it', async () => {
    const written: string[] = [];
    let calls = 0;
    const failing = {
      write: (data: string) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('ENOSPC: no space left on device'));
        written.push(data);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    };
    const writer = SessionLogWriter.over(failing, '/logs/log.csv', { flushBytes: 1 });
    writer.append(line('a.txt'));
    await writer.flushIfFull();
    writer.append(line('b.txt'));
    expect(await writer.close()).toEqual({ ok: false, error: 'ENOSPC: no space left on device' });
    expect(written).toEqual([]);
  });

  it('drains: writes what is buffered whatever its size, and answers the first failure (C6c-1b)', async () => {
    const dir = await tempDir();
    const opened = await SessionLogWriter.open(dir, 'log.csv');
    if (!opened.ok) throw new Error(opened.error);
    opened.writer.append(line('a.txt'));
    expect(await opened.writer.drain()).toBeUndefined();
    // Far under the 64 KiB flush, and on disk.
    expect(await readFile(join(dir, 'log.csv'), 'utf8')).toBe(csvOf([line('a.txt')]));
    await opened.writer.close();

    const failing = SessionLogWriter.over(
      { write: () => Promise.reject(new Error('EIO')), close: () => Promise.resolve() },
      '/logs/log.csv',
    );
    failing.append(line('b.txt'));
    expect(await failing.drain()).toBe('EIO');
  });
});
