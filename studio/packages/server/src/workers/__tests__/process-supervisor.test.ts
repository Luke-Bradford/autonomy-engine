import { existsSync, mkdtempSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reapAllSupervised, spawnSupervised, type OutputLineEvent } from '../process-supervisor.js';

/**
 * All fixtures below drive `process.execPath` with an inline `-e` script —
 * deterministic and dependency-free, never the real `claude` CLI.
 */

async function collectEvents(events: AsyncIterable<OutputLineEvent>): Promise<OutputLineEvent[]> {
  const collected: OutputLineEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('spawnSupervised', () => {
  it('streams line-framed stdout in order', async () => {
    const script = `
      let i = 0;
      const iv = setInterval(() => {
        console.log('line-' + i);
        i++;
        if (i >= 5) clearInterval(iv);
      }, 15);
    `;

    const supervised = spawnSupervised({ command: process.execPath, args: ['-e', script] });
    const [events, result] = await Promise.all([
      collectEvents(supervised.events),
      supervised.result,
    ]);

    const stdoutLines = events.filter((e) => e.stream === 'stdout').map((e) => e.line);
    expect(stdoutLines).toEqual(['line-0', 'line-1', 'line-2', 'line-3', 'line-4']);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('tree-kills a long-running script on hard timeout', async () => {
    const script = `setInterval(() => {}, 1000);`;

    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 200,
    });

    const [, result] = await Promise.all([collectEvents(supervised.events), supervised.result]);

    expect(result.timedOut).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.aborted).toBe(false);
    // Killed by SIGTERM (or the SIGKILL escalation) — never a clean 0 exit.
    expect(result.exitCode === 0 && result.signal === null).toBe(false);
  }, 10_000);

  it('tree-kills on AbortSignal cancellation', async () => {
    const script = `setInterval(() => {}, 1000);`;
    const controller = new AbortController();

    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', script],
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 150);

    const [, result] = await Promise.all([collectEvents(supervised.events), supervised.result]);

    expect(result.aborted).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode === 0 && result.signal === null).toBe(false);
  }, 10_000);

  it('reaps a grandchild when the tree is killed (no orphaned descendant)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'process-supervisor-tree-kill-'));
    const sentinelPath = join(tmpDir, 'sentinel.txt');

    // Parent spawns an ordinary (non-detached) grandchild that writes a
    // sentinel file after a delay comfortably longer than our kill+grace
    // window, then the parent idles forever. If tree-kill works, the
    // grandchild dies with the group and the sentinel is never written.
    const parentScript = `
      const { spawn } = require('child_process');
      const grandchildScript = "setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'wrote'); }, 900);";
      spawn(process.execPath, ['-e', grandchildScript, process.argv[1]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;

    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', parentScript, sentinelPath],
      timeoutMs: 200,
    });

    const [, result] = await Promise.all([collectEvents(supervised.events), supervised.result]);
    expect(result.timedOut).toBe(true);

    // Wait past the grandchild's would-be write time (900ms) to prove it
    // never happened, not merely that we hadn't checked yet.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(sentinelPath)).toBe(false);
  }, 10_000);

  it('bounds COMBINED stdout+stderr memory on a flooding process and reports truncated', async () => {
    // Flood BOTH streams concurrently. Before the fix, each stream had its
    // own independent LineFramer with the full `maxOutputBytes` budget, so
    // the real ceiling was ~2x the documented "stdout+stderr combined" cap.
    const script = `
      const chunk = 'x'.repeat(1024) + '\\n';
      for (let i = 0; i < 20000; i++) {
        process.stdout.write(chunk);
        process.stderr.write(chunk);
      }
    `;

    const maxOutputBytes = 64 * 1024;
    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', script],
      maxOutputBytes,
    });

    const [events, result] = await Promise.all([
      collectEvents(supervised.events),
      supervised.result,
    ]);

    expect(result.truncated).toBe(true);

    const collectedBytes = events.reduce(
      (sum, e) => sum + Buffer.byteLength(e.line, 'utf8') + 1,
      0,
    );
    // The COMBINED (stdout+stderr) total must be capped near the single
    // shared budget, not ~2x it (the pre-fix bug: one full budget per
    // stream), and nowhere close to the ~40MB the script actually wrote.
    expect(collectedBytes).toBeLessThanOrEqual(maxOutputBytes + 4096);
    expect(collectedBytes).toBeGreaterThan(0);

    const stdoutBytes = events
      .filter((e) => e.stream === 'stdout')
      .reduce((sum, e) => sum + Buffer.byteLength(e.line, 'utf8') + 1, 0);
    const stderrBytes = events
      .filter((e) => e.stream === 'stderr')
      .reduce((sum, e) => sum + Buffer.byteLength(e.line, 'utf8') + 1, 0);
    // Both streams got a slice of the SAME shared budget (proving it's
    // genuinely shared, not two independent per-stream caps).
    expect(stdoutBytes).toBeGreaterThan(0);
    expect(stderrBytes).toBeGreaterThan(0);
  }, 15_000);

  it('bounds COMBINED memory on a NEWLINE-FREE flood on both streams (partial-buffer path)', async () => {
    // The regression the review caught: with per-emit charging, un-terminated
    // partial buffers escaped the shared cap, so a NEWLINE-FREE flood on both
    // streams could retain ~2x maxOutputBytes before either framer tripped.
    // Charging on ARRIVAL (in LineFramer.push) bounds the partials too. No
    // '\n' is ever written, so the flood lives entirely in the partial buffers.
    const script = `
      const chunk = 'x'.repeat(4096);   // NO newline, ever
      for (let i = 0; i < 20000; i++) {
        process.stdout.write(chunk);
        process.stderr.write(chunk);
      }
    `;
    const maxOutputBytes = 64 * 1024;
    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', script],
      maxOutputBytes,
    });

    const [, result] = await Promise.all([collectEvents(supervised.events), supervised.result]);

    // The combined arrival across both streams exceeds the shared budget, so
    // the framer must trip (truncated) rather than buffer ~40 MB / ~2x the cap.
    expect(result.truncated).toBe(true);
  }, 15_000);

  it('resolves (does not hang) and cleanly closes the stream on a spawn failure (ENOENT)', async () => {
    // Empirically (verified independently with a raw `execa(..., { reject:
    // false })` call before writing this test): execa 9.6.1 does NOT reject
    // or hang on a spawn failure — it resolves with a "failed" result
    // (`pid: undefined`, `exitCode`/`signal` both `undefined`). This test
    // pins that `spawnSupervised` surfaces that as a normal resolved
    // `SupervisedResult`, not a hang.
    const supervised = spawnSupervised({ command: 'this-command-does-not-exist-xyz-123' });

    const hangGuard = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error('spawnSupervised did not resolve within the hang guard')),
        3000,
      );
    });

    const [events, result] = (await Promise.race([
      Promise.all([collectEvents(supervised.events), supervised.result]),
      hangGuard,
    ])) as [OutputLineEvent[], Awaited<typeof supervised.result>];

    expect(events).toEqual([]);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.killed).toBe(false);
  }, 5_000);

  it('removes the AbortSignal "abort" listener once settled (no accumulation on a shared signal)', async () => {
    const controller = new AbortController();

    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
      signal: controller.signal,
    });

    expect(getEventListeners(controller.signal, 'abort').length).toBe(1);

    await Promise.all([collectEvents(supervised.events), supervised.result]);

    // The child ran to completion without the signal ever aborting — if the
    // listener weren't cleaned up on settle, it would sit on this signal
    // forever, accumulating one more per spawn on a shared/long-lived
    // controller.
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0);
  }, 10_000);

  it('settles cleanly (no crash, no stray escalate timer) when timeout and abort race each other', async () => {
    const script = `setInterval(() => {}, 1000);`;
    const controller = new AbortController();

    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', script],
      timeoutMs: 100,
      signal: controller.signal,
    });

    // Fire the abort right on top of the timeout so both triggers race to
    // kill the same child. Before the `triggerKill` idempotency fix, this
    // could schedule two independent SIGTERM->SIGKILL escalate timers.
    setTimeout(() => controller.abort(), 100);

    const [, result] = await Promise.all([collectEvents(supervised.events), supervised.result]);

    expect(result.killed).toBe(true);
    expect(result.exitCode === 0 && result.signal === null).toBe(false);
  }, 10_000);

  it('reapAllSupervised does not throw when a tracked process has already exited (ESRCH-as-success)', async () => {
    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
    });

    // Race the reap against the child's own near-instant natural exit --
    // whichever wins, `killTree`'s ESRCH branch (process group already
    // gone) must be treated as a successful no-op, never thrown.
    await expect(reapAllSupervised()).resolves.toBeUndefined();

    const result = await supervised.result;
    expect(result.exitCode === 0 || result.signal !== null).toBe(true);
  }, 10_000);

  it('reapAllSupervised tree-kills every live supervised child, including a grandchild (shutdown-reap contract)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'process-supervisor-reap-'));
    const sentinelPath = join(tmpDir, 'sentinel.txt');

    // Same shape as the timeout tree-kill test above, but with no
    // `timeoutMs`/`signal` at all -- the ONLY thing that stops this child
    // (and its grandchild) is a deliberate `reapAllSupervised()` call, the
    // same path a graceful server shutdown (SIGTERM/SIGINT) exercises.
    const parentScript = `
      const { spawn } = require('child_process');
      const grandchildScript = "setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'wrote'); }, 900);";
      spawn(process.execPath, ['-e', grandchildScript, process.argv[1]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;

    const supervised = spawnSupervised({
      command: process.execPath,
      args: ['-e', parentScript, sentinelPath],
    });

    // Give the parent a moment to actually spawn its grandchild before we
    // reap.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await reapAllSupervised();

    const result = await supervised.result;
    expect(result.killed).toBe(true);
    expect(result.exitCode === 0 && result.signal === null).toBe(false);

    // Wait past the grandchild's would-be write time (900ms) to prove it
    // never happened, not merely that we hadn't checked yet.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(sentinelPath)).toBe(false);
  }, 10_000);

  it('reapAllSupervised is a safe no-op when nothing is currently supervised', async () => {
    // No spawn at all in this test — `liveSupervised` is guaranteed empty.
    // This is the "host calls reapAllSupervised() but nothing was running"
    // case (e.g. shutdown right after boot) and must resolve cleanly.
    await expect(reapAllSupervised()).resolves.toBeUndefined();
  });

  it('reapAllSupervised is idempotent: a second call after everything is already reaped is a safe no-op', async () => {
    const script = `setInterval(() => {}, 1000);`;

    const supervised = spawnSupervised({ command: process.execPath, args: ['-e', script] });

    // Give it a moment to actually be spawned/tracked before reaping.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await reapAllSupervised();
    const result = await supervised.result;
    expect(result.killed).toBe(true);

    // The child is gone and no longer tracked — calling reapAllSupervised()
    // again must not throw, hang, or attempt to re-kill anything.
    await expect(reapAllSupervised()).resolves.toBeUndefined();
  }, 10_000);
});
