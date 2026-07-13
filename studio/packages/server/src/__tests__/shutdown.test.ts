import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from './build-test-app.js';

describe('server shutdown', () => {
  it('app.close() reaps an in-flight supervised child (onClose -> reapAllSupervised wiring)', async () => {
    const app = await buildTestApp();

    const tmpDir = mkdtempSync(join(tmpdir(), 'server-shutdown-reap-'));
    const sentinelPath = join(tmpDir, 'sentinel.txt');

    // Same fixture shape as `workers/__tests__/process-supervisor.test.ts`'s
    // own `reapAllSupervised` tree-kill test: a parent that spawns an
    // ordinary (non-detached) grandchild which writes a sentinel file after
    // a delay, then idles forever. Nothing here calls `reapAllSupervised()`
    // or sets a `timeoutMs`/`signal` — the ONLY thing that can stop this
    // process tree is the app's own `onClose` hook firing when we call
    // `app.close()` below. If that wiring were missing, the parent (and its
    // grandchild) would keep running past the test and the grandchild would
    // eventually write its sentinel file.
    const parentScript = `
      const { spawn } = require('child_process');
      const grandchildScript = "setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'wrote'); }, 900);";
      spawn(process.execPath, ['-e', grandchildScript, process.argv[1]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;

    // Spawn through the APP'S OWN supervisor (`app.supervisor`), the same
    // instance `onClose` reaps — this is what proves the per-app wiring, not a
    // shared module global (a separate `createSupervisor()` here would NOT be
    // reaped by `app.close()`, which is exactly the isolation we now want).
    const supervised = app.supervisor.spawnSupervised({
      command: process.execPath,
      args: ['-e', parentScript, sentinelPath],
    });

    // Give the parent a moment to actually spawn its grandchild before we
    // close the app.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await app.close();

    const result = await supervised.result;
    expect(result.killed).toBe(true);
    expect(result.exitCode === 0 && result.signal === null).toBe(false);

    // Wait past the grandchild's would-be write time (900ms) to prove it
    // never happened, not merely that we hadn't checked yet.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(sentinelPath)).toBe(false);
  }, 10_000);
});
