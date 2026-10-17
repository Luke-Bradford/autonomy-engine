import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confineFsPath, resolveWithinRoots, resolveWithinRootsOrMissing } from '../confine.js';

/**
 * #1119 M4 follow-up — the shared confinement guard NAMES THE RIGHT CONNECTOR.
 *
 * `resolveWithinRoots` was extracted from `fs.ts` with "fs" baked into its two
 * refusal strings, so once `sqlite` started dispatching through it a sqlite
 * refusal blamed "the fs connection" / "the fs connector" — an operator sent to
 * the wrong connection entirely. Neither connector suite caught it, because each
 * asserted only the shape of the refusal (`/symlink/`), never its attribution.
 *
 * These tests live HERE rather than in either connector suite because the
 * property belongs to the shared guard: it must hold for every caller, and a
 * third caller should fail this file, not slip through it.
 */

const dirs: string[] = [];

/** A temp dir whose path is REALPATH'd — on macOS `os.tmpdir()` is itself a
 * symlink (`/var` → `/private/var`), so an un-canonicalised root never
 * contains the paths resolved under it and a confinement test would pass for
 * the wrong reason. Mirrors `fs.test.ts` / `sqlite.test.ts`. */
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'confine-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('resolveWithinRoots — refusals attribute the CALLING connector', () => {
  it.each(['fs', 'sqlite'] as const)(
    'names %s when no allowed root is accessible',
    async (connector) => {
      const gone = join(tempRoot(), 'no-such-root');
      const res = await resolveWithinRoots([gone], join(gone, 'x.txt'), connector);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.error).toBe(
        `no accessible allowed root directory on the ${connector} connection`,
      );
    },
  );

  it.each(['fs', 'sqlite'] as const)('names %s when the target is a symlink', async (connector) => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const real = join(elsewhere, 'real.txt');
    writeFileSync(real, 'x', 'utf8');
    const link = join(root, 'link.txt');
    symlinkSync(real, link);

    const res = await resolveWithinRoots([root], link, connector);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe(
      `path '${link}' is a symlink; the ${connector} connector does not follow symlinks`,
    );
  });

  it('still refuses an out-of-roots path (message is connector-independent)', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const res = await resolveWithinRoots([root], join(outside, 'secret.txt'), 'sqlite');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/resolves outside the allowed roots/);
  });
});

/**
 * #1743 — the confinement a dataset ADDRESS takes: a missing folder is a path
 * that does not exist yet, judged by its nearest existing ancestor, never a
 * raw errno, and never an answer for a path outside the roots.
 */
describe('resolveWithinRootsOrMissing — a missing folder inside the roots', () => {
  it('answers the would-be canonical path', async () => {
    const root = tempRoot();
    expect(await resolveWithinRootsOrMissing([root], 'later/in/a.csv', 'fs')).toEqual({
      ok: true,
      path: join(root, 'later', 'in', 'a.csv'),
    });
    expect(await resolveWithinRootsOrMissing([root], join(root, 'later', 'a.csv'), 'fs')).toEqual({
      ok: true,
      path: join(root, 'later', 'a.csv'),
    });
  });

  it("is resolveWithinRoots' own answer when the folder exists", async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'in'));
    expect(await resolveWithinRootsOrMissing([root], 'in/a.csv', 'fs')).toEqual({
      ok: true,
      path: join(root, 'in', 'a.csv'),
    });
  });

  it('takes a file where a folder is named as a folder that does not exist (ENOTDIR)', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'f.txt'), 'x', 'utf8');
    expect(await resolveWithinRootsOrMissing([root], 'f.txt/a.csv', 'fs')).toEqual({
      ok: true,
      path: join(root, 'f.txt', 'a.csv'),
    });
  });

  it('judges a root that is itself a link by where it points', async () => {
    const real = tempRoot();
    const linkRoot = join(tempRoot(), 'root-link');
    symlinkSync(real, linkRoot);
    expect(await resolveWithinRootsOrMissing([linkRoot], 'later/a.csv', 'fs')).toEqual({
      ok: true,
      path: join(real, 'later', 'a.csv'),
    });
  });

  it("is confineFsPath's only on request: a read stays strict", async () => {
    const root = tempRoot();
    expect(await confineFsPath({ roots: [root] }, 'later/a.csv')).toMatchObject({
      ok: false,
      kind: 'errno',
    });
    expect(
      await confineFsPath({ roots: [root] }, 'later/a.csv', { missingFolderOk: true }),
    ).toEqual({ ok: true, path: join(root, 'later', 'a.csv') });
  });

  it('rethrows for a missing folder outside the roots', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    await expect(
      resolveWithinRootsOrMissing([root], join(outside, 'later', 'a.csv'), 'fs'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rethrows through a link out of the roots, and through a dangling link', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    symlinkSync(outside, join(root, 'out'));
    await expect(
      resolveWithinRootsOrMissing([root], 'out/later/a.csv', 'fs'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    symlinkSync(join(outside, 'gone'), join(root, 'dangling'));
    await expect(resolveWithinRootsOrMissing([root], 'dangling/a.csv', 'fs')).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });
});
