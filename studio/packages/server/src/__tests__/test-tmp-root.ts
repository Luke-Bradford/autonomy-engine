import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #1632 — one temp root per server test run, removed when the run ends.
 *
 * WHY: the suite calls `mkdtemp(tmpdir(), …)` in many places (every
 * `buildTestApp()`, the git provider/checkout tests, secrets, build-info …)
 * and many of them never remove what they make. Under a build loop that runs the
 * suite many times an hour, those dirs filled the host's disk (53 GB,
 * 2026-10-10) and took Docker down with it. Fixing each site would leave the
 * next new one free to leak again.
 *
 * HOW: vitest's `globalSetup` runs this in the main process BEFORE it starts the
 * worker pool, so the workers inherit the environment set here and every
 * `os.tmpdir()` in a test (and in a `git` child it spawns) resolves inside
 * `root`. The teardown removes `root` whole, whatever a test left behind.
 *
 * A run that is killed (a timeout, Ctrl-C, SIGTERM) never reaches its
 * teardown, so the next run sweeps the roots it left. Each root records the
 * pid that owns it, and only a root whose owner is GONE is swept: that is what
 * keeps a concurrent run's root (the loop and an operator can run the suite at
 * once) and an idle watch-mode run's root safe, however old. A root with no
 * pid file (the run died between `mkdtemp` and the write) is swept once it is
 * older than `STALE_RUN_ROOT_MS`.
 */
export const TEST_RUN_ROOT_PREFIX = 'studio-server-vitest-';
export const STALE_RUN_ROOT_MS = 24 * 60 * 60 * 1000;
export const RUN_ROOT_OWNER_FILE = '.owner-pid';

/** `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows; set all three. */
const TMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

/** True unless `pid` is certainly gone; EPERM means it lives under another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Whether a run root is abandoned: its owner has exited, or it has no owner and is stale. */
function isAbandoned(dir: string, now: number): boolean {
  let owner: string;
  try {
    owner = readFileSync(join(dir, RUN_ROOT_OWNER_FILE), 'utf8');
  } catch {
    return now - statSync(dir).mtimeMs > STALE_RUN_ROOT_MS;
  }
  const pid = Number(owner.trim());
  return !Number.isInteger(pid) || pid <= 0 || !isAlive(pid);
}

/** Removes run roots under `base` that a killed run left behind. Best-effort. */
export function sweepStaleRunRoots(base: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEST_RUN_ROOT_PREFIX)) continue;
    const dir = join(base, name);
    try {
      if (isAbandoned(dir, now)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to stat: either way, not this run's problem.
    }
  }
}

/** Opens a run root under `base`, points `env`'s temp variables at it, and returns the teardown. */
export function openTestRunRoot(base: string, env: NodeJS.ProcessEnv): () => void {
  const root = mkdtempSync(join(base, TEST_RUN_ROOT_PREFIX));
  writeFileSync(join(root, RUN_ROOT_OWNER_FILE), String(process.pid));
  const previous = TMP_VARS.map((name) => [name, env[name]] as const);
  for (const name of TMP_VARS) env[name] = root;
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  };
}

/** vitest `globalSetup` entry point. */
export default function setup(): () => void {
  const base = tmpdir();
  sweepStaleRunRoots(base, Date.now());
  return openTestRunRoot(base, process.env);
}
