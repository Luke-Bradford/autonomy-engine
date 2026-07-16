import { z } from 'zod';

/**
 * A `SecretRef` MARKER — the structured JSON a config field carries to reference
 * a standalone secret by NAME (item 7 / S2, the unified secret model,
 * `docs/2026-07-16-foundation-unified-secret-model.md` §2).
 *
 * Shape: `{ "$secret": "<name>" }`, deliberately NOT a `${}` string. A secure
 * value must stay OUT of the inert expression language (#1 D8: "a secure value
 * can't drive typed `${}`"; the engine invariant "`${}` stays INERT",
 * `engine/executor` side). A distinguished object sidesteps `substitute`/the
 * typer/the evaluator entirely: `substitute` recurses into objects and returns
 * the non-`${}` name string byte-for-byte (`engine/params.ts` object recursion),
 * so the marker survives the pure path untouched and is resolved ONLY at
 * dispatch (S3), never in the reducer.
 *
 * `.strict()` is load-bearing: a marker with an extra key (`{$secret:"x",y:1}`)
 * or a non-string `$secret` MUST be rejected by the save-time gate, not silently
 * treated as ordinary config (which would be fail-OPEN — a marker that does
 * nothing). The gate detects a marker loosely (`isSecretRef`) and then validates
 * it strictly with this schema; the two together close that seam.
 *
 * The `$secret` value is a LITERAL name here (`z.string().min(1)`); the ADDED
 * rule that it may not itself contain a `${}` expression is enforced by the
 * save-time gate (`validateRefs`), not the schema — the schema has no access to
 * the interpolation classifier and a name is a plain string at rest.
 */
export const SecretRefSchema = z.object({ $secret: z.string().min(1) }).strict();
export type SecretRef = z.infer<typeof SecretRefSchema>;

/**
 * LOOSE detector: is `v` shaped like a `SecretRef` marker (a non-null, non-array
 * object with an own `$secret` key)? Used by the config walkers to DECIDE a
 * value is a marker ATTEMPT — the strict `SecretRefSchema` then validates it.
 *
 * Deliberately loose (an own `$secret` key, nothing more) so a MALFORMED marker
 * still trips the gate rather than slipping through as plain config. `$secret`
 * is a reserved marker key by construction; a config object may not use it as an
 * ordinary field name.
 *
 * The predicate narrows to `{ $secret: unknown }`, NOT `SecretRef` — the check
 * proves only that the key EXISTS, never that its value is a non-empty string.
 * Claiming `v is SecretRef` here would be an unsound cast: `{ $secret: 123 }`
 * would type-narrow to `SecretRef` and let a caller read `.$secret as string`
 * without ever re-running `SecretRefSchema`. Callers that need the validated
 * shape (a literal name) must still `SecretRefSchema.safeParse` — which is
 * exactly what the save-time gate does (`validateSecretMarker`).
 */
export function isSecretRef(v: unknown): v is { $secret: unknown } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.prototype.hasOwnProperty.call(v, '$secret')
  );
}
