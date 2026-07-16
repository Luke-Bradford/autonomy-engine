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
  error: z.string().optional(),
  message: z.string().optional(),
  issues: z.array(ApiErrorIssueSchema).optional(),
  /** `true` iff the server capped `issues[]`; absent means the list is whole. */
  truncated: z.boolean().optional(),
  /** The pre-cap issue count — present iff `truncated` (so a client can say "N of totalIssues"). */
  totalIssues: z.number().optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
