import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { UNREADABLE_ACCOUNT_QUOTA_READER } from '../../quota/claude-quota.js';
import {
  AccountQuotaStateSchema,
  type AccountQuotaUnavailableReason,
  type ClaudeAccountQuota,
} from '@autonomy-studio/shared';

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

const READING: ClaudeAccountQuota = {
  five_hour: { utilization: 0.08, resets_at: 1_785_100_200 },
  seven_day: { utilization: 0.07, resets_at: 1_785_636_000 },
};

const apps: FastifyInstance[] = [];

async function appReading(
  claude: ClaudeAccountQuota | null,
  unavailable: AccountQuotaUnavailableReason | null = claude === null ? 'provider_error' : null,
): Promise<FastifyInstance> {
  const { app } = await buildTestAppWithContext({
    claudeAccountQuotaReader: { read: async () => ({ value: claude, unavailable }) },
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

/**
 * The consumer's arithmetic. Outcome-equivalent, not character-identical: this
 * uses optional chaining where the python raises into `except: print('')`. Both
 * yield UNREADABLE for a null reading, which is the property under test.
 */
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
    // Pinned as epoch SECONDS for the same reason `resets_at` is: `Date.now()`
    // returns ms, and an ms value here would still be "a number".
    const nowSeconds = Math.floor(Date.now() / 1000);
    expect(body.generated_at).toBeGreaterThan(nowSeconds - 60);
    expect(body.generated_at).toBeLessThanOrEqual(nowSeconds + 1);
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

  it('wires the UNREADABLE reader — not the live one — when switched off', async () => {
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaEnabled: false,
      // Explicitly UNSET the test-app's stub reader, so what answers here is
      // the DISABLED branch of the decoration rather than the test default.
      claudeAccountQuotaReader: undefined,
    });
    apps.push(app);
    // Assert the WIRING, not the output. Asserting only `claude === null` is
    // vacuous on CI: `studio-ci` runs ubuntu, and the real reader returns null
    // on any non-darwin host BEFORE it touches anything — so the flag could be
    // ignored entirely and the body would look identical. (Worse, on the
    // operator's Mac that version of the test made a real Keychain read and a
    // real provider call from the unit suite.) Identity is the only assertion
    // that distinguishes "disabled" from "enabled but on the wrong OS".
    expect(app.claudeAccountQuota).toBe(UNREADABLE_ACCOUNT_QUOTA_READER);
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    expect(body.account.claude).toBeNull();
  });

  it('wires the LIVE reader when enabled — the flag is not ignored', async () => {
    // The other half: without this, wiring the UNREADABLE reader unconditionally
    // would satisfy the test above.
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaEnabled: true,
      claudeAccountQuotaReader: undefined,
    });
    apps.push(app);
    expect(app.claudeAccountQuota).not.toBe(UNREADABLE_ACCOUNT_QUOTA_READER);
  });

  it('never 500s when the reader throws — the guard polls this', async () => {
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: {
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
    // …and it says WHICH failure it was, rather than presenting an internal
    // fault as though the provider had answered.
    expect(res.json().unavailable.claude).toBe('reader_error');
  });
});

/**
 * #825 — WHY a reading is missing, on the same response as the missing reading.
 *
 * The C3 decision (park the old engine, #410) is made on a run of
 * `quota shadow: studio UNREADABLE` lines. Without attribution those lines
 * cannot distinguish "studio's reader is broken" (a real finding about studio)
 * from "the shared account bucket was contended at that instant" (a fact about
 * the account, which C3 itself largely removes). These tests pin the attribution
 * and — more importantly — pin that it can never be mistaken for a reading.
 */
describe('GET /api/quota — UNREADABLE attribution', () => {
  it('omits `unavailable` entirely when a reading was obtained', async () => {
    const body = (
      await (await appReading(READING)).inject({ method: 'GET', url: '/api/quota' })
    ).json();
    // Absent, not `null`: the iff-contract is "present ⟺ no reading", and a
    // key that is always present with a nullable value invites a consumer to
    // branch on it instead of on the reading.
    expect(body).not.toHaveProperty('unavailable');
  });

  it.each([
    'disabled',
    'no_credential',
    'rate_limited',
    'provider_error',
    'unrecognized_payload',
    'reader_error',
  ] as const)('reports `%s` alongside the null reading', async (reason) => {
    const body = (
      await (await appReading(null, reason)).inject({ method: 'GET', url: '/api/quota' })
    ).json();
    expect(body.account.claude).toBeNull();
    expect(body.unavailable.claude).toBe(reason);
  });

  it('leaves the guard parse yielding UNREADABLE — a reason is never a number', async () => {
    // The failure this whole field must not cause: an advisory string leaking
    // onto the path that yields a percent. `consumerPercent` walks the exact
    // hard-coded path `loop/drive.sh` walks.
    const body = (
      await (await appReading(null, 'rate_limited')).inject({ method: 'GET', url: '/api/quota' })
    ).json();
    expect(consumerPercent(body)).toBe('');
    expect(JSON.stringify(body.account)).not.toContain('rate_limited');
  });

  it('satisfies the strict wire schema in both shapes', async () => {
    // `.strict()` both ways: an unexpected key is a contract break, and the
    // schema is what the loop-side parser is written against.
    for (const app of [await appReading(READING), await appReading(null, 'rate_limited')]) {
      const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
      expect(AccountQuotaStateSchema.safeParse(body).success).toBe(true);
    }
  });

  it('reports `disabled` — not a provider fault — when the surface is switched off', async () => {
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaEnabled: false,
      claudeAccountQuotaReader: undefined,
    });
    apps.push(app);
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    // The distinction that matters for C3: a deployment that never asks looks
    // exactly like one whose provider is failing, unless this says otherwise.
    expect(body.unavailable.claude).toBe('disabled');
  });
});
