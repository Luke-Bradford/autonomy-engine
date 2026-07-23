/**
 * #3 G1 — the ONE canonical JSON serializer for portability surfaces.
 *
 * Identical content MUST serialize to identical bytes no matter how the
 * in-memory object was built (insertion order, spreads, JSON.parse of a
 * key-permuted stored blob): the git file writer (#3 G3) diffs files, and the
 * workspace-import classifier / CAS publish (#3 G5/G6) will compare canonical
 * content — a byte difference must always mean a CONTENT difference.
 *
 * Semantics (each pinned by test):
 * - Object keys sort by UTF-16 code-unit order at every depth; array element
 *   order is preserved (arrays are ordered data, only maps are unordered).
 * - Strings/numbers/booleans/null serialize exactly as `JSON.stringify` does
 *   (same escaping, same number formatting, `-0` → `"0"`).
 * - An OBJECT property whose value is `undefined` is skipped (JSON.stringify
 *   parity — a spread-built envelope carrying one must not 500 the export
 *   route for a value JSON handles fine).
 * - REFUSED loudly (`CanonicalizeError`, with the offending path):
 *   `undefined` at top level or as an ARRAY element (JSON.stringify corrupts
 *   the latter to `null` — a silent shape change), non-finite numbers
 *   (corrupted to `null`), BigInt/function/symbol (unserializable), and any
 *   non-plain object — Date/Map/Set/class instances (JSON.stringify would
 *   call `toJSON`/emit `{}`, both silent shape changes a CANONICAL serializer
 *   must not guess at). Zod-parsed envelope data is plain by construction, so
 *   a refusal here is always a caller bug, never a data state.
 *
 * Deliberately NOT here: content HASHING and the volatile-field exclusion set
 * (id/version/createdAt/catalogVersion/node.position) — those land with their
 * first consumer, the workspace-import classifier (#3 G4/G5), per the
 * no-inert-surface rule. This module owns bytes, not identity.
 */

export class CanonicalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizeError';
  }
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalizeError(
          `Cannot canonicalize non-finite number at ${path} (JSON.stringify would corrupt it to null)`,
        );
      }
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalizeError(`Cannot canonicalize undefined at ${path}`);
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new CanonicalizeError(`Cannot canonicalize a ${typeof value} at ${path}`);
    case 'object':
      break;
    default:
      throw new CanonicalizeError(`Cannot canonicalize a ${typeof value} at ${path}`);
  }

  const obj = value as object;
  if (Array.isArray(obj)) {
    const parts = obj.map((element, i) => {
      if (element === undefined) {
        // JSON.stringify silently writes `null` here — a corruption, not a
        // serialization. Refuse rather than guess.
        throw new CanonicalizeError(`Cannot canonicalize undefined array element at ${path}[${i}]`);
      }
      return serialize(element, `${path}[${i}]`);
    });
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(obj)) {
    throw new CanonicalizeError(
      `Cannot canonicalize a non-plain object at ${path} (Date/Map/class instances have no canonical JSON form)`,
    );
  }

  const record = obj as Record<string, unknown>;
  // Default Array#sort on strings IS UTF-16 code-unit order.
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const propValue = record[key];
    if (propValue === undefined) continue; // JSON.stringify parity — skip
    parts.push(`${JSON.stringify(key)}:${serialize(propValue, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Serialize `value` to canonical JSON bytes (see module doc for semantics). */
export function canonicalStringify(value: unknown): string {
  return serialize(value, '$');
}
