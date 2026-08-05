import { describe, expect, it } from 'vitest';
import {
  LOGGED_URL_REDACT_PATHS,
  censorLoggedUrl,
  redactUrlSecrets,
  redactingLogMethod,
} from '../log-redaction.js';

const TOKEN = 'dFQNUwHu8QnSunZgInvCfftmaBFex1EoSTs4GYlFLu4';

describe('redactUrlSecrets', () => {
  it('replaces the capability segment of an external-wait callback URL', () => {
    expect(redactUrlSecrets(`/api/external-wait/${TOKEN}`)).toBe('/api/external-wait/***');
  });

  it('takes the query string with it — a token could be followed by anything', () => {
    expect(redactUrlSecrets(`/api/external-wait/${TOKEN}?replay=1`)).toBe('/api/external-wait/***');
  });

  it('redacts a token EMBEDDED in a sentence, stopping at whitespace', () => {
    // Fastify's own 404 log line: `Route ${method}:${url} not found`. The trailing
    // words are not secret and must survive, or the line stops saying what happened.
    expect(redactUrlSecrets(`Route GET:/api/external-wait/${TOKEN} not found`)).toBe(
      'Route GET:/api/external-wait/*** not found',
    );
  });

  it('redacts EVERY occurrence, not just the first', () => {
    expect(redactUrlSecrets(`/api/external-wait/${TOKEN} vs /api/external-wait/other`)).toBe(
      '/api/external-wait/*** vs /api/external-wait/***',
    );
  });

  it('leaves an unrelated URL completely intact', () => {
    expect(redactUrlSecrets('/api/runs/abc123/external-waits')).toBe(
      '/api/runs/abc123/external-waits',
    );
  });

  it('leaves the prefix alone when it carries no token', () => {
    // No trailing slash means no capability segment — nothing to hide.
    expect(redactUrlSecrets('/api/external-wait')).toBe('/api/external-wait');
  });

  it('redacts an empty capability segment too, rather than reasoning about it', () => {
    expect(redactUrlSecrets('/api/external-wait/')).toBe('/api/external-wait/***');
  });
});

describe('censorLoggedUrl', () => {
  it('redacts a string value', () => {
    expect(censorLoggedUrl(`/api/external-wait/${TOKEN}`)).toBe('/api/external-wait/***');
  });

  it('passes an unrelated URL through, so the route stays observable', () => {
    expect(censorLoggedUrl('/health')).toBe('/health');
  });

  it('redacts a NON-string value wholesale rather than passing it through', () => {
    // Fail-safe: the censor cannot inspect a shape it does not understand, so it
    // must not hand it back. `req.url` is a string on every Fastify path today —
    // this is the branch that keeps a future non-string from leaking silently.
    expect(censorLoggedUrl({ toString: () => `/api/external-wait/${TOKEN}` })).toBe('***');
    expect(censorLoggedUrl(undefined)).toBe('***');
  });

  it('targets req.url — the path Fastify serializes the request URL onto', () => {
    expect(LOGGED_URL_REDACT_PATHS).toEqual(['req.url']);
  });
});

describe('redactingLogMethod', () => {
  /** Invoke the real hook with a recording `method`, and report what it forwarded.
   * The single cast stands in for pino's `LogFn`/`Logger` types, which this package
   * deliberately does not depend on directly. */
  function forwarded(args: unknown[]): unknown[] {
    const calls: unknown[][] = [];
    const method = (...a: unknown[]) => {
      calls.push(a);
    };
    (redactingLogMethod as unknown as (...a: unknown[]) => void).call({}, args, method, 30);
    expect(calls).toHaveLength(1);
    return calls[0] as unknown[];
  }

  it('redacts a bare message string', () => {
    expect(forwarded([`Route GET:/api/external-wait/${TOKEN} not found`])).toEqual([
      'Route GET:/api/external-wait/*** not found',
    ]);
  });

  it('redacts a message that follows a merging object, and keeps the object in place', () => {
    const obj = { reqId: 'req-1' };
    const out = forwarded([obj, `hit /api/external-wait/${TOKEN}`]);
    expect(out).toEqual([obj, 'hit /api/external-wait/***']);
    // The merging object is passed through by REFERENCE — the hook copies the
    // argument list, never the arguments.
    expect(out[0]).toBe(obj);
  });

  it('redacts interpolation ARGUMENTS as well as the format string', () => {
    expect(forwarded(['got %s', `/api/external-wait/${TOKEN}`])).toEqual([
      'got %s',
      '/api/external-wait/***',
    ]);
  });

  it('forwards a log call with nothing to redact unchanged', () => {
    const err = new Error('boom');
    expect(forwarded([{ err }, 'incoming request'])).toEqual([{ err }, 'incoming request']);
  });
});
