import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
  });

  it('opens a root under the base, points every temp variable at it, and teardown removes it and restores them', () => {
    const base = newBase();
    const env: NodeJS.ProcessEnv = { TMPDIR: '/before', TEMP: '/before-temp' };
    const close = openTestRunRoot(base, env);
    const root = env.TMPDIR!;
    expect(dirname(root)).toBe(base);
    expect(basename(root).startsWith(TEST_RUN_ROOT_PREFIX)).toBe(true);
    for (const name of TMP_VARS) expect(env[name]).toBe(root);
    mkdirSync(join(root, 'left-by-a-test', 'nested'), { recursive: true });

    close();

    expect(existsSync(root)).toBe(false);
    expect(env).toEqual({ TMPDIR: '/before', TEMP: '/before-temp' });
  });

  it('sweeps a run root a killed run left behind, once it is stale, and nothing else', () => {
    const base = newBase();
    const now = Date.now();
    const old = new Date(now - STALE_RUN_ROOT_MS - 60_000);
    const make = (name: string, mtime?: Date): string => {
      const dir = join(base, name);
      mkdirSync(join(dir, 'inner'), { recursive: true });
      if (mtime) utimesSync(dir, mtime, mtime);
      return dir;
    };
    const staleRoot = make(`${TEST_RUN_ROOT_PREFIX}stale1`, old);
    const liveRoot = make(`${TEST_RUN_ROOT_PREFIX}live01`);
    const someoneElses = make('autonomy-secrets-test-abc123', old);

    sweepStaleRunRoots(base, now);

    expect(existsSync(staleRoot)).toBe(false);
    expect(existsSync(liveRoot)).toBe(true);
    expect(existsSync(someoneElses)).toBe(true);
  });
});
