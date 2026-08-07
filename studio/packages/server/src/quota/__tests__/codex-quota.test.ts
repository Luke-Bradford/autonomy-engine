import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCodexQuota,
  codexQuotaSourcePresent,
  createCodexAccountQuotaReader,
  mapCodexWindow,
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
function tokenCountLine(
  timestamp: string,
  rateLimits: unknown,
): string {
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
    expect(mapCodexWindow({ used_percent: 64, window_minutes: 10080, resets_at: 1786283144 })).toEqual(
      { utilization: 0.64, resets_at: 1786283144 },
    );
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
    await writeSession(sessionsRoot, '2026/08/07', 'newest-no-snapshot', '{"timestamp":"2026-08-07T12:59:00.000Z","type":"event_msg","payload":{"type":"agent_message"}}\n', NOW_S - 10);
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
    await writeSession(sessionsRoot, '2026/08/06', 'older', tokenCountLine('2026-08-06T10:00:00.000Z', plusPlanLimits(30, 1786283144)), NOW_S - 90_000);
    await writeSession(sessionsRoot, '2026/08/07', 'newer', tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)), NOW_S - 60);

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value?.seven_day?.utilization).toBe(0.64);
  });

  it('skips malformed lines rather than failing the whole read', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(
      sessionsRoot,
      '2026/08/07',
      'partly-corrupt',
      '{"rate_limits": TRUNCATED\n' + tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)),
      NOW_S - 60,
    );

    const outcome = await createCodexAccountQuotaReader({ sessionsRoot, now: () => NOW_MS }).read();
    expect(outcome.value?.seven_day?.utilization).toBe(0.64);
  });

  it('ignores sessions older than the cutoff — a reading must not outlive its own window', async () => {
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(sessionsRoot, '2026/07/20', 'stale', tokenCountLine('2026-07-20T10:00:00.000Z', plusPlanLimits(30, 1786283144)), NOW_S - 8 * 86_400);

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
      tokenCountLine('2026-08-07T12:56:25.719Z', { primary: null, secondary: null, plan_type: 'plus' }),
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
    await writeSession(sessionsRoot, '2026/08/07', 'first', tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)), NOW_S - 60);

    let clock = NOW_MS;
    const reader = createCodexAccountQuotaReader({ sessionsRoot, now: () => clock, ttlMs: 60_000 });
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.64);

    // A newer session appears, but the TTL has not expired.
    await writeSession(sessionsRoot, '2026/08/07', 'second', tokenCountLine('2026-08-07T13:10:00.000Z', plusPlanLimits(70, 1786283144)), NOW_S + 10);
    clock = NOW_MS + 30_000;
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.64);

    clock = NOW_MS + 61_000;
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.7);
  });

  it('re-reads rather than serving the cache when the wall clock steps BACKWARDS', async () => {
    // Same fail-open hazard `claude-quota.ts` floors: a negative age is still
    // `< ttlMs`, so an NTP step-back would pin a stale reading indefinitely.
    const sessionsRoot = await makeSessionsRoot();
    await writeSession(sessionsRoot, '2026/08/07', 'first', tokenCountLine('2026-08-07T12:56:25.719Z', plusPlanLimits(64, 1786283144)), NOW_S - 60);

    let clock = NOW_MS;
    const reader = createCodexAccountQuotaReader({ sessionsRoot, now: () => clock, ttlMs: 60_000 });
    await reader.read();

    await writeSession(sessionsRoot, '2026/08/07', 'second', tokenCountLine('2026-08-07T13:10:00.000Z', plusPlanLimits(70, 1786283144)), NOW_S + 10);
    clock = NOW_MS - 5_000;
    expect((await reader.read()).value?.seven_day?.utilization).toBe(0.7);
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
