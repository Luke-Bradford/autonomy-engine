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
 * The same ceiling on the other axis. `MAX_REDACT_DEPTH` bounds how DEEP a
 * hostile value can drive the walk; this bounds how WIDE. It exists because an
 * array's length is a READ, and a proxy's `get` trap may answer with a number
 * that is a perfectly well-formed count and still a lie — `Number.MAX_SAFE_INTEGER`
 * passes every finite/integer/non-negative check there is, so an index loop over
 * it runs for hours over a backing array of one element. (Measured: the bare
 * `.map` this walker used to call was accidentally safe here, because
 * `ArraySpeciesCreate` throws `RangeError: Invalid array length` above 2^32-1.
 * An explicit loop has no such accident, so it needs an explicit bound.)
 *
 * Above the ceiling the whole array is replaced WHOLESALE with the sentinel
 * rather than TRUNCATED, for the reason truncation is refused everywhere in this
 * file: a short array claims the elements it dropped never existed, which is
 * #473's shape — an absence manufactured from a failure. `***` says "not
 * walked", which is the truth.
 *
 * A million is far above any legitimate adapter output that would be walked into
 * a run log and far below a runtime a caller would notice, so like the depth cap
 * this only ever trips on hostile input.
 */
const MAX_REDACT_BREADTH = 1_000_000;

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
 * #1223 — enumerate an object's own string keys WITHOUT executing any of it,
 * and read each value under guard.
 *
 * `Object.entries` does both at once, and the reading half invokes every own
 * enumerable GETTER. A getter that throws sends its message straight out of the
 * walker uncaught — and that message is exactly the kind this file's header
 * exists to stop being echoed, because a runtime error routinely quotes the
 * value it choked on. Measured: `Object.entries({get auth(){throw new
 * Error('boom sk-x')}})` throws `boom sk-x`, plaintext and all, from the one
 * function whose job is to make sure that string never travels.
 *
 * `Object.keys` invokes no accessor, so the split is: enumerate safely, then
 * read each key inside its own try. Per KEY rather than per object, so one
 * hostile accessor costs its own value and not its siblings'.
 */
function ownKeysOf(value: object): string[] | null {
  try {
    return Object.keys(value);
  } catch {
    // A proxy may refuse to be enumerated at all. There is nothing to walk and
    // nothing partial to keep.
    return null;
  }
}

function readOwn(value: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    // Bracket access, not a descriptor read: a getter's VALUE is what serialises,
    // so it has to be invoked — just not unguarded. An own `__proto__` data
    // property shadows the prototype accessor, so this stays faithful for the
    // JSON-sourced key `setDataProperty` exists to preserve.
    return { ok: true, value: (value as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
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
 * idempotence test). It diverges from a single `JSON.stringify` for one shape —
 * a `toJSON` returning another `toJSON`-carrying value — and diverges by
 * PRESERVING what that serialisation would have discarded, which is the safe
 * direction here (#473: never manufacture an absence). The pathological shape,
 * a `toJSON` returning `this`, is bounded by the depth ceiling like any other
 * unbounded value.
 *
 * One further difference, stated so the claim above is not read as broader than
 * it is: a `toJSON` returning `undefined` leaves the key PRESENT with an
 * `undefined` value, where `JSON.stringify` drops the key. That is not new and
 * not specific to `toJSON` — this walker has always preserved an
 * `undefined`-valued key — and the two forms converge the moment the output is
 * serialised into the event log. Worth knowing only for a reader inspecting the
 * in-memory value with `in` or `Object.keys`, which `toEqual` cannot see either.
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
      // Guarded per ELEMENT, exactly as the object branch below is. `.map` reads
      // every index bare, so an element backed by a throwing getter (or a proxy
      // `get` trap) propagated the exception straight out of `walk` — and an
      // exception message is precisely where the plaintext we were called to
      // scrub ends up. One hostile index must not cost its siblings.
      //
      // The LENGTH is a read of its own, and on a proxy a trap that can throw or
      // answer with something that is not a count. That is the array's analogue
      // of an object that refuses enumeration: nothing can be walked and nothing
      // partial is worth keeping, so the whole value takes the sentinel rather
      // than a truncated array claiming the elements it could not reach never
      // existed (#473). Each lie fails its own way, all measured: a NEGATIVE
      // length makes `.map` return `[]`, fabricating an empty array; an INFINITE
      // one makes it throw `RangeError: Invalid array length` out of the walk;
      // an ENORMOUS but well-formed one passes every check a count can pass and
      // is caught by `MAX_REDACT_BREADTH` (see there) instead.
      //
      // A HOLE reads as `undefined` here and is kept as a present element, where
      // `.map` propagated the hole. `JSON.stringify` renders both as `null`, so
      // the serialised form this walker feeds is unchanged — the same
      // present-vs-absent divergence the `toJSON`-returns-`undefined` note above
      // describes, and visible only to an in-memory `Object.keys`.
      const lengthRead = readOwn(value, 'length');
      const length = lengthRead.ok ? lengthRead.value : null;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return '***';
      if (length > MAX_REDACT_BREADTH) return '***';
      const out: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        const read = readOwn(value, String(i));
        out.push(read.ok ? walk(read.value, secrets, depth + 1, String(i)) : '***');
      }
      return out;
    }
    const keys = ownKeysOf(value);
    if (keys === null) return '***';
    // The ceiling's object sibling, and NOT its equal — stated here because the
    // symmetry is tempting and wrong. The array branch reads `length` in O(1)
    // and rejects BEFORE touching an element. This one can only count keys that
    // `Object.keys` has already materialised, so an `ownKeys` trap claiming
    // 100M keys still costs that enumeration before the ceiling sees it.
    //
    // That gap is irreducible, not unfixed: JS has no lazy own-key enumeration.
    // `Reflect.ownKeys` was measured as the obvious alternative and is no better
    // — 2.0s vs `Object.keys`' 1.7s on a 5M-key proxy — because the dominant
    // cost is materialising and validating the trap's array, which the attacker
    // had to build in the first place. There is no amplification at that step.
    //
    // The amplification is in the WALK, which is what this ceiling does bound: a
    // guarded read, a recursion and a scan of every secret per key, all of it
    // far dearer than the enumeration. Measured on the 1M-key case: 1.15s for
    // the whole ceiling-tested set, against 4.8s for the walk alone without it.
    if (keys.length > MAX_REDACT_BREADTH) return '***';
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const read = readOwn(value, k);
      setDataProperty(out, k, read.ok ? walk(read.value, secrets, depth + 1, k) : '***');
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
  // A record that refuses to be enumerated is the ONE place the sentinel cannot
  // be expressed — this returns a `Record`, so there is no value to stand in for
  // the whole map. Inventing an empty one would be #473's shape exactly: an
  // absence manufactured out of a failure, indistinguishable from a node that
  // genuinely produced no outputs. So it refuses, with a message of its own that
  // carries no plaintext.
  const keys = ownKeysOf(record);
  if (keys === null) throw new Error('outputs could not be enumerated for redaction');
  // Wider than the breadth ceiling is the same situation as unenumerable, for
  // the same reason: no value can stand in for the whole map, and a truncated
  // one would claim the dropped keys never existed. So it refuses here too.
  if (keys.length > MAX_REDACT_BREADTH) throw new Error('outputs had too many keys to redact');
  const out: Record<string, unknown> = {};
  // Through `walk` rather than `deepRedactSecrets` for one reason: the record's
  // own key is the key a value's `toJSON` must be handed (#1223), and the public
  // entry point has no way to say so.
  for (const k of keys) {
    const read = readOwn(record, k);
    setDataProperty(out, k, read.ok ? walk(read.value, secrets, 0, k) : '***');
  }
  return out;
}
