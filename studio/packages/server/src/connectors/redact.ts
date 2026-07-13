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
