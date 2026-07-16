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
 * Item 7 / S3 — the STRUCTURED-value counterpart of `redactSecrets`, for a
 * `node.output`/`node.succeeded.outputs` value an adapter might echo a resolved
 * secret into. Recurses objects/arrays and `redactSecrets`-scrubs every STRING
 * leaf; non-string leaves (number/boolean/null) pass through untouched — a
 * secret is a string, so only string leaves can carry one. The tree is rebuilt
 * (never mutated in place). Same accepted tradeoff as `redactSecrets`: a
 * legitimate string that merely CONTAINS a secret substring is redacted too —
 * the safe side, and unavoidable without provenance tracking.
 *
 * The executor runs this ONLY when a node actually resolved config-sink secrets
 * (the plaintext list is non-empty), so it is a strict no-op — never walked —
 * for every activity that declares no secret sink.
 */
export function deepRedactSecrets(
  value: unknown,
  secrets: readonly (string | null | undefined)[],
): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((v) => deepRedactSecrets(v, secrets));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepRedactSecrets(v, secrets);
    }
    return out;
  }
  return value;
}
