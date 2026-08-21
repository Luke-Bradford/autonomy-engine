import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSupervisor, type Supervisor, type OutputLineEvent } from '../process-supervisor.js';

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

/**
 * Resolve on a child's FIRST output line — i.e. once it is demonstrably running
 * its script. Throws if the stream closes first, which is what a child that
 * died before printing looks like.
 */
async function firstLine(events: AsyncIterable<OutputLineEvent>): Promise<OutputLineEvent> {
  for await (const event of events) return event;
  throw new Error('process produced no output before exiting');
}

/**
 * Poll until `check` holds, bounded by ITERATIONS rather than by a wall clock.
 *
 * The distinction is this file's whole #1124 fix. A wall-clock deadline is a
 * fixed budget that a loaded machine eats into, so it fails exactly when the
 * machine is busy — the failure mode being removed. An iteration bound stretches
 * with the load, because each tick's `setTimeout` is itself subject to the same
 * scheduling pressure, so a slow box gets proportionally longer rather than a
 * spurious red. Same shape as `until` in `scheduler/__tests__/retry-alarm.test.ts`,
 * which reasons the same way; deliberately NOT extracted to a shared helper in
 * this PR (that is #1124's own follow-up, not a change to smuggle in beside it).
 *
 * 200 x 10ms is ~2s of ticks on an idle box against this test's 10,000ms budget,
 * whose other fixed costs are two cold node boots, A's KILL_GRACE_MS (500) and
 * B's reap grace (500). The per-test override is left at 10_000 on purpose:
 * raising it would be the timeout bump both tickets rule out.
 */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('spawnSupervised', () => {
  // A FRESH supervisor instance per test: its own live-pid registry, so a
  // `reapAllSupervised()` here never reaches another test's (or another app's)
  // children. This is the per-instance isolation the factory provides.
  let sup: Supervisor;
  beforeEach(() => {
    sup = createSupervisor();
  });

  it('streams line-framed stdout in order', async () => {
    const script = `
      let i = 0;
      const iv = setInterval(() => {
        console.log('line-' + i);
        i++;
        if (i >= 5) clearInterval(iv);
      }, 15);
    `;

    const supervised = sup.spawnSupervised({ command: process.execPath, args: ['-e', script] });
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

    const supervised = sup.spawnSupervised({
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

    const supervised = sup.spawnSupervised({
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
    //
    // The grandchild's write delay (3000ms) is deliberately WELL beyond the
    // kill window — timeoutMs (200ms) + SIGTERM->SIGKILL grace (~500ms) is
    // ~700ms nominal, but under heavy parallel-suite CPU contention the kill
    // can slip to ~1.5-2s; 3000ms keeps a wide margin so the reap always
    // lands first (was 900ms, which flaked under load — a timing race, not a
    // logic bug). We then wait PAST 3000ms so "sentinel absent" proves the
    // grandchild was reaped, not merely that we checked too early.
    const parentScript = `
      const { spawn } = require('child_process');
      const grandchildScript = "setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'wrote'); }, 3000);";
      spawn(process.execPath, ['-e', grandchildScript, process.argv[1]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `;

    const supervised = sup.spawnSupervised({
      command: process.execPath,
      args: ['-e', parentScript, sentinelPath],
      timeoutMs: 200,
    });

    const [, result] = await Promise.all([collectEvents(supervised.events), supervised.result]);
    expect(result.timedOut).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(existsSync(sentinelPath)).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

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
    const supervised = sup.spawnSupervised({
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

    // The shared-vs-per-stream distinction is proven by the COMBINED cap above
    // (a per-stream cap would allow ~2x maxOutputBytes). We deliberately do NOT
    // assert each stream individually got a slice: a genuinely SHARED budget may
    // be consumed by EITHER stream in any proportion — including entirely by
    // whichever floods first, since the interleaving of two flooding pipes is
    // not deterministic across platforms (a fast Linux CI runner regularly
    // drains one stream's full 64KB before the other is scheduled). Requiring
    // both > 0 was therefore racy AND contradicted the shared semantics under
    // test; the split need only account for the whole.
    const stdoutBytes = events
      .filter((e) => e.stream === 'stdout')
      .reduce((sum, e) => sum + Buffer.byteLength(e.line, 'utf8') + 1, 0);
    const stderrBytes = events
      .filter((e) => e.stream === 'stderr')
      .reduce((sum, e) => sum + Buffer.byteLength(e.line, 'utf8') + 1, 0);
    expect(stdoutBytes + stderrBytes).toBe(collectedBytes);
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
    const supervised = sup.spawnSupervised({
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
    const supervised = sup.spawnSupervised({ command: 'this-command-does-not-exist-xyz-123' });

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

    const supervised = sup.spawnSupervised({
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

    const supervised = sup.spawnSupervised({
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
    const supervised = sup.spawnSupervised({
      command: process.execPath,
      args: ['-e', 'process.exit(0);'],
    });

    // Race the reap against the child's own near-instant natural exit --
    // whichever wins, `killTree`'s ESRCH branch (process group already
    // gone) must be treated as a successful no-op, never thrown.
    await expect(sup.reapAllSupervised()).resolves.toBeUndefined();

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

    const supervised = sup.spawnSupervised({
      command: process.execPath,
      args: ['-e', parentScript, sentinelPath],
    });

    // Give the parent a moment to actually spawn its grandchild before we
    // reap.
    await new Promise((resolve) => setTimeout(resolve, 150));

    await sup.reapAllSupervised();

    const result = await supervised.result;
    expect(result.killed).toBe(true);
    expect(result.exitCode === 0 && result.signal === null).toBe(false);

    // Wait past the grandchild's would-be write time (900ms) to prove it
    // never happened, not merely that we hadn't checked yet.
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(existsSync(sentinelPath)).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it('reapAllSupervised is a safe no-op when nothing is currently supervised', async () => {
    // No spawn at all in this test — `liveSupervised` is guaranteed empty.
    // This is the "host calls reapAllSupervised() but nothing was running"
    // case (e.g. shutdown right after boot) and must resolve cleanly.
    await expect(sup.reapAllSupervised()).resolves.toBeUndefined();
  });

  it('reapAllSupervised is idempotent: a second call after everything is already reaped is a safe no-op', async () => {
    const script = `setInterval(() => {}, 1000);`;

    const supervised = sup.spawnSupervised({ command: process.execPath, args: ['-e', script] });

    // Give it a moment to actually be spawned/tracked before reaping.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await sup.reapAllSupervised();
    const result = await supervised.result;
    expect(result.killed).toBe(true);

    // The child is gone and no longer tracked — calling reapAllSupervised()
    // again must not throw, hang, or attempt to re-kill anything.
    await expect(sup.reapAllSupervised()).resolves.toBeUndefined();
  }, 10_000);

  it('two supervisor instances are ISOLATED: reaping one leaves the other running (factory req a)', async () => {
    // The load-bearing property of the createSupervisor() factory: each
    // instance has its OWN live-pid registry, so instance A's shutdown reap
    // must NOT touch instance B's children. (With the old module-global
    // registry, `reapAllSupervised()` reaped EVERYTHING — two apps in one
    // process would kill each other's subprocesses on either's shutdown.)
    const tmpDir = mkdtempSync(join(tmpdir(), 'process-supervisor-isolation-'));
    const sentinelPath = join(tmpDir, 'b-alive.txt');

    const supA = createSupervisor();
    const supB = createSupervisor();

    // A's child just idles. B's child proves it is still ALIVE by REWRITING a
    // sentinel on an interval. The sentinel is the real discriminator:
    // `killed`/`markKilled` flips true under EITHER isolation or leakage (it is
    // set by whichever reap runs), so it cannot distinguish them — only "is B's
    // child still doing work after A's reap" can.
    //
    // #1124 — an INTERVAL, where this used to be a single write 300ms after B
    // booted, checked once after a fixed 1500ms sleep. That made the assertion
    // a bet that a cold node runtime boots inside ~2.1s: 100ms + A's
    // KILL_GRACE_MS(500) + 1500ms. On a loaded box it does not, and the test
    // fails having proved nothing about isolation. A liveness signal that
    // repeats can be waited FOR instead of bet on.
    const readyLine = 'ready';
    const childA = supA.spawnSupervised({
      command: process.execPath,
      args: ['-e', `console.log(${JSON.stringify(readyLine)}); setInterval(() => {}, 1000);`],
    });
    const bScript =
      `console.log(${JSON.stringify(readyLine)}); ` +
      `setInterval(() => require('fs').writeFileSync(process.argv[1], 'alive'), 50);`;
    const childB = supB.spawnSupervised({
      command: process.execPath,
      args: ['-e', bScript, sentinelPath],
    });

    // Wait for each child's first stdout line before reaping anything.
    //
    // This is NOT the old "let them spawn" sleep in new clothes, and dropping it
    // would open a vacuous pass rather than merely a race. `killTree` signals
    // the process GROUP (`process.kill(-pid, …)`), and the group only exists
    // once the forked child has run `setsid()` — strictly after the parent
    // already holds `child.pid`. Reaping inside that window signals nothing,
    // and `killTree` treats the resulting ESRCH as a successful no-op, so under
    // real registry LEAKAGE the test would still go green. A line on stdout can
    // only be produced by a child that is already executing JS, so it is proof
    // the group exists — which a sleep never was.
    await firstLine(childA.events);
    await firstLine(childB.events);

    await supA.reapAllSupervised();

    const resultA = await childA.result;
    expect(resultA.killed).toBe(true);
    expect(resultA.exitCode === 0 && resultA.signal === null).toBe(false);

    // Delete whatever B has written SO FAR, then require it to come back. The
    // question is not "did B ever write" (it wrote before the reap) but "is B
    // still running now that A has been reaped" — only a reappearance answers
    // that. `force` because under leakage B is dead and the file may be absent;
    // an ENOENT throw here would fail the test on the wrong error and mask the
    // real one.
    rmSync(sentinelPath, { force: true });
    await until(() => existsSync(sentinelPath), "B's child to rewrite its sentinel after A's reap");

    // Cleanup: B's own reap kills B's child (and confirms the reap works).
    await supB.reapAllSupervised();
    const resultB = await childB.result;
    expect(resultB.killed).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);
});
