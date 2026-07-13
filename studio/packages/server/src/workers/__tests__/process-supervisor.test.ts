import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSupervised, type OutputLineEvent } from '../process-supervisor.js';

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

  it('bounds memory on a flooding process and reports truncated', async () => {
    const script = `
      const chunk = 'x'.repeat(1024) + '\\n';
      for (let i = 0; i < 20000; i++) {
        process.stdout.write(chunk);
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
    // The collected (emitted) buffer must be capped near the budget, not
    // anywhere close to the ~20MB the script actually wrote.
    expect(collectedBytes).toBeLessThanOrEqual(maxOutputBytes + 4096);
    expect(collectedBytes).toBeGreaterThan(0);
  }, 15_000);
});
