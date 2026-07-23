import { realpath, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

/**
 * #3 G2 — where an owner's managed checkout lives: `<root>/<ownerId>/repo`.
 * ALWAYS a clone the server itself created (a "local repo" is connected by
 * using its path as the clone REMOTE), so everything under here is derived
 * state — safe to delete and cheap to re-create by re-cloning.
 */
export function checkoutDirFor(workspaceGitRoot: string, ownerId: string): string {
  const root = resolve(workspaceGitRoot);
  const dir = resolve(root, ownerId, 'repo');
  // Same belt-and-braces containment as `removeCheckoutDir` below (symmetric:
  // a hostile ownerId must be refused on the WRITE path, not just the
  // destructive one). Sync string-level check only — the rm path adds the
  // realpath canonicalization it needs.
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error(`checkout path for owner "${ownerId}" escapes the workspace git root`);
  }
  return dir;
}

/**
 * Removes an owner's managed checkout, tolerantly (a missing dir or missing
 * root is a no-op — the crash-recovery paths call this exactly when the disk
 * state is unknown) and containment-asserted: the resolved target must stay
 * inside the canonicalized root. BOTH sides of the prefix comparison are
 * canonical: the root is `realpath`ed (macOS `/tmp` → `/private/var` —
 * comparing un-canonicalized prefixes false-fails there; same pattern as
 * `connectors/fs.ts`'s `resolveWithinRoots`), and the `<root>/<ownerId>`
 * PARENT is `realpath`ed too — a planted symlink at the ownerId segment
 * would otherwise be followed during `rm`'s path traversal even though the
 * un-canonicalized string looked contained. `ownerId` is principal-derived
 * (never client input); the assert is belt-and-braces, not the security
 * boundary. The final `repo` component is deliberately NOT canonicalized: a
 * top-level `rm` does not follow a symlink target, so a planted link at the
 * checkout path itself can only unlink itself.
 */
export async function removeCheckoutDir(workspaceGitRoot: string, ownerId: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await realpath(resolve(workspaceGitRoot));
  } catch {
    // Root doesn't exist yet — nothing to remove.
    return;
  }
  let realParent: string;
  try {
    realParent = await realpath(resolve(realRoot, ownerId));
  } catch {
    // Owner dir doesn't exist — nothing to remove.
    return;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(`checkout path for owner "${ownerId}" escapes the workspace git root`);
  }
  await rm(resolve(realParent, 'repo'), { recursive: true, force: true });
}
