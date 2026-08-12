import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestAppWithContext } from '../../__tests__/build-test-app.js';
import { UNREADABLE_ACCOUNT_QUOTA_READER } from '../../quota/claude-quota.js';
import type { CodexAccountQuotaReader } from '../../quota/codex-quota.js';
import {
  ACCOUNT_QUOTA_UNAVAILABLE_REASONS,
  AccountQuotaDisplayStateSchema,
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
  unavailable: AccountQuotaUnavailableReason = 'provider_error',
): Promise<FastifyInstance> {
  // Constructed as the discriminated union it is, so the fixture cannot express
  // a pairing the reader could not produce.
  const reading =
    claude === null
      ? ({ value: null, unavailable } as const)
      : ({ value: claude, unavailable: null } as const);
  const { app } = await buildTestAppWithContext({
    claudeAccountQuotaReader: { read: async () => reading },
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

  /**
   * #1023 — the shape the spend guard now sees for most of the day.
   *
   * The provider stops reporting `five_hour` when there is no active session.
   * That used to make the whole reading UNREADABLE, which is what put studio on
   * `unrecognized_payload` for 31 of the guard's reads in three days. The guard
   * never looked at `five_hour`, so the ONLY thing that has to survive is the
   * key path it does parse — asserted here literally, and through the consumer's
   * own arithmetic, because a type check cannot see either.
   */
  it('serves a reading with no five_hour at the key path the guard parses', async () => {
    const app = await appReading({ seven_day: { utilization: 0.07, resets_at: 1_785_636_000 } });
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    expect(body.account.claude.seven_day.utilization).toBe(0.07);
    expect(consumerPercent(body)).toBe(7);
    // OMITTED, not `null`. A `null` here would be the guard's own signal for
    // "unreadable" appearing one level down, where it means something else.
    expect(body.account.claude).not.toHaveProperty('five_hour');
    // Still a READING, so it carries no reason for its own absence (#825).
    expect(body).not.toHaveProperty('unavailable');
  });

  it('serves an unreported reset instant as null rather than omitting or faking it', async () => {
    const app = await appReading({ seven_day: { utilization: 0.07, resets_at: null } });
    const body = (await app.inject({ method: 'GET', url: '/api/quota' })).json();
    expect(body.account.claude.seven_day.resets_at).toBeNull();
    // `quota_parse_reset` in loop/drive.sh requires an int and prints '' for
    // anything else, so a null takes the identical path to an absent field —
    // the "window reopens at" log line is simply skipped, which it documents as
    // intended. The PERCENT is unaffected, which is the property that matters.
    expect(consumerPercent(body)).toBe(7);
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

  // Driven off the exported enum, not a copy of it: the route is value-agnostic,
  // so no single row can fail alone — what this table is actually worth is being
  // EXHAUSTIVE, and a hand-written copy stops being exhaustive the day someone
  // adds a seventh reason.
  it.each(ACCOUNT_QUOTA_UNAVAILABLE_REASONS)(
    'reports `%s` alongside the null reading',
    async (reason) => {
      const body = (
        await (await appReading(null, reason)).inject({ method: 'GET', url: '/api/quota' })
      ).json();
      expect(body.account.claude).toBeNull();
      expect(body.unavailable.claude).toBe(reason);
    },
  );

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

  it.each([
    [
      'a reading that also explains its own absence',
      { account: { claude: READING }, unavailable: { claude: 'rate_limited' } },
    ],
    ['an UNREADABLE with the reason dropped', { account: { claude: null } }],
  ])('the schema REJECTS %s', (_label, partial) => {
    // The iff, enforced rather than asserted in prose. Without the superRefine
    // both of these parse: the first is a number carrying a failure's
    // explanation, the second a silent reversion to the unattributed UNREADABLE
    // this field exists to remove. `.optional()` alone admits both.
    expect(
      AccountQuotaStateSchema.safeParse({ generated_at: 1_785_495_913, ...partial }).success,
    ).toBe(false);
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

/**
 * #987 — `GET /api/quota/display`, the HUMAN surface.
 *
 * The panel was showing "Quota UNREADABLE" while the build loop's guard had read
 * 58% minutes earlier: the reader deliberately serves no last-good value, which
 * is right for a gate and useless for a person. These tests pin the SPLIT — the
 * display body gains the last obtained reading, and the guard's body provably
 * cannot.
 */
describe('GET /api/quota/display', () => {
  /** An app whose reader hands out one scripted outcome per read. */
  async function appScripted(
    outcomes: readonly (ClaudeAccountQuota | AccountQuotaUnavailableReason)[],
  ): Promise<FastifyInstance> {
    let i = 0;
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: {
        read: async () => {
          const next = outcomes.at(Math.min(i, outcomes.length - 1));
          if (next === undefined) throw new Error('appScripted: empty script');
          i += 1;
          return typeof next === 'string'
            ? ({ value: null, unavailable: next } as const)
            : ({ value: next, unavailable: null } as const);
        },
      },
    });
    apps.push(app);
    return app;
  }

  it('carries no last-known copy beside a live reading', async () => {
    const app = await appReading(READING);
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();
    expect(body.account.claude).toEqual(READING);
    // The same number twice, one copy aged, is the incoherent pair the schema
    // refuses — and one careless consumer away from preferring the stale copy.
    expect(body).not.toHaveProperty('last_known');
    expect(AccountQuotaDisplayStateSchema.safeParse(body).success).toBe(true);
  });

  it('serves the last obtained reading, with when it was taken, once the provider fails', async () => {
    const app = await appScripted([READING, 'rate_limited']);
    await app.inject({ method: 'GET', url: '/api/quota/display' });
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();

    expect(body.account.claude).toBeNull();
    expect(body.unavailable.claude).toBe('rate_limited');
    expect(body.last_known.claude).toEqual(READING);
    // Epoch SECONDS, and no later than the response's own stamp — the age the
    // client derives from the pair can therefore never be negative.
    expect(Number.isInteger(body.last_known.read_at)).toBe(true);
    expect(body.last_known.read_at).toBeLessThanOrEqual(body.generated_at);
    expect(AccountQuotaDisplayStateSchema.safeParse(body).success).toBe(true);
  });

  it('retains nothing at all when the surface is switched off', async () => {
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaEnabled: false,
      claudeAccountQuotaReader: undefined,
    });
    apps.push(app);
    await app.inject({ method: 'GET', url: '/api/quota/display' });
    // A reader that can never produce a reading can never produce a last-known
    // one, and the decoration says so rather than being absent.
    expect(app.claudeAccountQuotaLastKnown()).toBeNull();
  });

  it('says UNREADABLE with nothing beneath it when no reading has ever been obtained', async () => {
    const app = await appReading(null, 'no_credential');
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();
    expect(body.unavailable.claude).toBe('no_credential');
    // Never a manufactured number: "nothing has been read" is a real state and
    // is represented, not stood in for.
    expect(body).not.toHaveProperty('last_known');
  });

  /**
   * THE LOAD-BEARING ASSERTION (#987's own acceptance criterion).
   *
   * A last-known display value existing must not change the guard's reading by
   * one byte. A stale-but-low number reaching `loop/drive.sh` would PERMIT a
   * fire the live figure would refuse — the one fail-open polarity this whole
   * surface exists to prevent.
   */
  it('never lets the last-known value reach the guard, even when one exists', async () => {
    const app = await appScripted([READING, 'rate_limited']);
    // Read once so a last-known value definitely exists...
    const seeded = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();
    expect(seeded.account.claude).toEqual(READING);
    // ...then ask as the guard does, while the provider is failing.
    const guard = (await app.inject({ method: 'GET', url: '/api/quota' })).json();

    expect(guard.account.claude).toBeNull();
    expect(guard.unavailable.claude).toBe('rate_limited');
    expect(guard).not.toHaveProperty('last_known');
    // The consumer's own arithmetic, on the body it actually receives.
    expect(consumerPercent(guard)).toBe('');
    // And the retained number is nowhere in the bytes it parses.
    expect(JSON.stringify(guard)).not.toContain('0.07');
  });

  it('the guard schema REJECTS a body carrying a last-known reading', () => {
    // `.strict()`, pinned: the shape extraction that let the display body reuse
    // this one must not have been a door the guard body can acquire a field
    // through.
    expect(
      AccountQuotaStateSchema.safeParse({
        generated_at: 1_785_495_913,
        account: { claude: null },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: READING, read_at: 1_785_495_000 },
      }).success,
    ).toBe(false);
  });

  it('the display schema REJECTS a last-known reading beside a live one', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        generated_at: 1_785_495_913,
        account: { claude: READING },
        last_known: { claude: READING, read_at: 1_785_495_000 },
      }).success,
    ).toBe(false);
  });
});

/**
 * #990 — codex on the DISPLAY surface, and nowhere else.
 *
 * Three states, and the tests exist because two of them are easy to conflate:
 * ABSENT (no codex on this host — key omitted), UNREADABLE (`null` + a reason)
 * and a reading. Collapsing absent into unreadable would put a fault on the
 * operator's panel for software they never installed; collapsing unreadable
 * into absent would hide a real failure.
 */
describe('GET /api/quota/display — codex (#990)', () => {
  const CODEX_READING = {
    seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
    read_at: 1_786_106_974,
  };

  async function appWithCodex(
    codexAccountQuotaReader: CodexAccountQuotaReader | null,
    claude: ClaudeAccountQuota | null = READING,
  ): Promise<FastifyInstance> {
    const reading =
      claude === null
        ? ({ value: null, unavailable: 'provider_error' } as const)
        : ({ value: claude, unavailable: null } as const);
    const { app } = await buildTestAppWithContext({
      claudeAccountQuotaReader: { read: async () => reading },
      codexAccountQuotaReader,
    });
    apps.push(app);
    return app;
  }

  it('omits the codex key entirely when codex is ABSENT from the host', async () => {
    const app = await appWithCodex(null);
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();

    expect(body.account).not.toHaveProperty('codex');
    expect(body).not.toHaveProperty('unavailable');
    expect(AccountQuotaDisplayStateSchema.safeParse(body).success).toBe(true);
  });

  it('carries a codex reading with the instant it was scraped at', async () => {
    const app = await appWithCodex({
      read: async () => ({ value: CODEX_READING, unavailable: null }),
    });
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();

    expect(body.account.codex).toEqual(CODEX_READING);
    // A scraped reading MUST state its own age — it is as old as the last codex
    // run, not one TTL old like claude's.
    expect(body.account.codex.read_at).toBe(1_786_106_974);
    expect(body).not.toHaveProperty('unavailable');
    expect(AccountQuotaDisplayStateSchema.safeParse(body).success).toBe(true);
  });

  it('reports an UNREADABLE codex as null WITH a reason, never as a number', async () => {
    const app = await appWithCodex({
      read: async () => ({ value: null, unavailable: 'no_reading' }),
    });
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();

    expect(body.account.codex).toBeNull();
    expect(body.unavailable.codex).toBe('no_reading');
    // Claude's reading is untouched by codex's failure.
    expect(body.account.claude).toEqual(READING);
    expect(body.unavailable).not.toHaveProperty('claude');
    expect(AccountQuotaDisplayStateSchema.safeParse(body).success).toBe(true);
  });

  it("survives a throwing codex reader without losing claude's reading", async () => {
    const app = await appWithCodex({
      read: async () => {
        throw new Error('walk exploded');
      },
    });
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();

    expect(body.account.claude).toEqual(READING);
    expect(body.account.codex).toBeNull();
    expect(body.unavailable.codex).toBe('reader_error');
  });

  /**
   * THE ISOLATION ASSERTION, mirroring #987's.
   *
   * #990: "The spend guard reads only Claude and should keep doing so." The
   * guard's body is a documented compat contract, and a codex read on that
   * route would also spend the guard's `curl --max-time 8` budget walking a
   * filesystem tree — a timeout there does not degrade to a stale number, it
   * spends one of a bounded allowance of BLIND fires.
   */
  it('never puts codex on the guard route, even with a perfectly good reading', async () => {
    const app = await appWithCodex({
      read: async () => ({ value: CODEX_READING, unavailable: null }),
    });
    // Prove the reading is available on the surface that may have it...
    const display = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();
    expect(display.account.codex).toEqual(CODEX_READING);
    // ...and absent from the one that may not.
    const guard = (await app.inject({ method: 'GET', url: '/api/quota' })).json();

    expect(guard.account).not.toHaveProperty('codex');
    expect(guard).not.toHaveProperty('unavailable');
    expect(JSON.stringify(guard)).not.toContain('0.64');
    expect(AccountQuotaStateSchema.safeParse(guard).success).toBe(true);
    // The consumer's own arithmetic still reads claude, unchanged.
    expect(consumerPercent(guard)).toBe(7);
  });

  it('shows codex beside an aged last-known claude reading', async () => {
    const app = await appWithCodex(
      { read: async () => ({ value: CODEX_READING, unavailable: null }) },
      null,
    );
    const body = (await app.inject({ method: 'GET', url: '/api/quota/display' })).json();

    expect(body.account.claude).toBeNull();
    expect(body.unavailable.claude).toBe('provider_error');
    expect(body.account.codex).toEqual(CODEX_READING);
    expect(AccountQuotaDisplayStateSchema.safeParse(body).success).toBe(true);
  });
});

describe('the display schema per-provider iff (#990)', () => {
  const CODEX_READING = {
    seven_day: { utilization: 0.64, resets_at: 1_786_283_144 },
    read_at: 1_786_106_974,
  };
  const base = { generated_at: 1_785_495_913 };

  /**
   * THE REGRESSION #990 OPENS THE DOOR TO.
   *
   * The one-provider refinement tested `unavailable === undefined` on the
   * CONTAINER. With two providers that is satisfied by a codex reason while
   * claude's `null` carries none — the unattributed UNREADABLE #825 exists to
   * remove, re-entering sideways.
   */
  it('REJECTS a null claude whose only reason belongs to codex', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: null, codex: null },
        unavailable: { codex: 'no_reading' },
      }).success,
    ).toBe(false);
  });

  it('REJECTS a reason for a provider that is ABSENT from the body', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: READING },
        unavailable: { codex: 'no_reading' },
      }).success,
    ).toBe(false);
  });

  it('REJECTS a codex reading that also carries a reason for its absence', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: READING, codex: CODEX_READING },
        unavailable: { codex: 'no_reading' },
      }).success,
    ).toBe(false);
  });

  it('REJECTS a null codex with no reason', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: READING, codex: null },
      }).success,
    ).toBe(false);
  });

  it('REJECTS an empty `unavailable` — it says nothing while looking like it does', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: READING },
        unavailable: {},
      }).success,
    ).toBe(false);
  });

  it('REJECTS a codex reading with no windows at all — that is not a reading', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: READING, codex: { read_at: 1_786_106_974 } },
      }).success,
    ).toBe(false);
  });

  it('ACCEPTS a single-window codex reading — the measured plus-plan shape', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: READING, codex: CODEX_READING },
      }).success,
    ).toBe(true);
  });

  it('ACCEPTS each provider in a different state at the same time', () => {
    expect(
      AccountQuotaDisplayStateSchema.safeParse({
        ...base,
        account: { claude: null, codex: CODEX_READING },
        unavailable: { claude: 'rate_limited' },
        last_known: { claude: READING, read_at: 1_785_495_000 },
      }).success,
    ).toBe(true);
  });
});
