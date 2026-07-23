import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

  it('refuses an ownerId that would escape the root (belt-and-braces — ownerId is principal-derived)', async () => {
    const root = tmp();
    const outside = join(root, '..', 'victim');
    mkdirSync(outside, { recursive: true });
    await expect(removeCheckoutDir(root, '../victim')).rejects.toThrow(/escapes/);
    expect(existsSync(outside)).toBe(true);
  });
});
