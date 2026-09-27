import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GLOBAL_PARAM_MAX_BYTES } from '@autonomy-studio/shared';
import { createGlobalParam, getGlobalParam } from '../../repo/index.js';
import { buildTestApp } from '../../__tests__/build-test-app.js';

/**
 * #844 GL1 — the global-params store's REST surface (spec
 * `2026-09-27-foundation-global-params.md` GL-D1/GL-D7). Inert: nothing reads a
 * global yet, so these pin the store alone.
 */
describe('global params routes (#844 GL1)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/global-params', payload });
  }

  it('POST creates a global owned by the caller, and GET lists it with its value TYPED', async () => {
    const created = await post({ name: 'apiUrl', type: 'string', value: 'https://x.test' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'apiUrl',
      type: 'string',
      value: 'https://x.test',
      description: '',
      ownerId: 'local',
    });
    expect(created.json().id).toMatch(/^gp_/);

    // A `"42"` string stays a string, `null` stays json null, an object round-trips.
    await post({ name: 'port', type: 'string', value: '42' });
    await post({ name: 'nothing', type: 'json', value: null });
    await post({ name: 'cfg', type: 'json', value: { a: [1, true], b: { c: 'd' } } });
    await post({ name: 'retries', type: 'number', value: 3 });
    await post({ name: 'dryRun', type: 'boolean', value: false });

    const list = await app.inject({ method: 'GET', url: '/api/global-params' });
    expect(list.statusCode).toBe(200);
    const { items, nextCursor } = list.json();
    expect(nextCursor).toBeNull();
    const byName = Object.fromEntries(
      items.map((g: { name: string; value: unknown }) => [g.name, g.value]),
    );
    expect(byName).toEqual({
      apiUrl: 'https://x.test',
      port: '42',
      nothing: null,
      cfg: { a: [1, true], b: { c: 'd' } },
      retries: 3,
      dryRun: false,
    });
  });

  it('a case-variant name is a 409 — names are unique per owner case-insensitively', async () => {
    expect((await post({ name: 'apiUrl', type: 'string', value: 'a' })).statusCode).toBe(201);
    expect((await post({ name: 'apiURL', type: 'string', value: 'b' })).statusCode).toBe(409);
  });

  it.each([
    ['a secret type (no secure globals)', { name: 'k', type: 'secret', value: 'x' }, 'type'],
    ['an unaddressable name', { name: 'api url', type: 'string', value: 'x' }, 'name'],
    ['a value of the wrong type', { name: 'k', type: 'number', value: '3' }, 'value'],
    ['a missing value', { name: 'k', type: 'string' }, 'value'],
    ['a missing json value', { name: 'k', type: 'json' }, 'value'],
    [
      'an over-bound value',
      { name: 'k', type: 'string', value: 'a'.repeat(GLOBAL_PARAM_MAX_BYTES) },
      'value',
    ],
    ['an unknown key', { name: 'k', type: 'string', value: 'x', extra: 1 }, ''],
  ])('POST refuses %s with a 400 naming the field', async (_label, payload, path) => {
    const res = await post(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    expect(res.json().issues.map((i: { path: string }) => i.path)).toContain(path);
  });

  it('PATCH updates value and description in place, checked against the STORED type', async () => {
    const { id, updatedAt } = (await post({ name: 'retries', type: 'number', value: 3 })).json();
    await new Promise((r) => setTimeout(r, 2));

    const ok = await app.inject({
      method: 'PATCH',
      url: `/api/global-params/${id}`,
      payload: { value: 5, description: 'how many' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id, name: 'retries', value: 5, description: 'how many' });
    expect(ok.json().updatedAt).toBeGreaterThan(updatedAt);

    const wrongType = await app.inject({
      method: 'PATCH',
      url: `/api/global-params/${id}`,
      payload: { value: 'five' },
    });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.json().issues[0].path).toBe('value');
    expect(getGlobalParam(app.db, id)!.value).toBe(5);

    // An empty patch is a no-op: nothing changed, so `updatedAt` does not move.
    const before = getGlobalParam(app.db, id)!;
    await new Promise((r) => setTimeout(r, 2));
    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/global-params/${id}`,
      payload: {},
    });
    expect(empty.statusCode).toBe(200);
    expect(getGlobalParam(app.db, id)).toEqual(before);
  });

  it('PATCH refuses `name` and `type` — both are immutable (delete + re-create instead)', async () => {
    const { id } = (await post({ name: 'env', type: 'string', value: 'dev' })).json();
    for (const payload of [{ name: 'env2' }, { type: 'json' }, { name: 'env', value: 'x' }]) {
      const res = await app.inject({ method: 'PATCH', url: `/api/global-params/${id}`, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(getGlobalParam(app.db, id)).toMatchObject({ name: 'env', type: 'string', value: 'dev' });
  });

  it('DELETE removes the global (204), and a second DELETE is a 404', async () => {
    const { id } = (await post({ name: 'env', type: 'string', value: 'dev' })).json();
    const del = await app.inject({ method: 'DELETE', url: `/api/global-params/${id}` });
    expect(del.statusCode).toBe(204);
    expect(getGlobalParam(app.db, id)).toBeNull();
    const again = await app.inject({ method: 'DELETE', url: `/api/global-params/${id}` });
    expect(again.statusCode).toBe(404);
  });

  it("another owner's global is invisible: absent from the list, 404 on PATCH and DELETE", async () => {
    const theirs = createGlobalParam(app.db, {
      ownerId: 'someone-else',
      name: 'env',
      type: 'string',
      value: 'prod',
      description: '',
    });
    // The same name is free for this owner — uniqueness is per owner.
    expect((await post({ name: 'env', type: 'string', value: 'dev' })).statusCode).toBe(201);

    const list = (await app.inject({ method: 'GET', url: '/api/global-params' })).json();
    expect(list.items.map((g: { id: string }) => g.id)).not.toContain(theirs.id);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/global-params/${theirs.id}`,
      payload: { value: 'hacked' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/global-params/${theirs.id}` });
    expect(del.statusCode).toBe(404);
    expect(getGlobalParam(app.db, theirs.id)).toMatchObject({ value: 'prod' });
  });
});
