import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../fs-write.js', async (importActual) => ({
  ...(await importActual<typeof import('../fs-write.js')>()),
  atomicReplace: vi.fn(),
}));
import { atomicReplace } from '../fs-write.js';
import { sessionLogFileName, writeSessionLogFile } from '../session-log-file.js';

/**
 * #1600 OR41 C9c — the folder log's own bounds: a write that hangs is given up
 * on, and a name too long for a file system is hashed. The real writes are in
 * `fs-delete-session-log.test.ts`.
 */
afterEach(() => vi.mocked(atomicReplace).mockReset());

describe('writeSessionLogFile', () => {
  it('gives up on a write that does not finish within its bound', async () => {
    // A hung mount: `open` never returns.
    vi.mocked(atomicReplace).mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    expect(await writeSessionLogFile('/logs', 'x.csv', 's', [], 50)).toEqual({
      ok: false,
      error: 'the write took longer than 0.05 s',
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports the path once the write is done', async () => {
    vi.mocked(atomicReplace).mockResolvedValue(undefined);
    expect(await writeSessionLogFile('/logs', 'x.csv', 's', [], 50)).toEqual({
      ok: true,
      path: '/logs/x.csv',
    });
  });
});

describe('sessionLogFileName', () => {
  it('names the attempt, and hashes a suffix too long for a file name', () => {
    expect(sessionLogFileName('run_1.n1.n1_0')).toBe('session-log.run_1.n1.n1_0.csv');
    const long = sessionLogFileName(`run_1.${'n'.repeat(300)}.a`);
    expect(long).toMatch(/^session-log\.[0-9a-f]{40}\.csv$/);
    expect(sessionLogFileName(`run_1.${'n'.repeat(300)}.b`)).not.toBe(long);
  });
});
