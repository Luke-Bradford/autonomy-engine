import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkoutDirFor, removeCheckoutDir } from '../checkout.js';

function tmp(): string {
  // NOTE: macOS `os.tmpdir()` is a symlink (`/var` → `/private/var`) — these
  // tests exercise exactly the realpath canonicalization the containment
  // check needs.
  return mkdtempSync(join(tmpdir(), 'studio-git-checkout-test-'));
}

describe('checkoutDirFor', () => {
  it('is <root>/<ownerId>/repo', () => {
    const root = tmp();
    expect(checkoutDirFor(root, 'local')).toBe(join(root, 'local', 'repo'));
  });

  it('refuses an escaping ownerId on the WRITE path too (symmetric with removeCheckoutDir)', () => {
    const root = tmp();
    expect(() => checkoutDirFor(root, '../victim')).toThrow(/escapes/);
  });
});

describe('removeCheckoutDir', () => {
  it('removes an existing managed checkout', async () => {
    const root = tmp();
    const dir = join(root, 'local', 'repo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'x');
    await removeCheckoutDir(root, 'local');
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, 'local'))).toBe(true);
  });

  it('is tolerant of a missing checkout (crash-recovery path)', async () => {
    const root = tmp();
    await expect(removeCheckoutDir(root, 'local')).resolves.toBeUndefined();
  });

  it('is tolerant of a missing root entirely', async () => {
    await expect(removeCheckoutDir(join(tmp(), 'never-created'), 'local')).resolves.toBeUndefined();
  });

  it('refuses to TRAVERSE a symlinked ownerId segment (parent is canonicalized before rm)', async () => {
    // A planted link at `<root>/<ownerId>` pointing outside the root: the
    // string-level prefix check passes (the un-canonicalized path looks
    // contained) but `rm` would follow the link during traversal and delete
    // `<elsewhere>/repo`. The parent realpath must catch it.
    const root = tmp();
    const outside = tmp();
    mkdirSync(join(outside, 'repo'), { recursive: true });
    writeFileSync(join(outside, 'repo', 'victim.txt'), 'x');
    symlinkSync(outside, join(root, 'local'));
    await expect(removeCheckoutDir(root, 'local')).rejects.toThrow(/escapes/);
    expect(existsSync(join(outside, 'repo', 'victim.txt'))).toBe(true);
  });

  it('refuses an ownerId that would escape the root (belt-and-braces — ownerId is principal-derived)', async () => {
    const root = tmp();
    const outside = join(root, '..', 'victim');
    mkdirSync(outside, { recursive: true });
    await expect(removeCheckoutDir(root, '../victim')).rejects.toThrow(/escapes/);
    expect(existsSync(outside)).toBe(true);
  });
});
