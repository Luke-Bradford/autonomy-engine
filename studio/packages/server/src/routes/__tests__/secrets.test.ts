import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@autonomy-studio/shared';
import { buildTestApp } from '../../__tests__/build-test-app.js';

describe('secrets routes (item 7 / S1 — the standalone secret SOURCE)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST creates a standalone secret; the response is the public projection — no plaintext, ciphertext, or ref', async () => {
    const plaintext = 'sk-super-secret-plaintext';
    const res = await app.inject({
      method: 'POST',
      url: '/api/secrets',
      payload: { name: 'stripe-key', secret: plaintext },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('stripe-key');
    expect(body.ownerId).toBe('local');
    expect(body.id).toMatch(/^sec_/);
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('ciphertext');
    expect(body).not.toHaveProperty('ref');
    expect(JSON.stringify(body)).not.toContain(plaintext);
  });

  it('GET lists the owner’s standalone secrets as public projections only', async () => {
    const app2 = await buildTestApp();
    try {
      await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'one', secret: 'p1' },
      });
      await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'two', secret: 'p2' },
      });
      const listRes = await app2.inject({ method: 'GET', url: '/api/secrets' });
      expect(listRes.statusCode).toBe(200);
      const { items: list, nextCursor } = listRes.json();
      expect(nextCursor).toBeNull();
      expect(list.map((s: { name: string }) => s.name).sort()).toEqual(['one', 'two']);
      for (const s of list) {
        expect(s).not.toHaveProperty('ciphertext');
        expect(s).not.toHaveProperty('ref');
      }
    } finally {
      await app2.close();
    }
  });

  it('a connection-owned secret never appears in GET /api/secrets', async () => {
    const app2 = await buildTestApp();
    try {
      // Minting a connection with a plaintext secret creates a connection-owned
      // (name/owner null) `secrets` row — it must stay invisible to this API.
      const connRes = await app2.inject({
        method: 'POST',
        url: '/api/connections',
        payload: { name: 'keyed', kind: 'anthropic_api', config: {}, secret: 'conn-plaintext' },
      });
      expect(connRes.statusCode).toBe(201);
      const listRes = await app2.inject({ method: 'GET', url: '/api/secrets' });
      expect(listRes.json()).toEqual({ items: [], nextCursor: null });
    } finally {
      await app2.close();
    }
  });

  it('a duplicate (owner, name) is a 409 conflict', async () => {
    const app2 = await buildTestApp();
    try {
      const first = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'dup', secret: 'p1' },
      });
      expect(first.statusCode).toBe(201);
      const second = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'dup', secret: 'p2' },
      });
      expect(second.statusCode).toBe(409);
    } finally {
      await app2.close();
    }
  });

  it('a case-variant of an existing name is a 409 — uniqueness is case-insensitive (#533)', async () => {
    const app2 = await buildTestApp();
    try {
      const first = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'stripe-key', secret: 'p1' },
      });
      expect(first.statusCode).toBe(201);
      // Differs from the stored name only in ASCII case — the NOCASE unique
      // index refuses it, so the owner cannot end up with two confusable rows.
      const second = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'Stripe-Key', secret: 'p2' },
      });
      expect(second.statusCode).toBe(409);
    } finally {
      await app2.close();
    }
  });

  it('an empty name / missing secret is a 400 at the boundary', async () => {
    const app2 = await buildTestApp();
    try {
      const emptyName = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: '', secret: 'p' },
      });
      expect(emptyName.statusCode).toBe(400);
      const noSecret = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'x' },
      });
      expect(noSecret.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('a blank or untrimmed name is a 400 — the name is an exact-match lookup key', async () => {
    const app2 = await buildTestApp();
    try {
      const whitespaceOnly = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: '   ', secret: 'p' },
      });
      expect(whitespaceOnly.statusCode).toBe(400);
      const leadingTrailing = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: ' stripe-key ', secret: 'p' },
      });
      expect(leadingTrailing.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('an over-long name / secret is a 400 — the encrypt-and-store payload is bounded', async () => {
    const app2 = await buildTestApp();
    try {
      const longName = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'n'.repeat(256), secret: 'p' },
      });
      expect(longName.statusCode).toBe(400);
      const longSecret = await app2.inject({
        method: 'POST',
        url: '/api/secrets',
        payload: { name: 'ok', secret: 's'.repeat(16385) },
      });
      expect(longSecret.statusCode).toBe(400);
    } finally {
      await app2.close();
    }
  });

  it('DELETE removes a standalone secret; a second GET no longer lists it', async () => {
    const app2 = await buildTestApp();
    try {
      const created = (
        await app2.inject({
          method: 'POST',
          url: '/api/secrets',
          payload: { name: 'to-delete', secret: 'p' },
        })
      ).json();
      const delRes = await app2.inject({ method: 'DELETE', url: `/api/secrets/${created.id}` });
      expect(delRes.statusCode).toBe(204);
      const listRes = await app2.inject({ method: 'GET', url: '/api/secrets' });
      expect(listRes.json()).toEqual({ items: [], nextCursor: null });
      // Deleting again is a 404 (gone == not-owned, indistinguishable).
      const delAgain = await app2.inject({ method: 'DELETE', url: `/api/secrets/${created.id}` });
      expect(delAgain.statusCode).toBe(404);
    } finally {
      await app2.close();
    }
  });

  it('DELETE of an unknown id is a 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/secrets/sec_missing' });
    expect(res.statusCode).toBe(404);
  });

  describe('pagination (#534)', () => {
    async function seed(app2: FastifyInstance, n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        const res = await app2.inject({
          method: 'POST',
          url: '/api/secrets',
          // Zero-padded so the created ids differ but names stay distinct.
          payload: { name: `s-${String(i).padStart(3, '0')}`, secret: `p${i}` },
        });
        expect(res.statusCode).toBe(201);
      }
    }

    /** Walks every page following `nextCursor`, returning the flattened names in
     * server order — the exact shape a client's auto-paginator sees. */
    async function collectAll(app2: FastifyInstance, limit: number): Promise<string[]> {
      const names: string[] = [];
      let cursor: string | undefined;
      // Bounded so a bug can never hang the suite.
      for (let page = 0; page < 100; page++) {
        const qs = new URLSearchParams({ limit: String(limit) });
        if (cursor !== undefined) qs.set('cursor', cursor);
        const res = await app2.inject({ method: 'GET', url: `/api/secrets?${qs.toString()}` });
        expect(res.statusCode).toBe(200);
        const { items, nextCursor } = res.json();
        expect(items.length).toBeLessThanOrEqual(limit);
        for (const s of items) names.push(s.name);
        if (nextCursor === null) return names;
        cursor = nextCursor;
      }
      throw new Error('pagination did not terminate');
    }

    it('caps a page at the requested limit and continues via nextCursor with no gap or overlap', async () => {
      const app2 = await buildTestApp();
      try {
        await seed(app2, 7);
        const first = await app2.inject({ method: 'GET', url: '/api/secrets?limit=3' });
        const firstPage = first.json();
        expect(firstPage.items).toHaveLength(3);
        expect(firstPage.nextCursor).not.toBeNull();

        const all = await collectAll(app2, 3);
        expect(all).toHaveLength(7);
        // No duplicates across the page boundary.
        expect(new Set(all).size).toBe(7);
        // Every seeded name present exactly once.
        expect([...all].sort()).toEqual(
          Array.from({ length: 7 }, (_, i) => `s-${String(i).padStart(3, '0')}`),
        );
      } finally {
        await app2.close();
      }
    });

    it('defaults to DEFAULT_PAGE_SIZE when limit is omitted', async () => {
      const app2 = await buildTestApp();
      try {
        // One more than the default so the first page is capped and a cursor is issued.
        await seed(app2, DEFAULT_PAGE_SIZE + 1);
        const res = await app2.inject({ method: 'GET', url: '/api/secrets' });
        const page = res.json();
        expect(page.items).toHaveLength(DEFAULT_PAGE_SIZE);
        expect(page.nextCursor).not.toBeNull();
      } finally {
        await app2.close();
      }
    });

    it('an empty list is { items: [], nextCursor: null }', async () => {
      const app2 = await buildTestApp();
      try {
        const res = await app2.inject({ method: 'GET', url: '/api/secrets?limit=10' });
        expect(res.json()).toEqual({ items: [], nextCursor: null });
      } finally {
        await app2.close();
      }
    });

    it('a limit above MAX_PAGE_SIZE, below 1, or non-numeric is a 400 (no silent clamp)', async () => {
      const tooBig = await app.inject({
        method: 'GET',
        url: `/api/secrets?limit=${MAX_PAGE_SIZE + 1}`,
      });
      expect(tooBig.statusCode).toBe(400);
      const zero = await app.inject({ method: 'GET', url: '/api/secrets?limit=0' });
      expect(zero.statusCode).toBe(400);
      const nan = await app.inject({ method: 'GET', url: '/api/secrets?limit=abc' });
      expect(nan.statusCode).toBe(400);
    });

    it('a malformed or stale cursor is a 400 — never silently treated as first page', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/secrets?cursor=not-a-cursor' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_request');
    });
  });
});
