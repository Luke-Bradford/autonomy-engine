import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';

// Mock `node:fs/promises` but pass every export straight through to the real
// implementation — only `rename` and `open` become spies (real-behaving
// `vi.fn`s). A single test injects an `EXDEV` rejection through `rename` to
// exercise `doMove`'s cross-filesystem branch, and the atomic-write tests wrap
// `open` once to return a REAL handle whose `sync`/`close` rejects — both are
// modes a single-temp-dir test cannot otherwise stage. Every other call (and
// every other test) still hits the real filesystem.
vi.mock('node:fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fsAdapter } from '../fs.js';
import type { ActivityContext, ActivityEvent } from '../types.js';

async function drain(iter: AsyncIterable<ActivityEvent>): Promise<ActivityEvent[]> {
  const out: ActivityEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

// `fs` is credential-less, so every call passes the required `secret` arg as
// `null` (and no `secretFields`). This wrapper keeps the call sites terse.
function invoke(c: ActivityContext): AsyncIterable<ActivityEvent> {
  return fsAdapter.runActivity(c, null);
}

// A canonical (realpath'd) temp root per test — os.tmpdir() is itself a symlink
// on macOS (/var → /private/var), so canonicalise up front to compare like-for-like.
let root: string;
let outside: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fs-conn-root-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'fs-conn-out-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function ctx(
  activityType: string,
  input: Record<string, unknown>,
  over: Partial<ActivityContext> = {},
): ActivityContext {
  return {
    runId: 'run_1',
    nodeId: 'n1',
    attemptId: 'n1#0',
    activityType,
    input,
    connectionConfig: over.connectionConfig ?? { roots: [root] },
    signal: over.signal ?? new AbortController().signal,
  };
}

describe('fs connector — happy paths', () => {
  it('file_read returns the file content and the canonical path', async () => {
    await writeFile(join(root, 'note.txt'), 'hello fs', 'utf8');
    const events = await drain(invoke(ctx('file_read', { path: 'note.txt' })));
    expect(events).toEqual([
      { type: 'succeeded', outputs: { content: 'hello fs', path: join(root, 'note.txt') } },
    ]);
  });

  it('file_write writes the content and returns bytesWritten + path', async () => {
    const events = await drain(invoke(ctx('file_write', { path: 'out.txt', content: 'café' })));
    // 'café' is 5 UTF-8 bytes (é = 2 bytes) — bytesWritten is byte length, not char length.
    expect(events).toEqual([
      { type: 'succeeded', outputs: { bytesWritten: 5, path: join(root, 'out.txt') } },
    ]);
    expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('café');
  });

  it('file_write overwrites (truncates) an existing file', async () => {
    await writeFile(join(root, 'x.txt'), 'the old much longer content', 'utf8');
    await drain(invoke(ctx('file_write', { path: 'x.txt', content: 'new' })));
    expect(await readFile(join(root, 'x.txt'), 'utf8')).toBe('new');
  });

  it('file_write leaves no temp file behind on success (atomic rename)', async () => {
    await drain(invoke(ctx('file_write', { path: 'atomic.txt', content: 'done' })));
    const entries = await readdir(root);
    expect(entries).toEqual(['atomic.txt']); // the temp was renamed away, not orphaned
  });

  it('a write whose rename fails (target is a directory) fails and cleans up the temp', async () => {
    // Renaming the temp over an existing directory throws (EISDIR) — the write
    // must report a FAILURE (never a false success) and leave no orphan temp,
    // exercising the same catch+cleanup path the propagated close-error uses.
    await mkdir(join(root, 'adir'));
    const events = await drain(invoke(ctx('file_write', { path: 'adir', content: 'x' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(await readdir(root)).toEqual(['adir']); // temp cleaned up
  });

  it('file_write into an existing subdirectory succeeds', async () => {
    await mkdir(join(root, 'sub'));
    const events = await drain(invoke(ctx('file_write', { path: 'sub/a.txt', content: 'hi' })));
    expect(events[0]!.type).toBe('succeeded');
    expect(await readFile(join(root, 'sub/a.txt'), 'utf8')).toBe('hi');
  });

  it('a relative path resolves against the FIRST root when several are configured', async () => {
    await writeFile(join(root, 'r.txt'), 'first-root', 'utf8');
    const events = await drain(
      invoke(ctx('file_read', { path: 'r.txt' }, { connectionConfig: { roots: [root, outside] } })),
    );
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { content: 'first-root' } });
  });

  it('an absolute path INSIDE a root is allowed', async () => {
    await writeFile(join(root, 'abs.txt'), 'abs', 'utf8');
    const events = await drain(invoke(ctx('file_read', { path: join(root, 'abs.txt') })));
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { content: 'abs' } });
  });

  it('a root of `/` (the filesystem root) permits any absolute path under it', async () => {
    // `realpath('/')` === '/', which already ends in the separator — the
    // containment check must NOT append another sep (that would make '//' and
    // reject everything). Reads this test's OWN temp file, which lives under `/`.
    await writeFile(join(root, 'slash.txt'), 'ok', 'utf8');
    const events = await drain(
      invoke(
        ctx('file_read', { path: join(root, 'slash.txt') }, { connectionConfig: { roots: ['/'] } }),
      ),
    );
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { content: 'ok' } });
  });
});

describe('fs connector — path-traversal + symlink guard (security)', () => {
  it('a lexical `..` escape into a real out-of-roots dir is refused as permanent', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
    // A relative path that climbs out of `root` into the sibling `outside` dir.
    // `path.resolve` collapses the `..` BEFORE the containment check, and the
    // out-of-roots parent exists, so the guard reaches (and fails) containment.
    const escape = relative(root, join(outside, 'secret.txt'));
    const events = await drain(invoke(ctx('file_read', { path: escape })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it('an absolute path OUTSIDE the roots is refused as permanent', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
    const events = await drain(invoke(ctx('file_read', { path: join(outside, 'secret.txt') })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it('a target that is a symlink pointing OUTSIDE the roots is not followed (read)', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const events = await drain(invoke(ctx('file_read', { path: 'link.txt' })));
    // The lstat symlink guard (+ O_NOFOLLOW defence-in-depth) refuses the target
    // symlink → permanent, never the secret behind it.
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { outputs?: unknown }).outputs).toBeUndefined();
  });

  it('a WRITE through a target symlink pointing outside does NOT escape (B1)', async () => {
    await writeFile(join(outside, 'victim.txt'), 'original', 'utf8');
    await symlink(join(outside, 'victim.txt'), join(root, 'link.txt'));
    const events = await drain(invoke(ctx('file_write', { path: 'link.txt', content: 'PWNED' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The out-of-roots file was NOT overwritten.
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('original');
  });

  it('an INTERMEDIATE symlink into an out-of-roots dir is refused (parent realpath)', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
    await symlink(outside, join(root, 'escape')); // root/escape -> outside dir
    const events = await drain(invoke(ctx('file_read', { path: 'escape/secret.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });
});

describe('fs connector — failure classification', () => {
  it('reading a missing file is permanent (ENOENT)', async () => {
    const events = await drain(invoke(ctx('file_read', { path: 'nope.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('reading a directory is permanent (not a regular file)', async () => {
    await mkdir(join(root, 'adir'));
    const events = await drain(invoke(ctx('file_read', { path: 'adir' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/not a regular file/);
  });

  it('reading a file over the byte cap is permanent', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(50), 'utf8');
    const events = await drain(
      invoke(
        ctx(
          'file_read',
          { path: 'big.txt' },
          { connectionConfig: { roots: [root], maxBytes: 10 } },
        ),
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/read limit/);
  });

  it('writing where the parent directory does not exist is permanent (no recursive mkdir)', async () => {
    const events = await drain(
      invoke(ctx('file_write', { path: 'missing/dir/a.txt', content: 'hi' })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  // #575 — atomicReplace fsyncs then CLOSES the temp BEFORE the rename and lets a
  // sync/close error PROPAGATE (unlike the read/cleanup path's quiet close): a
  // delayed-write/ENOSPC failure surfaced only at `sync()`/`close()` (a real
  // POSIX/NFS mode) means the temp is INCOMPLETE, so the write must FAIL and NOT
  // rename a corrupt temp over the target. We stage that mode by wrapping `open`
  // once so the returned REAL handle's `sync`/`close` rejects — everything else
  // (temp creation, write, cleanup) is real filesystem I/O. Each test seeds the
  // target with known content first and asserts it is UNCHANGED: the regression
  // this guards is precisely "renamed a corrupt temp over valid data", which a
  // non-pre-existing target could not detect.
  // Both failure modes (sync-time vs close-time) share identical
  // seed/invoke/assert scaffolding; only the throwing method on the real handle
  // differs. `install` stages that one difference on the handle the wrapped
  // `open` returns; everything else (temp creation, write, cleanup) is real I/O.
  it.each<{ name: string; install: (fh: FileHandle) => void }>([
    {
      name: 'fh.sync() throws',
      install: (fh) => {
        fh.sync = vi.fn(async () => {
          throw Object.assign(new Error('simulated fsync failure'), { code: 'EIO' });
        });
      },
    },
    {
      name: 'fh.close() throws before rename',
      install: (fh) => {
        const realClose = fh.close.bind(fh);
        fh.close = vi.fn(async () => {
          // Free the real fd first (so the test leaks nothing), THEN surface the
          // close-time error the way a delayed-write flush failure would.
          await realClose();
          throw Object.assign(new Error('simulated close-time flush failure'), { code: 'EIO' });
        });
      },
    },
  ])(
    'a write whose $name propagates it: no false success, target untouched, temp cleaned',
    async ({ install }) => {
      const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      await writeFile(join(root, 'out.txt'), 'original', 'utf8');
      vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof realFs.open>) => {
        const fh = await realFs.open(...args);
        install(fh);
        return fh;
      });
      const events = await drain(
        invoke(ctx('file_write', { path: 'out.txt', content: 'CORRUPT' })),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('failed'); // NOT a false `succeeded`
      expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('original'); // never renamed over
      expect(await readdir(root)).toEqual(['out.txt']); // incomplete temp unlinked
    },
  );

  it('an aborted signal yields cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await drain(
      invoke(ctx('file_read', { path: 'note.txt' }, { signal: ac.signal })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'cancelled' });
  });

  it('an invalid connection config (relative root) is permanent', async () => {
    const events = await drain(
      invoke(
        ctx('file_read', { path: 'a.txt' }, { connectionConfig: { roots: ['relative/dir'] } }),
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/invalid fs connection config/);
  });

  it('an empty roots list is a permanent config error', async () => {
    const events = await drain(
      invoke(ctx('file_read', { path: 'a.txt' }, { connectionConfig: { roots: [] } })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('a malformed file_read input is permanent', async () => {
    const events = await drain(invoke(ctx('file_read', { path: '' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/invalid file_read/);
  });

  it('an activity type the fs connector does not serve fails loud', async () => {
    const events = await drain(invoke(ctx('http_request', { path: 'a.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/does not handle activity/);
  });
});

describe('fs connector — A12 file_copy', () => {
  it('copies a file within the roots and returns bytesWritten + canonical paths', async () => {
    await writeFile(join(root, 'src.txt'), 'copy me', 'utf8');
    const events = await drain(invoke(ctx('file_copy', { source: 'src.txt', dest: 'dst.txt' })));
    expect(events).toEqual([
      {
        type: 'succeeded',
        outputs: { bytesWritten: 7, source: join(root, 'src.txt'), dest: join(root, 'dst.txt') },
      },
    ]);
    expect(await readFile(join(root, 'dst.txt'), 'utf8')).toBe('copy me');
    expect(await readFile(join(root, 'src.txt'), 'utf8')).toBe('copy me'); // source untouched
  });

  it('is binary-safe (chunked copy preserves non-UTF-8 bytes)', async () => {
    const bytes = Buffer.from([0x00, 0x9f, 0x92, 0x96, 0xff]);
    await writeFile(join(root, 'bin'), bytes);
    await drain(invoke(ctx('file_copy', { source: 'bin', dest: 'bin.copy' })));
    expect(await readFile(join(root, 'bin.copy'))).toEqual(bytes);
  });

  it('copies a file LARGER than the read byte cap (copy is streamed, uncapped)', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(50), 'utf8');
    const events = await drain(
      invoke(
        ctx(
          'file_copy',
          { source: 'big.txt', dest: 'big.copy' },
          { connectionConfig: { roots: [root], maxBytes: 10 } },
        ),
      ),
    );
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { bytesWritten: 50 } });
    expect(await readFile(join(root, 'big.copy'), 'utf8')).toHaveLength(50);
  });

  it('overwrites an existing dest atomically, leaving no temp behind', async () => {
    await writeFile(join(root, 'a.txt'), 'new', 'utf8');
    await writeFile(join(root, 'b.txt'), 'the old longer content', 'utf8');
    await drain(invoke(ctx('file_copy', { source: 'a.txt', dest: 'b.txt' })));
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('new');
    expect((await readdir(root)).sort()).toEqual(['a.txt', 'b.txt']); // temp renamed away
  });

  it('refuses a source outside the roots as permanent', async () => {
    await writeFile(join(outside, 'secret.txt'), 'x', 'utf8');
    const events = await drain(
      invoke(ctx('file_copy', { source: join(outside, 'secret.txt'), dest: 'here.txt' })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it('refuses a dest outside the roots as permanent', async () => {
    await writeFile(join(root, 'src.txt'), 'x', 'utf8');
    const events = await drain(
      invoke(ctx('file_copy', { source: 'src.txt', dest: join(outside, 'out.txt') })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it('does NOT follow a symlink source pointing outside the roots', async () => {
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const events = await drain(
      invoke(ctx('file_copy', { source: 'link.txt', dest: 'stolen.txt' })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The secret was never copied in.
    await expect(readFile(join(root, 'stolen.txt'), 'utf8')).rejects.toThrow();
  });

  it('a missing source is permanent (ENOENT), leaving no temp behind', async () => {
    const events = await drain(invoke(ctx('file_copy', { source: 'nope.txt', dest: 'dst.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(await readdir(root)).toEqual([]);
  });

  it('a directory source is permanent (not a regular file)', async () => {
    await mkdir(join(root, 'adir'));
    const events = await drain(invoke(ctx('file_copy', { source: 'adir', dest: 'dst.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/not a regular file/);
  });
});

describe('fs connector — A12 file_move', () => {
  it('moves a file within the roots (source gone, dest created)', async () => {
    await writeFile(join(root, 'from.txt'), 'move me', 'utf8');
    const events = await drain(invoke(ctx('file_move', { source: 'from.txt', dest: 'to.txt' })));
    expect(events).toEqual([
      {
        type: 'succeeded',
        outputs: { source: join(root, 'from.txt'), dest: join(root, 'to.txt') },
      },
    ]);
    expect(await readFile(join(root, 'to.txt'), 'utf8')).toBe('move me');
    await expect(readFile(join(root, 'from.txt'), 'utf8')).rejects.toThrow(); // source gone
  });

  it('replaces an existing dest (rename semantics)', async () => {
    await writeFile(join(root, 'from.txt'), 'new', 'utf8');
    await writeFile(join(root, 'to.txt'), 'old', 'utf8');
    await drain(invoke(ctx('file_move', { source: 'from.txt', dest: 'to.txt' })));
    expect(await readFile(join(root, 'to.txt'), 'utf8')).toBe('new');
    expect(await readdir(root)).toEqual(['to.txt']);
  });

  it('refuses a source outside the roots as permanent', async () => {
    await writeFile(join(outside, 'secret.txt'), 'x', 'utf8');
    const events = await drain(
      invoke(ctx('file_move', { source: join(outside, 'secret.txt'), dest: 'here.txt' })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });

  it('refuses a dest outside the roots as permanent (no exfiltration)', async () => {
    await writeFile(join(root, 'from.txt'), 'x', 'utf8');
    const events = await drain(
      invoke(ctx('file_move', { source: 'from.txt', dest: join(outside, 'out.txt') })),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(await readFile(join(root, 'from.txt'), 'utf8')).toBe('x'); // source not moved out
  });

  it('a missing source is permanent (ENOENT)', async () => {
    const events = await drain(invoke(ctx('file_move', { source: 'nope.txt', dest: 'to.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('a cross-filesystem move is permanent (EXDEV → compose copy+delete)', async () => {
    // EXDEV is only reachable when source and dest live on different mounts,
    // which a single-temp-dir test cannot stage; inject the errno'd rename
    // rejection to exercise the real `doMove` EXDEV classification branch.
    await writeFile(join(root, 'from.txt'), 'x', 'utf8');
    const exdev = Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    vi.mocked(rename).mockRejectedValueOnce(exdev);
    const events = await drain(invoke(ctx('file_move', { source: 'from.txt', dest: 'to.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/across filesystems \(EXDEV\)/);
    expect(await readFile(join(root, 'from.txt'), 'utf8')).toBe('x'); // source untouched
  });
});

describe('fs connector — A12 file_delete', () => {
  it('deletes a file within the roots and returns its canonical path', async () => {
    await writeFile(join(root, 'gone.txt'), 'x', 'utf8');
    const events = await drain(invoke(ctx('file_delete', { path: 'gone.txt' })));
    expect(events).toEqual([{ type: 'succeeded', outputs: { path: join(root, 'gone.txt') } }]);
    expect(await readdir(root)).toEqual([]);
  });

  it('deleting a missing file is permanent (ENOENT), not a silent success', async () => {
    const events = await drain(invoke(ctx('file_delete', { path: 'nope.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('deleting a directory is permanent (assert only the kind — errno varies by OS)', async () => {
    await mkdir(join(root, 'adir'));
    const events = await drain(invoke(ctx('file_delete', { path: 'adir' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(await readdir(root)).toEqual(['adir']); // not removed
  });

  it('does NOT delete through a target symlink pointing outside the roots', async () => {
    await writeFile(join(outside, 'victim.txt'), 'original', 'utf8');
    await symlink(join(outside, 'victim.txt'), join(root, 'link.txt'));
    const events = await drain(invoke(ctx('file_delete', { path: 'link.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    // The out-of-roots file was NOT deleted.
    expect(await readFile(join(outside, 'victim.txt'), 'utf8')).toBe('original');
  });

  it('refuses a path outside the roots as permanent', async () => {
    await writeFile(join(outside, 'secret.txt'), 'x', 'utf8');
    const events = await drain(invoke(ctx('file_delete', { path: join(outside, 'secret.txt') })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('x'); // untouched
  });
});

describe('fs connector — A12 file_list', () => {
  it('lists a directory with each entry typed (file/directory/symlink)', async () => {
    await writeFile(join(root, 'f.txt'), 'x', 'utf8');
    await mkdir(join(root, 'd'));
    await symlink(join(root, 'f.txt'), join(root, 'l'));
    const events = await drain(invoke(ctx('file_list', { path: '.' })));
    expect(events[0]!.type).toBe('succeeded');
    const outputs = (events[0] as Extract<ActivityEvent, { type: 'succeeded' }>).outputs as {
      entries: Array<{ name: string; type: string }>;
      path: string;
    };
    expect(outputs.path).toBe(root);
    const byName = new Map(outputs.entries.map((e) => [e.name, e.type]));
    expect(byName.get('f.txt')).toBe('file');
    expect(byName.get('d')).toBe('directory');
    expect(byName.get('l')).toBe('symlink'); // a symlink entry is reported, never followed
    expect(outputs.entries).toHaveLength(3);
  });

  it('returns an empty entries array for an empty directory', async () => {
    await mkdir(join(root, 'empty'));
    const events = await drain(invoke(ctx('file_list', { path: 'empty' })));
    expect(events[0]).toMatchObject({ type: 'succeeded', outputs: { entries: [] } });
  });

  it('caps the listing at maxEntries as a permanent failure', async () => {
    for (const n of ['a', 'b', 'c']) await writeFile(join(root, n), 'x', 'utf8');
    const events = await drain(
      invoke(
        ctx('file_list', { path: '.' }, { connectionConfig: { roots: [root], maxEntries: 2 } }),
      ),
    );
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/list limit/);
  });

  it('listing a non-directory (a file) is permanent (ENOTDIR)', async () => {
    await writeFile(join(root, 'f.txt'), 'x', 'utf8');
    const events = await drain(invoke(ctx('file_list', { path: 'f.txt' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('listing a missing directory is permanent (ENOENT)', async () => {
    const events = await drain(invoke(ctx('file_list', { path: 'nope' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('does NOT list a directory reached via a target symlink pointing outside', async () => {
    await mkdir(join(outside, 'sensitive'));
    await writeFile(join(outside, 'sensitive', 'a.txt'), 'x', 'utf8');
    await symlink(join(outside, 'sensitive'), join(root, 'linkdir'));
    const events = await drain(invoke(ctx('file_list', { path: 'linkdir' })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
  });

  it('refuses a path outside the roots as permanent', async () => {
    const events = await drain(invoke(ctx('file_list', { path: outside })));
    expect(events[0]).toMatchObject({ type: 'failed', kind: 'permanent' });
    expect((events[0] as { error: string }).error).toMatch(/outside the allowed roots/);
  });
});

describe('fs connector — testConnection', () => {
  it('ok when every root is an existing directory', async () => {
    expect(await fsAdapter.testConnection({ roots: [root] }, null)).toEqual({ ok: true });
  });

  it('errors when a root is missing', async () => {
    const res = await fsAdapter.testConnection({ roots: [join(root, 'nope')] }, null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not accessible/);
  });

  it('errors when a root is a file, not a directory', async () => {
    await writeFile(join(root, 'afile'), 'x', 'utf8');
    const res = await fsAdapter.testConnection({ roots: [join(root, 'afile')] }, null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a directory/);
  });

  it('errors on an invalid config (relative root)', async () => {
    const res = await fsAdapter.testConnection({ roots: ['rel'] }, null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid fs connection config/);
  });
});
