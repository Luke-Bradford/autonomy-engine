import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_ROOT_OWNER_FILE,
  STALE_RUN_ROOT_MS,
  TEST_RUN_ROOT_PREFIX,
  openTestRunRoot,
  sweepStaleRunRoots,
} from './test-tmp-root.js';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const newBase = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tmp-root-base-'));
  scratch.push(dir);
  return dir;
};
const TMP_VARS = ['TMPDIR', 'TMP', 'TEMP'] as const;

describe('#1632 — every server test run gets one temp root, removed at teardown', () => {
  it('is wired: this worker resolves tmpdir() inside the run root, not the host temp dir', () => {
    // Fails if `globalSetup` is dropped from vitest.config.ts: every mkdtemp in
    // the suite would land loose in the host temp dir again and outlive the run.
    expect(basename(tmpdir())).toMatch(new RegExp(`^${TEST_RUN_ROOT_PREFIX}`));
    for (const name of TMP_VARS) expect(process.env[name]).toBe(tmpdir());
  });

  it('opens a root under the base, points every temp variable at it, and teardown removes it and restores them', () => {
    const base = newBase();
    const env: NodeJS.ProcessEnv = { TMPDIR: '/before', TEMP: '/before-temp' };
    const close = openTestRunRoot(base, env);
    const root = env.TMPDIR!;
    expect(dirname(root)).toBe(base);
    expect(basename(root).startsWith(TEST_RUN_ROOT_PREFIX)).toBe(true);
    for (const name of TMP_VARS) expect(env[name]).toBe(root);
    expect(readFileSync(join(root, RUN_ROOT_OWNER_FILE), 'utf8')).toBe(String(process.pid));
    mkdirSync(join(root, 'left-by-a-test', 'nested'), { recursive: true });

    close();

    expect(existsSync(root)).toBe(false);
    expect(env).toStrictEqual({ TMPDIR: '/before', TEMP: '/before-temp' });
  });

  it('sweeps a root whose owner has exited, and keeps one whose owner lives, however old', () => {
    const base = newBase();
    const now = Date.now();
    const old = new Date(now - STALE_RUN_ROOT_MS - 60_000);
    const exited = spawnSync(process.execPath, ['-e', '']).pid;
    const make = (name: string, owner: number | null, mtime?: Date): string => {
      const dir = join(base, name);
      mkdirSync(join(dir, 'inner'), { recursive: true });
      if (owner !== null) writeFileSync(join(dir, RUN_ROOT_OWNER_FILE), String(owner));
      if (mtime) utimesSync(dir, mtime, mtime);
      return dir;
    };
    // A run killed by a timeout or Ctrl-C: its owner is gone, so it goes now.
    const killedRun = make(`${TEST_RUN_ROOT_PREFIX}killed`, exited);
    // A concurrent run, or a watch-mode run idle for days: its owner lives.
    const liveRun = make(`${TEST_RUN_ROOT_PREFIX}live01`, process.pid, old);
    // Owned by a live process of another user (pid 1; `kill(1, 0)` is EPERM unless root).
    const otherUsersRun = make(`${TEST_RUN_ROOT_PREFIX}pid001`, 1, old);
    // Died before writing its owner: swept only once it is stale.
    const ownerlessStale = make(`${TEST_RUN_ROOT_PREFIX}nopid1`, null, old);
    const ownerlessFresh = make(`${TEST_RUN_ROOT_PREFIX}nopid2`, null);
    const someoneElses = make('autonomy-secrets-test-abc123', exited, old);

    sweepStaleRunRoots(base, now);

    expect(existsSync(killedRun)).toBe(false);
    expect(existsSync(liveRun)).toBe(true);
    expect(existsSync(otherUsersRun)).toBe(true);
    expect(existsSync(ownerlessStale)).toBe(false);
    expect(existsSync(ownerlessFresh)).toBe(true);
    expect(existsSync(someoneElses)).toBe(true);
  });
});
