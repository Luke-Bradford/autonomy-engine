import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { UNREADABLE_ACCOUNT_QUOTA_READER, type AccountQuotaReading } from '../claude-quota.js';
import { resolveQuotaSamplerEnabled } from '../quota-sampler.js';

/**
 * #765 — how `buildApp` arms (and refuses to arm) the background quota sampler.
 *
 * These are wiring tests, not sampler tests: the cadence and backoff behaviour
 * live in `quota-sampler.test.ts`. What is asserted here is the FLAG — because
 * the flag is the whole safety argument. #770 caps the number of processes
 * polling `/api/oauth/usage` at one; until C3 retires the prototype dashboard's
 * sampler, that process is the dashboard, and an app that armed this one by
 * default would breach the invariant on every install.
 *
 * The intervals below are deliberately tiny (10ms) so a handful of ticks can be
 * observed with a ~100ms wall-clock wait. Fake timers are NOT used: the app has
 * a 1s alarm tick and a lease sweep on real timers, and faking the clock for the
 * whole instance would drive those too.
 */

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A reader that counts reads, so "was it sampled" is observable. */
function countingReader() {
  const read = vi.fn(async (): Promise<AccountQuotaReading> => ({
    value: null,
    unavailable: 'no_credential',
  }));
  return { read };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('buildApp — quota sampler flag', () => {
  it('does NOT sample by default (the #770 one-poller invariant, until C3)', async () => {
    const reader = countingReader();
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: reader,
      claudeAccountQuotaSamplerIntervalMs: 10,
    });
    apps.push(app);
    await settle(100);
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('samples when explicitly armed', async () => {
    const reader = countingReader();
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: reader,
      claudeAccountQuotaSamplerEnabled: true,
      claudeAccountQuotaSamplerIntervalMs: 10,
    });
    apps.push(app);
    // The prime read alone proves arming; the wait proves it keeps ticking.
    expect(reader.read).toHaveBeenCalledTimes(1);
    await settle(100);
    expect(reader.read.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops sampling when the app closes', async () => {
    const reader = countingReader();
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: reader,
      claudeAccountQuotaSamplerEnabled: true,
      claudeAccountQuotaSamplerIntervalMs: 10,
    });
    await settle(50);
    await app.close();
    const afterClose = reader.read.mock.calls.length;
    await settle(100);
    expect(reader.read.mock.calls.length).toBe(afterClose);
  });

  it('does not sample the always-UNREADABLE reader, and says so', async () => {
    // Arming against a disabled surface would be a silent no-op — the exact
    // shape of "the cutover retired the old sampler and started nothing".
    const lines: string[] = [];
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: UNREADABLE_ACCOUNT_QUOTA_READER,
      claudeAccountQuotaSamplerEnabled: true,
      claudeAccountQuotaSamplerIntervalMs: 10,
      loggerStream: { write: (msg) => void lines.push(msg) },
    });
    apps.push(app);
    expect(lines.some((l) => l.includes('nothing will be sampled'))).toBe(true);
    expect(lines.some((l) => l.includes('account-quota sampler armed'))).toBe(false);
  });

  it('refuses a non-positive interval at boot rather than arming a spin loop', async () => {
    await expect(
      buildTestAppWithContext({
        claudeAccountQuotaReader: countingReader(),
        claudeAccountQuotaSamplerEnabled: true,
        claudeAccountQuotaSamplerIntervalMs: 0,
      }),
    ).rejects.toThrow(/claudeAccountQuotaSamplerIntervalMs/);
  });
});

/**
 * The env flag is parsed by a PURE function so these cases need neither an app
 * nor a mutation of `process.env` — which is process-global and shared across
 * concurrently-running test files, so setting an invalid value here would fail
 * an unrelated file's `buildApp`.
 */
describe('resolveQuotaSamplerEnabled — CLAUDE_QUOTA_SAMPLER', () => {
  it('is dormant when unset, empty, or explicitly off', () => {
    expect(resolveQuotaSamplerEnabled(undefined, undefined)).toBe(false);
    expect(resolveQuotaSamplerEnabled(undefined, '')).toBe(false);
    expect(resolveQuotaSamplerEnabled(undefined, '0')).toBe(false);
  });

  it("arms on exactly '1'", () => {
    expect(resolveQuotaSamplerEnabled(undefined, '1')).toBe(true);
  });

  it("throws on a value that is neither '1' nor '0'", () => {
    // The failure this prevents is specific and silent: at C3,
    // `CLAUDE_QUOTA_SAMPLER=true` would mean the dashboard retired, this sampler
    // unarmed, and ZERO pollers — with nothing said about it. Every one of these
    // is a plausible operator spelling of "on".
    for (const raw of ['true', 'yes', 'on', 'TRUE', ' 1', '2']) {
      expect(() => resolveQuotaSamplerEnabled(undefined, raw)).toThrow(/CLAUDE_QUOTA_SAMPLER/);
    }
  });

  it('lets an explicit option beat the env var in both directions', () => {
    expect(resolveQuotaSamplerEnabled(false, '1')).toBe(false);
    expect(resolveQuotaSamplerEnabled(true, '0')).toBe(true);
    // Including a value that would otherwise throw: an explicit option is a
    // caller decision, not a parse of untrusted config.
    expect(resolveQuotaSamplerEnabled(true, 'nonsense')).toBe(true);
  });
});
