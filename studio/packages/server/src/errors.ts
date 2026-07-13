import { ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import { PipelineHasRunsError } from './repo/index.js';

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
 * Registers the ONE structured error handler for the whole app. Every branch
 * returns a small, fixed-shape body; nothing here ever forwards a raw
 * exception message, stack trace, or internal path to the client — the only
 * strings that reach the client are ones this handler constructs itself
 * (`NotFoundError`/`PipelineHasRunsError` messages are already
 * client-safe — they name a resource kind + an opaque id, nothing else).
 * The full error (with stack) is still logged server-side via
 * `request.log`, so nothing is lost for debugging.
 */
export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'validation_error',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    if (error instanceof NotFoundError) {
      reply.status(404).send({ error: 'not_found', message: error.message });
      return;
    }

    if (error instanceof PipelineHasRunsError) {
      request.log.warn({ err: error }, 'conflict: pipeline has run history');
      reply.status(409).send({ error: 'conflict', message: error.message });
      return;
    }

    const constraintCode = sqliteConstraintCode(error);
    if (constraintCode) {
      request.log.warn({ err: error, code: constraintCode }, 'constraint violation');
      reply
        .status(409)
        .send({ error: 'conflict', message: 'The request conflicts with existing data.' });
      return;
    }

    // Fastify's own request-lifecycle errors (e.g. a malformed JSON body,
    // which throws before any route handler runs) carry a `statusCode` in
    // the 4xx range — handled defensively even though today's routes
    // validate manually with the shared Zod schemas rather than a Fastify
    // route `schema` option.
    if (hasNumericStatusCode(error)) {
      reply.status(error.statusCode).send({ error: 'bad_request', message: error.message });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({
      error: 'internal_error',
      message: 'An unexpected error occurred.',
    });
  });
}
