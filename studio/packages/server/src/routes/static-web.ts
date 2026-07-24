import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * P7 (#409) single-container self-host — serve the built web SPA from the same
 * Fastify server that hosts the API, so a `docker run` yields the FULL app
 * rather than an API with no UI. In dev the web is served by vite (which
 * proxies `/api` + `/health` to this server); in a packaged image the web
 * bundle is copied in and served here. `buildApp` only calls this when a
 * `webRoot` containing an `index.html` is configured — with no build present
 * (dev/test) the server keeps its plain JSON-404 behavior for every route.
 *
 * Security model: this adds only same-origin GET reads of files under `webRoot`
 * (a build artifact the operator controls, never user input) plus an in-memory
 * copy of the shell. It authenticates nothing and exposes no new state — the
 * app's single fixed `LOCAL_PRINCIPAL` (see `auth/principal.ts`) is unchanged.
 * Binding the server to a non-loopback host to reach it from outside the
 * container therefore exposes an UNAUTHENTICATED app; that is the operator's
 * deployment decision (see the Dockerfile/compose + PR security section).
 */

/**
 * Path prefixes owned by the backend. A request under one of these that matched
 * no route is a genuine 404 for an API/health consumer and must return the JSON
 * not-found body they expect — never the HTML shell. Everything else that looks
 * like a browser document navigation gets the SPA shell so client-side routing
 * (deep links, reloads on `/pipelines/:id`) works.
 */
const SPA_EXCLUDED_PREFIXES = ['/api', '/health'] as const;

/**
 * Is this unmatched request a browser navigation that should receive the SPA
 * shell? Only GET/HEAD, only outside the backend prefixes, and only when the
 * client asked for HTML. A missing hashed asset (`Accept: * /*`) is a genuine
 * 404, never silently rewritten to `index.html` — a broken bundle reference
 * must surface as a 404, not a misleading 200 that ships the shell in its place.
 */
export function isSpaNavigation(method: string, url: string, accept: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?', 1)[0] ?? url;
  for (const prefix of SPA_EXCLUDED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return false;
  }
  return (accept ?? '').includes('text/html');
}

/**
 * Register static serving of the web bundle at `webRoot` plus a global SPA
 * not-found fallback. `@fastify/static` serves real files (`/`, `/assets/...`)
 * with correct content-types; anything it cannot resolve falls through to the
 * root not-found handler, which serves the (in-memory) shell for a browser
 * navigation and a JSON 404 for everything else.
 *
 * The shell is read ONCE at boot into memory rather than via
 * `reply.sendFile('index.html')`: `@fastify/static` is registered in its own
 * encapsulated plugin context, so its `reply.sendFile` decorator is not
 * available on this root instance's not-found handler — and a packaged image is
 * immutable, so a boot-time read is both correct and cheaper per navigation.
 */
export async function registerStaticWeb(fastify: FastifyInstance, webRoot: string): Promise<void> {
  const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');

  await fastify.register(fastifyStatic, {
    root: webRoot,
    // Default catch-all `GET /*`, registered AFTER the specific API routes so it
    // only intercepts otherwise-unmatched GETs; a missing file calls the
    // not-found handler below.
    wildcard: true,
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (isSpaNavigation(request.method, request.url, request.headers.accept)) {
      // Match the charset `@fastify/static` stamps on the same file served at `/`,
      // so a deep-link reload and a root load return byte-identical headers.
      return reply.type('text/html; charset=utf-8').send(indexHtml);
    }
    return reply
      .code(404)
      .type('application/json')
      .send({
        statusCode: 404,
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found`,
      });
  });
}
