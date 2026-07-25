import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../index.js';

// P7 — single-container self-host: the server serves the built web SPA so a
// `docker run` yields the FULL app (not an API with no UI). These tests drive
// `buildApp({ webRoot })` against a temp web-root and assert the SPA-fallback
// predicate never swallows a genuine API 404 or a missing static asset.

const tmpRoot = mkdtempSync(join(tmpdir(), 'autonomy-studio-staticweb-test-'));
const dbBase = join(tmpRoot, 'db');
mkdirSync(dbBase, { recursive: true });

const INDEX_HTML =
  '<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
const APP_JS = 'console.log("autonomy studio web");';
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>';

/** A populated web build: index.html + an assets/ bundle + the #717 favicon. */
function seedWebRoot(name: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), INDEX_HTML);
  writeFileSync(join(dir, 'assets', 'app.js'), APP_JS);
  // `vite build` copies `packages/web/public/*` to the dist ROOT, so the
  // favicon sits beside index.html rather than under assets/.
  writeFileSync(join(dir, 'favicon.svg'), FAVICON_SVG);
  return dir;
}

describe('static web SPA serving (P7)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      dbPath: join(dbBase, 'served.sqlite'),
      masterKeyFile: join(dbBase, 'served.key'),
      webRoot: seedWebRoot('web-served'),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves index.html at / for a browser navigation', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<div id="root">');
  });

  // #717 — a browser requests the favicon on every navigation whether or not
  // the page asks for one; with nothing to serve, the answer was a 404 logged
  // as a console ERROR on every load of a self-hosted install. The e2e console
  // guard cannot cover this (Playwright's context issues no implicit favicon
  // request), so the single-origin serving path is asserted here instead.
  //
  // Both halves matter and fail independently: the FILE must be served from the
  // web root, and index.html must POINT at it — a correct file with a typo'd
  // href still 404s, because the SPA fallback deliberately does not rewrite
  // non-HTML misses to the shell.
  it('serves the favicon from the web root with an svg content-type (#717)', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/svg\+xml/);
  });

  it('declares the favicon in index.html so no browser falls back to /favicon.ico (#717)', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
    expect(res.body).toContain('rel="icon"');
    expect(res.body).toContain('/favicon.svg');
  });

  it('serves a hashed asset from /assets with its own content-type', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe(APP_JS);
  });

  it('falls back to index.html for a client-side route (SPA deep link)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pipelines/abc/edit',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<div id="root">');
  });

  it('serves the shell for a HEAD navigation (predicate allows HEAD, not just GET)', async () => {
    const res = await app.inject({
      method: 'HEAD',
      url: '/pipelines/abc/edit',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('returns a JSON 404 for an unknown API GET — never the SPA shell', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json().statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });

  it('returns a JSON 404 for an unknown API POST — never the SPA shell', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/unknown', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).not.toContain('<div id="root">');
  });

  it('returns a JSON 404 (not the shell) for a MISSING asset — a bad bundle ref must not resolve to HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });

  it('still serves /health and /api/hello unchanged', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });
    const hello = await app.inject({ method: 'GET', url: '/api/hello' });
    expect(hello.statusCode).toBe(200);
  });
});

describe('static web disabled when no webRoot (dev/test default)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      dbPath: join(dbBase, 'noweb.sqlite'),
      masterKeyFile: join(dbBase, 'noweb.key'),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('an unknown GET 404s normally — no SPA fallback, no HTML', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pipelines/abc/edit',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });
});

describe('static web guards against an incomplete build (webRoot dir without index.html)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const empty = join(tmpRoot, 'web-empty');
    mkdirSync(empty, { recursive: true }); // exists, but NO index.html
    app = await buildApp({
      dbPath: join(dbBase, 'empty.sqlite'),
      masterKeyFile: join(dbBase, 'empty.key'),
      webRoot: empty,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('degrades to a clean 404 (not a 500) when the shell is absent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/pipelines/abc/edit',
      headers: { accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('<div id="root">');
  });
});
