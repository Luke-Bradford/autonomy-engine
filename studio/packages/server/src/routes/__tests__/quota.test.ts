import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import type { ClaudeQuota } from '@autonomy-studio/shared';

/**
 * #440 (C1) — `GET /api/quota`, the spend guard's source.
 *
 * The consumer (`loop/drive.sh`'s `quota_pct()`) is a shell + python one-liner
 * that reads a HARD-CODED path out of this body and multiplies by 100:
 *
 * ```python
 * u = d['account']['claude']['seven_day']['utilization']
 * print(int(round(float(u) * 100)) if u is not None else '')
 * ```
 *
 * so these tests assert the wire contract literally — the exact key path, the
 * fraction/percent polarity, and that an unobtainable reading arrives as `null`
 * rather than as a number. Renaming a key or flipping the scale here would not
 * break a type check anywhere; it would just quietly disarm the guard.
 */

const READING: ClaudeQuota = {
  five_hour: { utilization: 0.08, resets_at: 1_785_100_200 },
  seven_day: { utilization: 0.07, resets_at: 1_785_636_000 },
  source: 'live',
};

const apps: FastifyInstance[] = [];

async function appReading(claude: ClaudeQuota | null): Promise<FastifyInstance> {
  const { app } = await buildTestAppWithContext({
    claudeQuotaReader: { read: async () => claude },
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/** The consumer's arithmetic, reproduced exactly. `null` → UNREADABLE (''). */
function consumerPercent(body: unknown): number | '' {
  const u = (body as { account: { claude: { seven_day: { utilization: number } } | null } }).account
    .claude?.seven_day.utilization;
  return u === undefined || u === null ? '' : Math.round(u * 100);
}

describe('GET /api/quota', () => {
  it('serves the reading at the exact key path the guard parses', async () => {
    const app = await appReading(READING);
    const res = await app.inject({ method: 'GET', url: '/api/quota' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account.claude.seven_day.utilization).toBe(0.07);
    expect(body.account.claude.five_hour.utilization).toBe(0.08);
    expect(body.account.claude.source).toBe('live');
    expect(body.generated_at).toBeTypeOf('number');
  });

  it('round-trips through the consumer arithmetic to the right percent', async () => {
    const app = await appReading(READING);
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    // A percent served where a fraction was expected would read as 700 here
    // (fail-safe: refuses every fire). A fraction misread as a percent would
    // read as 0 — fail-OPEN, which is the one that spends the operator's quota.
    expect(consumerPercent(body)).toBe(7);
  });

  it('reports an unobtainable reading as null, NOT as zero', async () => {
    const app = await appReading(null);
    const res = await app.inject({ method: 'GET', url: '/api/quota' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.account.claude).toBeNull();
    // The distinction the guard's two branches depend on.
    expect(consumerPercent(body)).toBe('');
    expect(consumerPercent(body)).not.toBe(0);
  });

  it('still serves a genuine 0% reading as a number', async () => {
    const app = await appReading({
      ...READING,
      seven_day: { utilization: 0, resets_at: 1_785_636_000 },
    });
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    expect(body.account.claude).not.toBeNull();
    expect(consumerPercent(body)).toBe(0);
  });

  it('reports null when the surface is switched off', async () => {
    const { app } = await buildTestAppWithContext({
      claudeQuotaEnabled: false,
      // Explicitly UNSET the test-app's stub reader, so what answers here is
      // the DISABLED branch of the decoration rather than the test default.
      claudeQuotaReader: undefined,
    });
    apps.push(app);
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    expect(body.account.claude).toBeNull();
  });

  it('never 500s when the reader throws — the guard polls this', async () => {
    const { app } = await buildTestAppWithContext({
      claudeQuotaReader: {
        read: async () => {
          throw new Error('unexpected');
        },
      },
    });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/quota' });
    // A 500 body is not JSON the consumer can parse, so it degrades to
    // UNREADABLE anyway — but reporting it as a clean null reading is the
    // honest answer and keeps the surface's contract total.
    expect(res.statusCode).toBe(200);
    expect(res.json().account.claude).toBeNull();
  });
});
