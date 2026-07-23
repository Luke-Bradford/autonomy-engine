import { realpath, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

/**
 * #3 G2 — where an owner's managed checkout lives: `<root>/<ownerId>/repo`.
 * ALWAYS a clone the server itself created (a "local repo" is connected by
 * using its path as the clone REMOTE), so everything under here is derived
 * state — safe to delete and cheap to re-create by re-cloning.
 */
export function checkoutDirFor(workspaceGitRoot: string, ownerId: string): string {
  return join(resolve(workspaceGitRoot), ownerId, 'repo');
}

/**
 * Removes an owner's managed checkout, tolerantly (a missing dir or missing
 * root is a no-op — the crash-recovery paths call this exactly when the disk
 * state is unknown) and containment-asserted: the resolved target must stay
 * inside the canonicalized root. The root is `realpath`ed first (macOS
 * `/tmp` → `/private/var` — comparing un-canonicalized prefixes false-fails
 * there; same pattern as `connectors/fs.ts`'s `resolveWithinRoots`), and the
 * target is then BUILT from the canonical root, so the prefix comparison is
 * canonical-vs-canonical. `ownerId` is principal-derived (never client
 * input); the assert is belt-and-braces, not the security boundary. A
 * top-level `rm` does not follow a symlink target, so even a planted link
 * at the checkout path could only unlink itself.
 */
export async function removeCheckoutDir(workspaceGitRoot: string, ownerId: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await realpath(resolve(workspaceGitRoot));
  } catch {
    // Root doesn't exist yet — nothing to remove.
    return;
  }
  const target = resolve(realRoot, ownerId, 'repo');
  if (target !== realRoot && !target.startsWith(realRoot + sep)) {
    throw new Error(`checkout path for owner "${ownerId}" escapes the workspace git root`);
  }
  await rm(target, { recursive: true, force: true });
}
