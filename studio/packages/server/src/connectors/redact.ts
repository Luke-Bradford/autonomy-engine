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
  return walk(value, secrets, depth, '');
}

/**
 * #1223 — the serialised form of a value, when that form is NOT its
 * own-enumerable-key form.
 *
 * Rebuilding an object from `Object.entries` is the identity for most values,
 * and silently destructive for the ones that carry a `toJSON`. Measured on node
 * v25.9.0:
 *
 *   Object.entries(new Date())          => []          // the instant, gone
 *   Object.entries(Buffer.from([1,2]))  => [["0",1],…]  // an index map
 *
 * so a `Date` in a node's outputs became `{}` — indistinguishable from an
 * activity that returned an empty object — and a `Buffer` lost its
 * `{type:'Buffer',data:[…]}` form. That happened IN MEMORY before the fold, so
 * the reducer stored the flattened value and every `${nodes.x.output.*}` read it.
 *
 * `toJSON` is exactly where the two forms diverge, which is why it is the test
 * rather than a list of known classes: `Map`/`Set`/a plain class instance (`pg`'s
 * `PostgresInterval`, say) define none, and their JSON form IS their key form, so
 * the existing rebuild is already faithful for them — and must stay, because a
 * secret nested in one still has to be scrubbed.
 *
 * `lookup.ts`'s `logSafe` meets the same values and answers differently on
 * purpose — it REFUSES a value it cannot render honestly, failing the row. It
 * can: a lookup has a failure channel and a wrong decision is worse than none.
 * This walker has neither. It runs mid-dispatch on a node that has already
 * succeeded, so refusing would turn a redaction into an outage; its only
 * permitted answers are the faithful value or the sentinel.
 *
 * A `toJSON` result is NORMALISED, never passed through: it can itself be a
 * string carrying a resolved secret, and this walker's posture is never-leak.
 * A `toJSON` that throws (adversarial adapter output, or a hostile proxy that
 * throws on the property ACCESS) yields the redaction sentinel — never leak,
 * never crash, the same posture as the depth ceiling.
 */
type JsonForm = { kind: 'none' } | { kind: 'value'; value: unknown } | { kind: 'hostile' };

function jsonFormOf(value: object, key: string): JsonForm {
  let method: unknown;
  try {
    method = (value as { toJSON?: unknown }).toJSON;
  } catch {
    return { kind: 'hostile' };
  }
  if (typeof method !== 'function') return { kind: 'none' };
  try {
    // The KEY is passed because `JSON.stringify` passes it (measured: `''` at
    // the root, the property name inside an object, the index as a string inside
    // an array). A `toJSON` that reads it is exotic, but a walker claiming to
    // reproduce serialisation does not get to choose which arguments to honour.
    return { kind: 'value', value: (method as (k: string) => unknown).call(value, key) };
  } catch {
    return { kind: 'hostile' };
  }
}

/**
 * The walk itself. `key` is the property name this value is reached by, because
 * that is what `JSON.stringify` hands a `toJSON`.
 *
 * A `toJSON` RESULT is walked like any other value, so a chain of them runs to
 * its FIXED POINT. That is a deliberate choice over reproducing `stringify`
 * exactly, and the alternative was measured before it was rejected: applying
 * `toJSON` once and rebuilding the result by keys leaves the result's OWN
 * `toJSON` alive in the output, so the downstream serialisation of the event log
 * applies it a second time anyway — `{"a":1}` where the unredacted value gives
 * `{"a":{}}`. "Once" is therefore not reachable from here at all; the honest
 * choices are the fixed point or a walker that drops function-valued keys the
 * way `stringify` does, which would be a behaviour change well outside this fix.
 *
 * The fixed point buys the property that matters: the output contains no live
 * `toJSON`, so **walking it again cannot change it further** (pinned by an
 * idempotence test). It diverges from a single `JSON.stringify` for exactly one
 * shape — a `toJSON` returning another `toJSON`-carrying value — and diverges by
 * PRESERVING what that serialisation would have discarded, which is the safe
 * direction here (#473: never manufacture an absence). The pathological shape,
 * a `toJSON` returning `this`, is bounded by the depth ceiling like any other
 * unbounded value.
 */
function walk(
  value: unknown,
  secrets: readonly (string | null | undefined)[],
  depth: number,
  key: string,
): unknown {
  // At the ceiling, redact the whole remaining subtree — conservatively assume
  // it could carry a secret we can no longer walk to, and never overflow.
  if (depth >= MAX_REDACT_DEPTH) return '***';
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (value !== null && typeof value === 'object') {
    // BEFORE the array branch, because `JSON.stringify` applies `toJSON` before
    // it looks at the type: an array (or an Array subclass) carrying one
    // serialises as that result, and dispatching on `isArray` first would walk
    // its elements and discard the result unwalked — a string that could carry a
    // secret, never produced and so never scrubbed.
    const form = jsonFormOf(value, key);
    if (form.kind === 'hostile') return '***';
    if (form.kind === 'value') return walk(form.value, secrets, depth + 1, key);
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, secrets, depth + 1, String(i)));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      setDataProperty(out, k, walk(v, secrets, depth + 1, k));
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
  // Through `walk` rather than `deepRedactSecrets` for one reason: the record's
  // own key is the key a value's `toJSON` must be handed (#1223), and the public
  // entry point has no way to say so.
  for (const [k, v] of Object.entries(record)) setDataProperty(out, k, walk(v, secrets, 0, k));
  return out;
}
