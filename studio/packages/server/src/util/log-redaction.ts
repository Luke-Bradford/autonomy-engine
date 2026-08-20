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
 * Route bases after which EVERYTHING is treated as a secret.
 *
 * ONE entry today, and that is the honest count rather than an oversight. To re-run
 * the enumeration: list every registered route path and check where the credential
 * travels. `/api/webhooks/:triggerId` authenticates by HMAC over the
 * `x-webhook-timestamp`/`x-webhook-signature` HEADERS and `triggerId` is a
 * non-secret id; `/api/workspace/git/token` takes its token in the POST BODY;
 * `/api/triggers/:id/webhook-secret` and `GET /api/runs/:id/external-waits` reveal
 * secrets in a RESPONSE BODY — a channel of its own, closed separately by #925
 * with `routes/util.ts`'s `noStore` on exactly those two.
 *
 * That set and THIS one are DIFFERENT lists, deliberately, and conflating them
 * would send the next route to the wrong array: this array holds routes whose
 * secret is in their own URL (one — the callback seam), `noStore`'s holds routes
 * whose secret is in their response body (two — neither of them this one). What
 * the two share is the ENUMERATION: "where does a credential travel?" has to be
 * re-answered for both channels when a route is added, and a route can easily
 * belong to one, both, or neither. Headers and bodies are
 * not logged by Fastify's serializers, so the URL path is the only leaking channel
 * here — and this is the only path that carries a secret through it.
 *
 * Written WITHOUT the trailing slash on purpose; see `SECRET_URL_PATTERNS`.
 */
const SECRET_URL_ROUTE_BASES = ['/api/external-wait'];

/**
 * The same `***` the connectors' error-message redaction uses
 * (`connectors/redact.ts`), by CONVENTION and not by import — deliberately.
 * `connectors/redact.ts` exports no constant for it, and the two are not one fact:
 * that one hides secret VALUES inside a connector's error text, this one hides a
 * capability inside a URL. Importing across would assert they must change together,
 * which is not true; a reader who changes one should have to decide about the other.
 */
const SENTINEL = '***';

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The route base, then EVERY following non-whitespace character — case-insensitively.
 *
 * Three deliberate choices, each of which was a leak before it was made:
 *
 *  1. **Non-whitespace rather than end-of-string**, because the URL is sometimes
 *     EMBEDDED in a sentence: Fastify's unmatched-route line is
 *     `Route GET:<url> not found`, and the trailing words are not secret — dropping
 *     them would leave a line that no longer says what happened. A query string has
 *     no whitespace, so it is taken along with the token, which is the safe
 *     direction (anything after a capability segment is as suspect as it is).
 *
 *  2. **Case-INSENSITIVE**, because the logged URL is never normalized. Both sites
 *     log `request.raw.url` — Node's verbatim request target — and both log it
 *     BEFORE the router has seen the path, so a request to `/API/external-wait/<tok>`
 *     404s with the live token intact in the message. Reachable without any
 *     adversary: a URL rewriter, a WAF path normalizer, or a person retyping the
 *     callback URL.
 *
 *  3. **Any non-whitespace tail, rather than an explicit separator**, so the rule is
 *     agnostic to how the separator is ENCODED — `/`, `%2F`, `%252F` and anything
 *     else all fall inside the tail. Enumerating encodings is a game this cannot win;
 *     matching everything after the base cannot lose it. The cost is that a future
 *     sibling route sharing this prefix (say `/api/external-wait-status`) would be
 *     redacted too. That is the fail-safe direction, and it is why the base is
 *     stored without its trailing slash: `/api/external-wait` with NOTHING after it
 *     carries no capability and is left alone, which is what keeps the redaction
 *     from claiming a token was present when none was.
 *
 * The base is CAPTURED and re-emitted rather than substituted from the table, so the
 * casing that was actually on the wire survives into the log — an oddly-cased probe
 * stays visible as one.
 *
 * RESIDUAL LIMIT, stated rather than papered over: a URL that reaches the log with
 * the BASE ITSELF encoded (`/%2Fapi%2Fexternal-wait%2F<tok>`) does not match and
 * would still leak. No ordinary client produces that — a browser handed a callback
 * URL does not encode the path it is fetching — and the honest fix for the whole
 * class is not a better regex but option (2) below: taking the token out of the URL.
 */
const SECRET_URL_PATTERNS = SECRET_URL_ROUTE_BASES.map(
  (base) => new RegExp(`(${escapeRegExp(base)})\\S+`, 'gi'),
);

/** Replace every URL-borne capability in `text` with its route base + `/***`. */
export function redactUrlSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_URL_PATTERNS) {
    out = out.replace(pattern, `$1/${SENTINEL}`);
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
 * `fastify`, not `pino`, so pino's types cannot be named here without a phantom
 * dependency on a transitive package.
 *
 * Deriving the signature from `PinoLoggerOptions['hooks']` was tried first and does
 * not work: `fastify.d.ts` imports that type internally but never re-exports it, so
 * naming it is a hard `TS2305 no exported member`, which then cascades into
 * implicit-`any` parameters. The same applies to Fastify's own
 * `FastifyLoggerStreamDestination` — structurally identical to `loggerStream` above,
 * and equally unexported. Saying both shapes out loud beats deep-importing
 * `fastify/types/logger.js`.
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
