import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
