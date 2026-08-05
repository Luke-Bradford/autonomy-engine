/**
 * #913 — keep a URL-borne capability token out of the server log.
 *
 * `POST /api/external-wait/:token` (#4 A13) carries its capability in the URL PATH,
 * and holding that token IS the authorization to complete the parked wait. Fastify's
 * request logger prints the URL at level 30, so with a bare `logger: true` every
 * inbound callback wrote a live bearer credential into the log in plaintext — the
 * artifact most likely to be pasted into an issue, shipped to an aggregator or
 * bundled into a support archive. The token is single-use, attempt-scoped and
 * expiring, so the window is bounded; inside that window the log IS the credential.
 *
 * This module is the ONE rule; `buildApp` installs it at both of Fastify's
 * URL-printing sites, which leak by different mechanisms:
 *   - `incoming request` carries the URL as a `req.url` FIELD → closed by pino
 *     `redact` with `censorLoggedUrl` (a function censor, so an unrelated route
 *     stays legible instead of every URL becoming `[Redacted]`).
 *   - the unmatched-route line formats the URL INTO a message string
 *     (`Route ${method}:${url} not found`) → no `redact` path can reach that, so it
 *     is closed by `redactingLogMethod`. That line is reachable with a LIVE token:
 *     a human handed a callback URL pastes it into a browser, which GETs it.
 *
 * It is a PATH-PREFIX rule, not a "looks like a secret" heuristic: the redaction
 * must not depend on the token's shape (it is an opaque HMAC digest that a future
 * change could re-encode), and it must not fire on unrelated ids that happen to
 * look random.
 *
 * NOT covered, deliberately: the fix is option (1) of #913. Moving the token out of
 * the URL entirely (option 2 — URLs also leak via `Referer`, proxies and browser
 * history) is a breaking change to a published external contract and belongs with
 * the A16 outbound half (#583). Also not covered: a call that logs a URL as an
 * OBJECT field other than `req.url` (e.g. `log.info({ target: someUrl })`) — such a
 * call would need its own redact path; no site does this today.
 */

/**
 * Path prefixes after which the remainder of a URL is a secret.
 *
 * ONE entry today, and that is the honest count rather than an oversight. To re-run
 * the enumeration: list every registered route path and check where the credential
 * travels. `/api/webhooks/:triggerId` authenticates by HMAC over the
 * `x-webhook-timestamp`/`x-webhook-signature` HEADERS and `triggerId` is a
 * non-secret id; `/api/workspace/git/token` takes its token in the POST BODY;
 * `/api/triggers/:id/webhook-secret` and `GET /api/runs/:id/external-waits` reveal
 * secrets in a RESPONSE BODY. Headers and bodies are not logged by Fastify's
 * serializers, so the URL path is the only leaking channel — and this is the only
 * path that carries a secret through it.
 */
const SECRET_URL_PREFIXES = ['/api/external-wait/'];

/** Matches the connectors' redaction sentinel (`connectors/redact.ts`). */
const SENTINEL = '***';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `prefix` + every following non-whitespace character. Non-whitespace rather than
 * end-of-string because the URL is sometimes EMBEDDED in a sentence: Fastify's
 * unmatched-route line is `Route GET:<url> not found`, and the trailing words are
 * not secret — dropping them would leave a line that no longer says what happened.
 * A query string has no whitespace, so it is taken along with the token, which is
 * the safe direction (anything after a capability segment is as suspect as it is).
 */
const SECRET_URL_PATTERNS = SECRET_URL_PREFIXES.map(
  (prefix) => [new RegExp(`${escapeRegExp(prefix)}\\S*`, 'g'), `${prefix}${SENTINEL}`] as const,
);

/** Replace every URL-borne capability in `text` with its path prefix + `***`. */
export function redactUrlSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_URL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** The pino `redact.paths` this censor is installed on: where Fastify's default
 * request serializer puts the URL. */
export const LOGGED_URL_REDACT_PATHS = ['req.url'];

/**
 * pino `redact.censor` for {@link LOGGED_URL_REDACT_PATHS}.
 *
 * A non-string value is replaced WHOLESALE rather than passed through: the censor
 * cannot inspect a shape it does not understand, and handing back an object whose
 * `toString` carries the token would defeat the point. `req.url` is a string on
 * every Fastify path today, so this branch exists to keep a future change from
 * leaking silently — fail-safe, the same posture as the merge gate's "a `gh`
 * failure is never CI-green".
 */
export function censorLoggedUrl(value: unknown): string {
  return typeof value === 'string' ? redactUrlSecrets(value) : SENTINEL;
}

/**
 * The log method the hook wraps. Typed STRUCTURALLY rather than as pino's `LogFn`,
 * for the same reason `BuildAppOptions.loggerStream` is: this package declares
 * `fastify`, not `pino`, so pino's types are not resolvable here — deriving the hook
 * signature from `PinoLoggerOptions['hooks']` silently yields `any` (the import
 * inside fastify's own `.d.ts` fails and `skipLibCheck` swallows it), which is worse
 * than saying the shape out loud.
 */
type LogFnLike = (this: unknown, ...args: unknown[]) => void;

/**
 * pino `hooks.logMethod` that redacts every STRING argument of every log call —
 * the format string, a message following a merging object, and any interpolation
 * argument. This is what closes Fastify's unmatched-route line, whose URL is inside
 * the message rather than in a field.
 *
 * The hook is inherited by Fastify's per-request child loggers, so it covers
 * `request.log.*` as well as the root logger. It runs on EVERY log call, so it is
 * copy-on-write: a call with nothing to redact is forwarded byte-identical, with no
 * array allocated. It also cannot throw — `redactUrlSecrets` is string replacement
 * over a value already known to be a string.
 */
export function redactingLogMethod(this: unknown, args: unknown[], method: LogFnLike): void {
  let redacted: unknown[] | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    const clean = redactUrlSecrets(arg);
    if (clean === arg) continue;
    redacted ??= args.slice();
    redacted[i] = clean;
  }
  method.apply(this, redacted ?? args);
}
