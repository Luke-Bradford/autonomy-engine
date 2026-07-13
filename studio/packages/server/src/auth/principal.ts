import type { FastifyInstance } from 'fastify';

/**
 * The identity attached to every request by the auth seam. MVP: a single
 * fixed local owner — there is no real authentication yet (see
 * `docs/2026-07-12-target-architecture.md`'s "Auth seam from day one").
 * `id` is the principal's own identifier; `ownerId` is what every repo call
 * filters/stamps config-object rows by. They are equal today (one owner ==
 * one principal) but are kept as separate fields on purpose: a future
 * multi-user auth swap may want an authenticated *identity* (`id`) to act on
 * behalf of / be scoped to a different `ownerId` (e.g. shared workspace
 * membership). Replacing this hook with real auth should only ever need to
 * change how `principal` is computed — the shape routes consume, and every
 * `WHERE ownerId = ...` they already do, stays the same.
 */
export interface Principal {
  id: string;
  ownerId: string;
}

export const LOCAL_PRINCIPAL: Principal = { id: 'local', ownerId: 'local' };

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}

/**
 * Registers the auth seam: every request gets `request.principal` before any
 * route handler runs. MVP always attaches the single fixed local owner — no
 * credential is checked, this can never fail. Swapping in real
 * authentication later means replacing the `onRequest` hook body below (e.g.
 * verifying a session/token and looking up the real principal) — the routes
 * downstream never change, since they only ever read `request.principal`.
 *
 * `decorateRequest('principal')` with no default value (rather than a
 * shared object literal) is deliberate: Fastify refuses a reference-type
 * default on `decorateRequest` because it would be shared across every
 * request. Setting the real value inside the `onRequest` hook (once per
 * request) is the documented-correct pattern.
 */
export function registerAuthHook(fastify: FastifyInstance): void {
  fastify.decorateRequest('principal');
  fastify.addHook('onRequest', async (request) => {
    request.principal = LOCAL_PRINCIPAL;
  });
}
