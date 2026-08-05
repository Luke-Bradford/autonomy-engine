import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestAppWithContext } from './build-test-app.js';

/**
 * #913 — the request logger must never write an external-wait capability token.
 *
 * `POST /api/external-wait/:token` carries the capability in the URL PATH, and
 * holding that token IS the authorization to complete the parked wait. Fastify's
 * default request logging prints the URL at level 30, so before this wiring every
 * inbound callback wrote a live bearer credential into the server log in plaintext.
 *
 * This suite tests the WIRING (that `buildApp` installs the redaction), not the
 * string rule — `util/__tests__/log-redaction.test.ts` owns that. It matters that
 * it is a separate file: the leak happens on the request-log line, which is emitted
 * BEFORE the handler and is outcome-independent, so a junk token reproduces it
 * exactly as a live one does and this suite needs none of `external-wait.test.ts`'s
 * park-a-run scaffolding.
 *
 * Both of Fastify's URL-printing sites are covered, because they leak by DIFFERENT
 * mechanisms and one fix does not imply the other: the `incoming request` line
 * carries the URL as a `req.url` FIELD (closed by pino `redact`), while the
 * unmatched-route line carries it inside a formatted `msg` STRING that no `redact`
 * path can reach (closed by the `hooks.logMethod` wrapper). The GET case is not
 * hypothetical — a human handed a callback URL pastes it into a browser, which
 * GETs it, and `onBadUrl`/`onMaxParamLength` funnel to the same handler.
 */
describe('#913 request-log redaction wiring', () => {
  /** Deliberately high-entropy and unmistakable: if this string appears ANYWHERE in
   * the captured log, a token would have appeared there too. */
  const TOKEN = 'ZZtokenLEAKCANARY0123456789abcdefZZ';

  let app: FastifyInstance;
  const lines: string[] = [];

  beforeAll(async () => {
    const built = await buildTestAppWithContext({
      loggerStream: {
        write(msg: string) {
          lines.push(msg);
        },
      },
    });
    app = built.app;
    await app.inject({ method: 'POST', url: `/api/external-wait/${TOKEN}` });
    await app.inject({ method: 'GET', url: `/api/external-wait/${TOKEN}` });
    // Neither log site normalizes the path (both print the verbatim request target,
    // before routing), so a mis-cased or encoded variant carries a LIVE token into
    // the log too. End-to-end here, not only in the rule's own unit tests.
    await app.inject({ method: 'GET', url: `/API/external-wait/${TOKEN}` });
    await app.inject({ method: 'POST', url: `/api/external-wait%2F${TOKEN}` });
    // An EXISTING route, on purpose: a 404 here would emit an extra unmatched-route
    // line and blur which site the assertions below are reading.
    await app.inject({ method: 'GET', url: '/health' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('captured the log at all', () => {
    // Guards every negative assertion below from passing vacuously: with no
    // `loggerStream` wiring, `lines` would be empty and "does not contain the
    // token" would be trivially true.
    expect(lines.length).toBeGreaterThan(0);
  });

  it('never writes the raw capability token, on any line, from any site', () => {
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('still logs the external-wait ROUTE, with the capability replaced', () => {
    // The point of a censor over a blanket `[Redacted]`: an operator must still be
    // able to see that a callback arrived.
    expect(lines.some((l) => l.includes('"url":"/api/external-wait/***"'))).toBe(true);
  });

  it("redacts Fastify's unmatched-route line, which carries the URL inside a msg string", () => {
    expect(lines.some((l) => l.includes('Route GET:/api/external-wait/*** not found'))).toBe(true);
  });

  it('leaves an unrelated URL intact', () => {
    expect(lines.some((l) => l.includes('"url":"/health"'))).toBe(true);
  });
});
