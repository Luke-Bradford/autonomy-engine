import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ImportError } from '@autonomy-studio/shared';
import type { ApiErrorBody } from '@autonomy-studio/shared';
import {
  InvalidPipelineDocError,
  PipelineHasRunsError,
  WorkspaceGitAlreadyConnectedError,
} from './repo/index.js';
import { GitOperationError, GitPushRejectedError, GitUnavailableError } from './git/provider.js';
import { GitHostApiError, GitHostRequestError } from './git/github-host.js';
import { WorkspaceSerializeError } from './portability/workspace-serialize.js';
import { ArchivedPipelineError } from './run/launcher.js';
import { DocUnresolvableError } from './run/driver.js';
import { RerunNotEligibleError } from './run/reseed.js';
import { ExternalWaitPayloadError, ExternalWaitSettledError } from './run/external-wait-service.js';
import { ISSUE_LIST_CAP } from './limits.js';

/**
 * Thrown by a route handler when the requested resource does not exist OR
 * exists but is not owned by `request.principal`. Deliberately the SAME
 * error (and the SAME HTTP response) for both cases: a client must never be
 * able to distinguish "doesn't exist" from "exists but isn't yours" — that
 * distinction is exactly what authentication-vs-authorization conflation
 * would leak (see CLAUDE.md's non-negotiable: a protected route proves the
 * caller is logged in, not that they own the resource).
 */
export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * Thrown by a route handler for a request that is well-formed + passes schema
 * validation but violates a business rule (e.g. enabling an unbound trigger).
 * The message is author-constructed and client-safe (no input echo, no
 * internal detail) — unlike Fastify's own parser 4xx messages, so it is
 * surfaced verbatim (mirrors `NotFoundError`/`ImportError`).
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * #3 G6c-1 — a CAS Publish refused by a business rule (HTTP 409): no repo
 * connected (publish is git-mode only), the target version has no git
 * provenance, the pipeline is archived, or the CAS expected-previous active is
 * stale ("pull/import first"). One message-carrying class (like `BadRequestError`)
 * rather than four near-identical 409 classes; the message is author-constructed
 * and client-safe (names ids only, never echoes request input). A version that
 * does not exist / is not this pipeline's is a `NotFoundError` (404), not this.
 */
export class PublishRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishRefusedError';
  }
}

/**
 * #904 — a version write refused because its declared CAS basis
 * (`basedOnVersionId`) is not the pipeline's current head: someone else saved
 * while this author was editing, and minting anyway would orphan their work off
 * the head with nobody told.
 *
 * Its own class, and its own `stale_write` code, rather than a
 * `PublishRefusedError`: this is the one 409 on that route the CLIENT can act
 * on (re-base and save again), while the generic `conflict` that route already
 * answers for a `SQLITE_CONSTRAINT` is not.
 *
 * The message names the current head's version NUMBER and nothing else. It must
 * never echo the caller's `basedOnVersionId` — the repo layer's rule (an error
 * may name only ids it has itself resolved and owner-checked, never request
 * input) applies here exactly.
 */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleWriteError';
  }
}

/** Narrow, non-message-only check (mirrors `repo/pipelines.ts`'s
 * `isForeignKeyRestrictError`): a `code` starting with `SQLITE_CONSTRAINT`
 * is better-sqlite3's family of extended result codes for every constraint
 * violation (FK, UNIQUE, CHECK, NOT NULL). */
function sqliteConstraintCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT') ? code : undefined;
}

function hasNumericStatusCode(err: unknown): err is Error & { statusCode: number } {
  if (!(err instanceof Error)) return false;
  const statusCode = (err as Error & { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}

/**
 * Caps the response `issues[]` at `ISSUE_LIST_CAP` (both `issues[]`-bearing
 * branches map an array whose length is proportional to the doc the caller
 * POSTed, so an uncapped body is O(doc)), reporting truncation HONESTLY: when
 * the list fits, `truncated`/`totalIssues` are omitted (their absence IS the
 * signal the list is complete — `issues.length` is the true total, so nothing
 * is hidden); when it overflows, both are present so the client knows a tail
 * was dropped. An absent fact must never be manufactured as "that was all of
 * them" — the F13a/#473 rule, mirrored from `repo/run-diagnostics.ts`'s cap
 * marker (#496).
 */
function capIssues<T>(issues: T[]): {
  issues: T[];
  truncated?: true;
  totalIssues?: number;
} {
  if (issues.length <= ISSUE_LIST_CAP) return { issues };
  return { issues: issues.slice(0, ISSUE_LIST_CAP), truncated: true, totalIssues: issues.length };
}

/**
 * Registers the ONE structured error handler for the whole app. Every branch
 * returns a small, fixed-shape body; nothing here ever forwards a raw
 * exception message, stack trace, or internal path to the client. The strings
 * that reach the client are ones this handler (or an author-constructed,
 * already-client-safe error) provides: `NotFoundError`/`PipelineHasRunsError`
 * name a resource kind + an opaque id, nothing else.
 *
 * ONE branch echoes caller input, deliberately: `InvalidPipelineDocError`
 * (#444) quotes ids/key-paths/`${}` text from the doc the caller just POSTed,
 * because a validation diagnostic that names nothing is useless. It is safe
 * only because that doc is owner-scoped and is the caller's own — see that
 * branch's own note. No OTHER branch may echo input without the same argument.
 *
 * The full error (with stack) is still logged server-side via `request.log`,
 * so nothing is lost for debugging.
 */
export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'validation_error',
        ...capIssues(
          error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      } satisfies ApiErrorBody);
      return;
    }

    if (error instanceof NotFoundError) {
      reply.status(404).send({ error: 'not_found', message: error.message } satisfies ApiErrorBody);
      return;
    }

    if (error instanceof PipelineHasRunsError) {
      request.log.warn({ err: error }, 'conflict: pipeline has run history');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G5a — a manual fire whose bound pipeline is archived. A conflict with
    // the pipeline's lifecycle state, message client-safe (ids only).
    if (error instanceof ArchivedPipelineError) {
      request.log.warn({ err: error }, 'conflict: pipeline is archived');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // Thrown by `parseAndUpgradeEnvelope`/`importEnvelope` (P1c) for a
    // malformed, incompatible (newer schemaVersion/catalogVersion than this
    // build supports), or otherwise-refused import envelope. `error.message`
    // is already client-safe — see `ImportError`'s own doc comment.
    if (error instanceof ImportError) {
      reply
        .status(400)
        .send({ error: 'import_error', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // The pipeline-doc write gate (#444). Thrown by `createPipelineVersion`
    // for a doc that passes Zod but fails the engine's structural/`${}` rules.
    //
    // `issues` is OBJECT-shaped (`{ message }`), not `string[]`, because that
    // is the shared client contract: `@autonomy-studio/shared`'s
    // `ApiErrorBodySchema` declares `issues?: Array<{ path?; message? }>` (the
    // `satisfies ApiErrorBody` on each send below enforces it). Conforming to
    // it (rather than forking a second shape) is the whole reason.
    //
    // `message` is what the canvas actually renders today — `messageFromBody`
    // returns it before it ever looks at `issues` — so `issues` is currently
    // belt-and-braces: it is what a UI listing them per-issue would read, and
    // it is what keeps the body renderable if `message` were ever dropped.
    //
    // ECHO NOTE: unlike every other branch here, these strings are constructed
    // by the shared validators, not by this handler, and they DO quote the
    // caller's input — node/container ids, config KEY paths, and `${}`
    // expression text. That is deliberate and safe: both write paths are
    // owner-scoped before the guard runs, so the doc being described is always
    // the caller's own, returned synchronously to the caller who just sent it.
    // The validators are STATIC (they run pre-substitution), so no resolved
    // param value, and no secret, exists at that point to leak — a secret-typed
    // param ref is refused by NAME. See the PR for #444's security model.
    if (error instanceof InvalidPipelineDocError) {
      reply.status(400).send({
        error: 'invalid_pipeline_doc',
        // `error.message` is already bounded at its source (the error class
        // names the first N issues then states the remainder), so capping only
        // `issues[]` here would not leave the body O(doc) via the message.
        message: error.message,
        ...capIssues(error.issues.map((message) => ({ message }))),
      } satisfies ApiErrorBody);
      return;
    }

    if (error instanceof BadRequestError) {
      reply
        .status(400)
        .send({ error: 'bad_request', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G6c-1 — a CAS Publish refused by a business rule (no repo / no
    // provenance / archived / stale CAS). A conflict with workspace or version
    // state; message client-safe (author-constructed, ids only).
    if (error instanceof PublishRefusedError) {
      request.log.warn({ err: error }, 'conflict: publish refused');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #904 — a version write against a stale basis. Distinct from the generic
    // `conflict` beside it: the client offers an informed re-base on THIS code
    // alone, so it must be separable from a constraint violation (which is also
    // a 409 on the same route, and which a re-POST would only hit again).
    if (error instanceof StaleWriteError) {
      request.log.warn({ err: error }, 'conflict: stale version write');
      reply
        .status(409)
        .send({ error: 'stale_write', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // RS2 — a rerun-from-failed was requested for a run that cannot be one (no
    // log, not terminated, or terminated in success): a conflict with the source
    // run's state, not a bad request shape. Message is client-safe (ids + a fixed
    // reason). Order-independent of the `DocUnresolvableError` branch below (the two
    // are unrelated classes, mutually-exclusive `instanceof`).
    if (error instanceof RerunNotEligibleError) {
      request.log.warn({ err: error }, 'conflict: run not rerun-from-failed eligible');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #901 — an owner's external-wait completion body failed the node's declared
    // output contract (422). `message` carries the field to correct, which is the
    // whole reason the owner-scoped route exists rather than the app reusing the
    // anonymous seam (whose 422 body bypasses this handler and loses its detail).
    //
    // Ordering here is NOT load-bearing, stated because it looks as though it
    // should be: the generic `hasNumericStatusCode` fallback below would flatten a
    // 4xx to a bare "Malformed request", but it reads `err.statusCode`, and neither
    // class has one (`ExternalWaitSettledError` names its field `status`
    // deliberately). Grouped here for readability. If either ever grows a
    // `statusCode`, this placement becomes load-bearing — do not move it then.
    if (error instanceof ExternalWaitPayloadError) {
      request.log.warn({ err: error }, 'external wait: callback payload rejected');
      reply
        .status(422)
        .send({ error: 'external_wait_payload', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #901 — the addressed wait is gone (409, or 410 when it EXPIRED). Same code for
    // both: the status distinguishes them for an API client, the code is what the UI
    // switches on and its action is identical either way.
    if (error instanceof ExternalWaitSettledError) {
      request.log.warn({ err: error }, 'external wait: no longer completable');
      reply
        .status(error.status)
        .send({ error: 'external_wait_settled', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // RS2 — a rerun-from-failed (or any route resolving a run's doc) whose pinned
    // immutable pipeline version no longer resolves (deleted/unparseable): a
    // conflict with version state the request cannot fix, not an upstream outage.
    // The message names ids only (see `DocUnresolvableError`), client-safe.
    if (error instanceof DocUnresolvableError) {
      request.log.warn({ err: error }, 'conflict: pipeline version unresolvable');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G2 — a workspace is never silently re-pointed at a different repo;
    // the message is author-constructed and client-safe.
    if (error instanceof WorkspaceGitAlreadyConnectedError) {
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G2 — the host has no usable `git` binary: a LOCAL precondition
    // failure (503), remedied by installing git, not by changing the request.
    if (error instanceof GitUnavailableError) {
      reply
        .status(503)
        .send({ error: 'git_unavailable', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G10 — a `git push` was rejected as a non-fast-forward: the working
    // branch moved on the remote, a request-STATE conflict (fetch/import and
    // re-commit), not an upstream outage — so 409 `conflict`, distinct from the
    // 502 `git_error` below (the transport-level dual of `GitHostRequestError`'s
    // 422→409). A deliberate SIBLING of `GitOperationError`, but its branch runs
    // FIRST anyway (defensive against a future refactor to a subclass). The
    // message is fixed and client-safe by construction (quotes no stderr/path).
    // #1043 — Commit cannot serialize a live resource whose head names something
    // that no longer exists (typically a node using a hard-deleted connection).
    // A 409 because it is an operator-fixable CONFLICT between two things they
    // did, not the internal fault the old opaque 500 implied: re-point or remove
    // the node and Save, which mints a fresh head. The message names every
    // offender (`error.offenders`) — the owner's own DB ids, never committed file
    // bytes. NOTE this branch also covers `serializeTrigger` inside the apply,
    // where the same error WOULD mean a broken internal invariant rather than a
    // conflict; that path has no producer (the trigger→version FK cascades), and
    // if one ever appears it deserves its own classification, not this label.
    if (error instanceof WorkspaceSerializeError) {
      request.log.warn({ err: error }, 'workspace cannot be serialized for commit');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    if (error instanceof GitPushRejectedError) {
      request.log.warn({ err: error }, 'git push rejected (non-fast-forward)');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G2 — a git operation against the connected repo failed (502: the
    // failure is upstream — remote unreachable, auth refused, clone failed).
    // `error.message` is client-safe by construction: the provider redacts
    // stderr through its `secretsToRedact` seam before it lands in the error,
    // and no stored git credential exists in G2 at all (embedded-credential
    // URLs are refused at the Zod boundary). NOTE this branch must run before
    // the numeric-statusCode passthrough/500 fallthrough — 502 is outside
    // `hasNumericStatusCode`'s 4xx window.
    if (error instanceof GitOperationError) {
      request.log.warn({ err: error }, 'git operation failed');
      reply.status(502).send({ error: 'git_error', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G9b — the GitHub PR host-API could not fulfil the request (network,
    // timeout, auth/permission refusal, 5xx, malformed/lost response). Same
    // upstream-failure surface as a git operation (502 `git_error`); the message
    // is client-safe by construction (status + GitHub's own text, token-redacted
    // — see `git/github-host.ts`). Must precede the numeric-statusCode/500
    // fallthrough, as 502 is outside `hasNumericStatusCode`'s 4xx window.
    if (error instanceof GitHostApiError) {
      request.log.warn({ err: error }, 'git host API failed');
      reply.status(502).send({ error: 'git_error', message: error.message } satisfies ApiErrorBody);
      return;
    }

    // #3 G9b — the PR request was well-formed but GitHub semantically refused it
    // (a 422 that is NOT "already exists" — e.g. "No commits between base and
    // head": nothing to PR). A request-STATE conflict, not an upstream outage, so
    // 409 `conflict` (the `PublishRefusedError` surface), not 502. GitHub-authored
    // message, token-redacted.
    if (error instanceof GitHostRequestError) {
      request.log.warn({ err: error }, 'git host API refused the request');
      reply.status(409).send({ error: 'conflict', message: error.message } satisfies ApiErrorBody);
      return;
    }

    const constraintCode = sqliteConstraintCode(error);
    if (constraintCode) {
      request.log.warn({ err: error, code: constraintCode }, 'constraint violation');
      reply.status(409).send({
        error: 'conflict',
        message: 'The request conflicts with existing data.',
      } satisfies ApiErrorBody);
      return;
    }

    // Fastify's own request-lifecycle errors (e.g. a malformed JSON body,
    // which throws before any route handler runs) carry a `statusCode` in
    // the 4xx range — handled defensively even though today's routes
    // validate manually with the shared Zod schemas rather than a Fastify
    // route `schema` option. Unlike the ZodError branch above (whose
    // `issues` are value-free — a path + a fixed message, never an echo of
    // the caller's input; the `invalid_pipeline_doc` branch is the one
    // deliberate exception, and is safe for reasons that do NOT apply here:
    // this error can fire before any route handler, so before any owner
    // check, and its text is a library's, not an author's), Fastify's own
    // parser error `message` can quote a
    // fragment of the malformed body straight back at the client. The
    // generic message here avoids that echo; the real error (with detail)
    // still reaches the server log.
    if (hasNumericStatusCode(error)) {
      request.log.warn({ err: error }, 'malformed request');
      reply
        .status(error.statusCode)
        .send({ error: 'bad_request', message: 'Malformed request' } satisfies ApiErrorBody);
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({
      error: 'internal_error',
      message: 'An unexpected error occurred.',
    } satisfies ApiErrorBody);
  });
}
