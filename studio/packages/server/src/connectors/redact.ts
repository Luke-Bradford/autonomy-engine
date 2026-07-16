/**
 * P3b — secret redaction for connector error messages. A caught error thrown by
 * `fetch`/the runtime can embed a value we passed IN — most dangerously, Node's
 * header-validation `TypeError` quotes the offending header value verbatim
 * (`Headers.append: "<value>" is an invalid header value.`). When that value is
 * a resolved API-key secret (a key with an embedded CR/LF, say), echoing the
 * error into a durable `node.failed` event would leak the plaintext key at rest.
 *
 * Every adapter that echoes an error message therefore redacts its OUTGOING
 * header/secret values first. Redaction is a literal substring replace (no regex
 * escaping pitfalls); an empty/nullish value is skipped so it can never turn a
 * whole message into `***`.
 */
export function redactSecrets(
  message: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = message;
  for (const s of secrets) {
    if (s !== null && s !== undefined && s.length > 0) {
      out = out.split(s).join('***');
    }
  }
  return out;
}

/**
 * The recursion ceiling for `deepRedactSecrets`. Unlike the static-config
 * walkers (which run on an author-controlled doc), this runs on ADAPTER OUTPUT —
 * an external, potentially adversarial response body — so an unbounded walk
 * could stack-overflow the process on a pathologically deep value. A structured
 * output that legitimately nests this deep does not exist, so the cap only ever
 * trips on hostile input; when it does, the over-deep subtree is replaced
 * WHOLESALE with the redaction sentinel (below) rather than walked — fail-SAFE
 * (never leak, never crash), the same never-leak posture as `redactSecrets`.
 */
const MAX_REDACT_DEPTH = 100;

/**
 * Set an OWN data property, faithfully — even for a key named `__proto__`. Plain
 * `out[k] = v` treats `__proto__` as the prototype accessor, so a JSON-sourced
 * field literally named `__proto__` (a real own property after `JSON.parse`)
 * would silently vanish or mutate the prototype instead of round-tripping. This
 * choke point walks ADVERSARIAL external adapter output, so it must copy every
 * key as data, not as a magic accessor. `Object.defineProperty` writes an own
 * data property regardless of the key.
 */
function setDataProperty(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Item 7 / S3 — the STRUCTURED-value counterpart of `redactSecrets`, for a
 * `node.output`/`node.succeeded.outputs` value an adapter might echo a resolved
 * secret into. Recurses objects/arrays and `redactSecrets`-scrubs every STRING
 * leaf; non-string leaves (number/boolean/null) pass through untouched — a
 * secret is a string, so only string leaves can carry one. The tree is rebuilt
 * (never mutated in place). Same accepted tradeoff as `redactSecrets`: a
 * legitimate string that merely CONTAINS a secret substring is redacted too —
 * the safe side, and unavoidable without provenance tracking. Recursion is
 * bounded by `MAX_REDACT_DEPTH` (see there) — a subtree deeper than that is
 * replaced by the sentinel rather than walked.
 *
 * The executor runs this ONLY when a node actually resolved config-sink secrets
 * (the plaintext list is non-empty), so it is a strict no-op — never walked —
 * for every activity that declares no secret sink.
 */
export function deepRedactSecrets(
  value: unknown,
  secrets: readonly (string | null | undefined)[],
  depth = 0,
): unknown {
  // At the ceiling, redact the whole remaining subtree — conservatively assume
  // it could carry a secret we can no longer walk to, and never overflow.
  if (depth >= MAX_REDACT_DEPTH) return '***';
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => deepRedactSecrets(v, secrets, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      setDataProperty(out, k, deepRedactSecrets(v, secrets, depth + 1));
    }
    return out;
  }
  return value;
}

/**
 * A typed wrapper of `deepRedactSecrets` for a `Record` value (a node's
 * `outputs` map). Rebuilds the record's own values, each deep-redacted, so the
 * caller gets a `Record<string, unknown>` back with NO unchecked cast — the
 * top-level shape is known (it is the outputs map), only the values are opaque.
 */
export function deepRedactRecord(
  record: Record<string, unknown>,
  secrets: readonly (string | null | undefined)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record))
    setDataProperty(out, k, deepRedactSecrets(v, secrets));
  return out;
}
