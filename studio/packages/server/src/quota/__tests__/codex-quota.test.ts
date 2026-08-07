import { mkdtemp, mkdir, writeFile, utimes, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexQuota,
  codexQuotaSourcePresent,
  createAbandonmentLatch,
  createCodexAccountQuotaReader,
  mapCodexWindow,
  withDeadline,
  DISABLED_CODEX_QUOTA_READER,
} from '../codex-quota.js';

/**
 * Every fixture in this file is a REAL directory of REAL session files, written
 * and then read back through the real reader. The shapes are copied from
 * codex-cli's own records on the operator's host (measured 2026-08-07), which is
 * the only thing that makes a test of a scraper meaningful: a mocked fs would
 * pin the reader against my belief about the format rather than the format.
 */

const roots: string[] = [];

afterEach(async () => {
  // Only directories THIS file created, never a path it was handed.
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function makeSessionsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-quota-'));
  roots.push(root);
  return join(root, 'sessions');
}

/** A `token_count` line exactly as codex-cli writes it. */
function tokenCountLine(timestamp: string, rateLimits: unknown): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: {} }, rate_limits: rateLimits },
  })}\n`;
}

/** The measured `plus`-plan shape: ONE window, `secondary: null`. */
function plusPlanLimits(usedPercent: number, resetsAt: number): unknown {
  return {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt },
    secondary: null,
    credits: { has_credits: false, unlimited: false, balance: '0' },
    plan_type: 'plus',
    rate_limit_reached_type: null,
  };
}

async function writeSession(
  sessionsRoot: string,
  day: string,
  name: string,
  lines: string,
  mtimeSeconds: number,
): Promise<string> {
  const dir = join(sessionsRoot, day);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${name}.jsonl`);
  await writeFile(path, lines, 'utf8');
  await utimes(path, mtimeSeconds, mtimeSeconds);
  return path;
}

describe('mapCodexWindow', () => {
  it('converts a PERCENT to a fraction and passes epoch seconds through', () => {
    // Measured: codex sends `used_percent: 64.0` and `resets_at: 1786283144`
    // (epoch SECONDS, not the ISO string claude's reader parses).
    expect(
      mapCodexWindow({ used_percent: 64, window_minutes: 10080, resets_at: 1786283144 }),
    ).toEqual({ utilization: 0.64, resets_at: 1786283144 });
  });

  it('rejects a window with no reset instant rather than inventing one', () => {
    expect(mapCodexWindow({ used_percent: 64, window_minutes: 10080, resets_at: null })).toBeNull();
  });

  it('rejects a non-numeric or negative utilization', () => {
    expect(mapCodexWindow({ used_percent: 'lots', resets_at: 1786283144 })).toBeNull();
    expect(mapCodexWindow({ used_percent: -1, resets_at: 1786283144 })).toBeNull();
  });

  it('rejects a non-integer reset instant — a millisecond value must not pass as seconds', () => {
    expect(mapCodexWindow({ used_percent: 64, resets_at: 1786283144123.5 })).toBeNull();
  });
});

describe('buildCodexQuota', () => {
  it('maps window_minutes to its named slot', () => {
    const quota = buildCodexQuota(
      {
        primary: { used_percent: 20, window_minutes: 300, resets_at: 100 },
        secondary: { used_percent: 64, window_minutes: 10080, resets_at: 200 },
      },
      1786106974,
    );
    expect(quota).toEqual({
      five_hour: { utilization: 0.2, resets_at: 100 },
      seven_day: { utilization: 0.64, resets_at: 200 },
      read_at: 1786106974,
    });
  });

  it('keeps a single-window reading — `primary` alone is the measured plus-plan shape', () => {
    // The whole reason codex does not reuse claude's all-or-nothing pair.
    const quota = buildCodexQuota(plusPlanLimits(64, 1786283144), 1786106974);
    expect(quota).toEqual({
      seven_day: { utilization: 0.64, resets_at: 1786283144 },
      read_at: 1786106974,
    });
    expect(quota?.five_hour).toBeUndefined();
  });

  it('honours window_minutes over position — a 7-day `primary` is NOT the 5-hour slot', () => {
    const quota = buildCodexQuota(plusPlanLimits(64, 1786283144), 1786106974);
    expect(quota?.seven_day?.utilization).toBe(0.64);
  });

  it('falls back to position only when window_minutes is absent or unknown', () => {
    const quota = buildCodexQuota(
      {
        primary: { used_percent: 20, resets_at: 100 },
        secondary: { used_percent: 64, window_minutes: 99, resets_at: 200 },
      },
      5,
    );
    expect(quota).toEqual({
      five_hour: { utilization: 0.2, resets_at: 100 },
      seven_day: { utilization: 0.64, resets_at: 200 },
      read_at: 5,
    });
  });

  it('lets a DECLARED window win the slot over a positional guess listed first', () => {
    // The single-pass "first writer wins" rule got this wrong in the permissive
    // direction: `primary` has no `window_minutes`, so it guesses `five_hour`
    // and claims the slot; `secondary` then explicitly SAYS it is the 5-hour
    // window, finds the slot taken and is dropped. The operator sees "5-hour:
    // 5%" while the real 5-hour figure is 95%.
    const quota = buildCodexQuota(
      {
        primary: { used_percent: 5, resets_at: 100 },
        secondary: { used_percent: 95, window_minutes: 300, resets_at: 200 },
      },
      7,
    );
    expect(quota?.five_hour).toEqual({ utilization: 0.95, resets_at: 200 });
    // The displaced guess is DROPPED, not re-homed into the free slot. Its only
    // claim to `five_hour` was its position, and that claim has just been shown
    // wrong — moving it to `seven_day` would be a second guess stacked on a
    // discredited first one, and this surface does not state windows it cannot
    // identify.
    expect(quota?.seven_day).toBeUndefined();
  });

  it('is UNREADABLE, never zero, when no window survives mapping', () => {
    // The fail-open shape this surface exists to prevent: a payload that parsed
    // but yielded nothing must not render as "0% used / wide open".
    expect(buildCodexQuota({ primary: null, secondary: null }, 5)).toBeNull();
    expect(buildCodexQuota({ primary: { used_percent: 64 } }, 5)).toBeNull();
    expect(buildCodexQuota({}, 5)).toBeNull();
    expect(buildCodexQuota('not an object', 5)).toBeNull();
  });
});

describe('createCodexAccountQuotaReader', () => {
  const NOW_S = 1786106974;
  const NOW_MS = NOW_S * 1000;

  it('reads the newest session that carries a snapshot, skipping ones that do not', async () => {
    // Measured on the host: the newest rollout file by mtime frequently has NO
    // `rate_limits` line at all (a session that never hit the reporting path),
    // so "stop at the newest file" would read UNREADABLE with a good snapshot
    // sitting one file down.
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'newest-no-snapshot',
      '{"timestamp":"2026-08-07T12:59:00.000Z","type":"event_msg","payload":{"type":"agent_message"}}\n',
      NOW_S - 10,
    );
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'has-snapshot',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    const reader = createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS });
    const outcome = await reader.read();

    expect(outcome.unavailable).toBeNull();
    expect(outcome.value).toEqual({
      seven_day: { utilization: 0.64, resets_at: 1786283144 },
      read_at: Math.floor(Date.parse('2026-08-07T12:56:25.719Z') / 1000),
    });
  });

  it('takes the LAST snapshot in a file, not the first — usage climbs within a session', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'climbing',
      tokenCountLine('2026-08-07T11:00:00.000Z', plusPlanLimits(58, 1786283144)) +
        tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value?.seven_day?.utilization).toBe(0.64);
  });

  it('prefers the newer FILE over an older one', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/06',
      'older',
      tokenCountLine('2026-08-06T10:00:00.000Z', plusPlanLimits(30, 1786283144)),
      NOW_S - 90_000,
    );
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'newer',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value?.seven_day?.utilization).toBe(0.64);
  });

  it('skips malformed lines rather than failing the whole read', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'partly-corrupt',
      '{"rate_limits": TRUNCATED\n' +
        tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value?.seven_day?.utilization).toBe(0.64);
  });

  it('ignores sessions older than the cutoff — a reading must not outlive its own window', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/07/20',
      'stale',
      tokenCountLine('2026-07-20T10:00:00.000Z', plusPlanLimits(30, 1786283144)),
      NOW_S - 8 * 86_400,
    );

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('no_reading');
  });

  it('reports `no_reading` when the source exists but holds no snapshot', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await mkdir(sessionsRoot, { recursive: true });

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('no_reading');
  });

  it('reports `no_credential` when the source itself is gone', async () => {
    const sessionsRoot = join(await makeSessionsRoot(), 'never-created');

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('no_credential');
  });

  it('reports `unrecognized_payload` when a snapshot parses but yields no window', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'no-windows',
      tokenCountLine('2026-08-07T12:56:25.719Z', {
        primary: null,
        secondary: null,
        plan_type: 'plus',
      }),
      NOW_S - 60,
    );

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('unrecognized_payload');
  });

  it('falls back to the file mtime when the snapshot line carries no usable timestamp', async () => {
    const sessionsRoot = await makeSessionsRoot();
    // No `timestamp` key at all — the age is still knowable from the file.
    const line = `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: plusPlanLimits(64, 1786283144) } })}\n`;
    await writeSession(sessionsRoot, '2026/08/07', 'no-timestamp', line, NOW_S - 60);

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value?.read_at).toBe(NOW_S - 60);
  });

  it('serves a cached outcome within the TTL and re-reads after it', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'first',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    let clock = NOW_MS;
    const reader = createCodexAccountQuotaReader({ sessionsRoot, now: () => clock, ttlMs: 60_000 });
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.64);

    // A newer session appears, but the TTL has not expired.
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'second',
      tokenCountLine('2026-08-07T13:10:00.000Z', plusPlanLimits(70, 1786283144)),
      NOW_S + 10,
    );
    clock = NOW_MS + 30_000;
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.64);

    clock = NOW_MS + 61_000;
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.7);
  });

  it('re-reads rather than serving the cache when the wall clock steps BACKWARDS', async () => {
    // Same fail-open hazard `claude-quota.ts` floors: a negative age is still
    // `< ttlMs`, so an NTP step-back would pin a stale reading indefinitely.
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'first',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    let clock = NOW_MS;
    const reader = createCodexAccountQuotaReader({ sessionsRoot, now: () => clock, ttlMs: 60_000 });
    await reader.read();

    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'second',
      tokenCountLine('2026-08-07T13:10:00.000Z', plusPlanLimits(70, 1786283144)),
      NOW_S + 10,
    );
    clock = NOW_MS - 5_000;
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.7);
  });

  it('gives up rather than hanging when the filesystem is too slow', async () => {
    // A network-mounted home or an autofs mount that has gone away would
    // otherwise stall a request handler indefinitely, and the in-flight dedupe
    // would hang every concurrent caller with it. A clock that runs past the
    // budget stands in for the slow mount.
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'fine',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    let clock = NOW_MS;
    const outcome = await createCodexAccountQuotaReader({
      sessionsRoot,
      // Every consultation of the clock advances it a second — so the deadline
      // is passed during the walk, on a tree that is otherwise perfectly good.
      now: () => {
        const at = clock;
        clock += 1_000;
        return at;
      },
      deadlineMs: 2_000,
    }).read();

    // An absence of evidence, NOT a partial reading assembled from however far
    // the walk got — a partial walk's "newest file" is only the newest so far.
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('reader_error');
  });

  it('stops waiting on an operation that never returns at all', async () => {
    // The test above advances a fake clock, so every syscall in it COMPLETES
    // and the walk merely notices it is late. That proves the cooperative half
    // of the budget and nothing about the other half: a stale NFS handle or a
    // departed autofs mount does not return slowly, it does not return, and a
    // deadline polled between operations never gets its turn to fire.
    //
    // Tested on the race directly, with a promise that genuinely never settles.
    // The in-process alternative — a FIFO named `rollout-*.jsonl`, on which
    // `readFile` really does block forever — strands a libuv threadpool thread
    // for the life of the worker and leaves the event loop with a pending
    // request at teardown, so it buys realism with a hanging test run.
    const started = Date.now();
    await expect(withDeadline(new Promise<string>(() => {}), 25)).rejects.toThrow();
    // Bounded, and bounded by the DEADLINE rather than by anything the work
    // did — the work here does nothing at all, forever.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('surfaces the work’s own failure instead of swallowing it into the deadline', async () => {
    // The race must stay transparent to everything that is not the deadline.
    // `sample` decides what becomes a `reader_error` by testing for
    // `DeadlineExceeded` specifically, so a helper that folded every rejection
    // into one would dress a programming error up as "the mount is unwell" —
    // indistinguishable, on the wire, from a genuinely slow filesystem.
    await expect(
      withDeadline(Promise.reject(new Error('not the deadline')), 5_000),
    ).rejects.toThrow('not the deadline');
  });

  it('refuses to start a walk while an abandoned one is still outstanding', async () => {
    // `maxAbandonedSamples: 0` stands in for "one walk is already stranded".
    // The refusal cannot be reached any other way in-process: it needs a
    // syscall that genuinely never returns, and a real filesystem will not
    // provide one (a FIFO, the usual trick, is skipped by the walk because it
    // is not a regular file).
    //
    // The tree here is PERFECTLY GOOD and holds a readable snapshot, so a
    // reader that used what the filesystem offered would return that value.
    // `reader_error` instead pins the refusal itself.
    //
    // What it does NOT pin — checked, not assumed — is the ORDERING. Moving
    // `latch.blocked()` below `sampleFilesystem(at)` leaves this test green,
    // because that call only STARTS the walk and is never awaited on the
    // refusal path, so the outcome is identical while a threadpool slot has
    // quietly been spent. The ordering is the load-bearing half and it rests on
    // review of `sample`, not on this test. Observing it would need a spy on
    // `node:fs`, which this file deliberately does without.
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'good',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    const outcome = await createCodexAccountQuotaReader({
      sessionsRoot,
      now: () => NOW_MS,
      maxAbandonedSamples: 0,
    }).read();

    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('reader_error');
  });

  it('does not follow a symlink out of the sessions tree', async () => {
    // `readdir(..., {withFileTypes:true})` reports a link as a link, not a
    // directory, so a cycle cannot loop the walk. Pinned because the walk has
    // no depth bound and relies on exactly this.
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'real',
      tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );
    await symlink(sessionsRoot, join(sessionsRoot, '2026/08/07', 'loop'), 'dir');

    const outcome = await createCodexAccountQuotaReader({
      sessionsRoot,
      now: () => NOW_MS,
    }).read();

    // Terminates, and still finds the real reading.
    expect(outcome.value?.seven_day?.utilization).toBe(0.64);
  });

  it('never lets a filesystem failure become a reading', async () => {
    // A path that exists but is not a directory: the walk throws.
    const sessionsRoot = await makeSessionsRoot();
    await mkdir(join(sessionsRoot, '..'), { recursive: true });
    await writeFile(sessionsRoot, 'not a directory', 'utf8');

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('reader_error');
  });
});

describe('DISABLED_CODEX_QUOTA_READER', () => {
  it('reports `disabled` and reads nothing', async () => {
    const outcome = await DISABLED_CODEX_QUOTA_READER.read();
    expect(outcome.value).toBeNull();
    expect(outcome.unavailable).toBe('disabled');
  });
});

describe('codexQuotaSourcePresent', () => {
  it('is false when the sessions directory does not exist — the provider is ABSENT, not unreadable', async () => {
    const sessionsRoot = join(await makeSessionsRoot(), 'never-created');
    expect(await codexQuotaSourcePresent(sessionsRoot)).toBe(false);
  });

  it('is true when the sessions directory exists, even with no sessions in it yet', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await mkdir(sessionsRoot, { recursive: true });
    expect(await codexQuotaSourcePresent(sessionsRoot)).toBe(true);
  });

  it('is false when the path exists but is not a directory', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeFile(sessionsRoot, 'not a directory', 'utf8');
    expect(await codexQuotaSourcePresent(sessionsRoot)).toBe(false);
  });
});

describe('createAbandonmentLatch', () => {
  // A stranded walk is a libuv threadpool slot the process does not get back
  // until the kernel releases it, and node cannot cancel an fs promise. With
  // the default pool of four, a reader that starts a fresh doomed walk on every
  // cache miss takes down every async `fs` operation in the process — including
  // claude's own quota reader, which the spend guard depends on. Hence a cap.
  //
  // Tested here rather than through the reader because the arithmetic is the
  // part that can be wrong, and a promise that never settles is the same
  // hazard as a hung syscall without needing a filesystem to produce one.
  const never = (): Promise<never> => new Promise<never>(() => {});

  it('blocks once the cap is reached and not before', () => {
    const latch = createAbandonmentLatch(2);
    expect(latch.blocked()).toBe(false);
    latch.track(never());
    expect(latch.blocked()).toBe(false);
    latch.track(never());
    expect(latch.blocked()).toBe(true);
  });

  it('unblocks when the stranded work finally settles', async () => {
    // Self-healing is the reason one is a safe cap: the reader refuses only for
    // as long as the filesystem is genuinely stuck, and resumes by itself.
    const latch = createAbandonmentLatch(1);
    let release: (() => void) | undefined;
    latch.track(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    expect(latch.blocked()).toBe(true);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(latch.blocked()).toBe(false);
  });

  it('unblocks on work that REJECTS, not only on work that succeeds', async () => {
    // A walk that eventually fails has handed its threadpool slot back exactly
    // as one that eventually succeeds has. Decrementing only on success would
    // latch the reader off permanently the first time a mount errored — a
    // display panel that never recovers without a restart.
    const latch = createAbandonmentLatch(1);
    let fail: ((error: Error) => void) | undefined;
    latch.track(
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
    );
    expect(latch.blocked()).toBe(true);
    fail?.(new Error('the mount went away'));
    await Promise.resolve();
    await Promise.resolve();
    expect(latch.blocked()).toBe(false);
  });
});
