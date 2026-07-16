import { z } from 'zod';

/**
 * A single entry in an error body's `issues[]`: a dotted `path` into the
 * offending input (omitted for the doc-write gate, whose messages are already
 * fully-qualified) and a human-readable `message`. Both optional so the one
 * shape covers the Zod-issue branch (`{ path, message }`) and the
 * `invalid_pipeline_doc` branch (`{ message }`) alike.
 */
export const ApiErrorIssueSchema = z.object({
  path: z.string().optional(),
  message: z.string().optional(),
});
export type ApiErrorIssue = z.infer<typeof ApiErrorIssueSchema>;

/**
 * The closed vocabulary of `error` codes the central error handler emits (one
 * per branch of `@autonomy-studio/server`'s `errors.ts`). Enumerated — not a
 * bare `string` — so it is a genuine drift guard on BOTH sides: a typo'd code
 * in a server `.send({ error: … })` fails the `satisfies ApiErrorBody` check at
 * compile time (the exact drift this contract exists to catch), and the code
 * is the SSOT both sides derive from. The inbound-webhook routes that answer
 * before the central handler use free-form `error` strings and are out of
 * scope (they are not `apiFetch`-consumed) — see `ApiErrorBodySchema`.
 */
export const ApiErrorCodeSchema = z.enum([
  'validation_error',
  'not_found',
  'conflict',
  'import_error',
  'invalid_pipeline_doc',
  'bad_request',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * The ONE FE/BE contract for every non-2xx body the studio API's central
 * error handler returns (see `@autonomy-studio/server`'s `errors.ts` — the
 * handful of inbound-webhook routes that answer before that handler runs are
 * not `apiFetch`-consumed and are out of scope): a stable `error` code, an
 * optional client-safe `message`, and — for the two validation branches — a
 * list of `issues` plus the #496 truncation markers. This is the
 * single source of truth: the server error handler builds its responses
 * against this type (`satisfies ApiErrorBody`) and the web client parses the
 * body through this schema, so the two can no longer drift silently.
 *
 * Every field is optional because each branch sends a different subset
 * (`validation_error` has no `message`; `not_found`/`conflict`/`bad_request`/
 * `import_error`/`internal_error` carry no `issues`) and an empty body must
 * still parse — this mirrors the pre-existing hand-rolled interface exactly.
 *
 * `truncated`/`totalIssues` are present ONLY when the server capped `issues[]`
 * (#496): their ABSENCE is the signal that the list is complete, so they are
 * left `.optional()` with NO `.default()` — an absent fact must never be
 * manufactured as "that was all of them" (the F13a/#473 fail-open rule). The
 * object is non-strict: it STRIPS unknown keys rather than rejecting, so a
 * future server field does not break an older client (forward-compat); the
 * server's own drift is caught at compile time by `satisfies`, not here.
 */
export const ApiErrorBodySchema = z.object({
  // A KNOWN code (`ApiErrorCodeSchema`), so a server typo is caught by
  // `satisfies` at compile time. `.catch(undefined)` keeps the CLIENT parse
  // tolerant: an UNRECOGNISED future code degrades this one field to
  // `undefined` rather than failing the whole object — so a newer server's
  // `{ error: 'new_code', message: '…' }` still surfaces its `message` to an
  // older client instead of collapsing to the generic fallback (the same
  // forward-compat intent as the non-strict object below, at field grain).
  error: ApiErrorCodeSchema.optional().catch(undefined),
  message: z.string().optional(),
  issues: z.array(ApiErrorIssueSchema).optional(),
  /** `true` iff the server capped `issues[]`; absent means the list is whole. */
  truncated: z.boolean().optional(),
  /** The pre-cap issue count — present iff `truncated` (so a client can say "N of totalIssues"). A count, so a non-negative integer. */
  totalIssues: z.number().int().nonnegative().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
