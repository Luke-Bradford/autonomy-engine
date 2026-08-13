import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@autonomy-studio/shared';
import {
  createSecret,
  getConnection,
  getSecret,
  getSecretByName,
  getSecretByRef,
  listSecrets,
} from '../../repo/index.js';
import { decrypt, encrypt } from '../../secrets/secrets.js';
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

  /**
   * #1061 — ROTATION. The window this route closes is the whole point: before
   * it existed, replacing a value meant DELETE + POST, and between those two
   * calls `{ "$secret": "<name>" }` resolved to nothing, so any node
   * dispatching in that window failed with `secret '<name>' not found`.
   *
   * There is no assertion here of the form "the name never stopped resolving",
   * because `app.inject` is one synchronous request and such a check would
   * pass against a delete-then-recreate implementation too — it cannot
   * discriminate, so it would certify nothing. The property that DOES
   * discriminate is that the ROW was updated in place: same `id`, same `ref`,
   * same `createdAt`, one row throughout, with only the ciphertext moving.
   * That is what these assert.
   */
  describe('PATCH /api/secrets/:id — in-place rotation (#1061)', () => {
    it('replaces the value under the SAME row — id, ref, name and createdAt all survive', async () => {
      const app2 = await buildTestApp();
      try {
        const created = (
          await app2.inject({
            method: 'POST',
            url: '/api/secrets',
            payload: { name: 'rotate-me', secret: 'first-value' },
          })
        ).json();
        const before = getSecret(app2.db, created.id)!;

        const res = await app2.inject({
          method: 'PATCH',
          url: `/api/secrets/${created.id}`,
          payload: { secret: 'second-value' },
        });
        expect(res.statusCode).toBe(200);

        // The response is still the PUBLIC projection — rotation is not a hole
        // in the write-only property.
        const body = res.json();
        expect(body).toEqual({
          id: created.id,
          name: 'rotate-me',
          ownerId: 'local',
          createdAt: created.createdAt,
        });
        expect(JSON.stringify(body)).not.toContain('second-value');

        const after = getSecret(app2.db, created.id)!;
        // The identity a marker resolves through, unmoved.
        expect(after.ref).toBe(before.ref);
        expect(after.name).toBe('rotate-me');
        expect(after.createdAt).toBe(before.createdAt);
        // …and the value really did move, to the new plaintext.
        expect(after.ciphertext).not.toBe(before.ciphertext);
        expect(after.ciphertext).not.toContain('second-value');
        await expect(decrypt(after.ciphertext, app2.masterKey)).resolves.toBe('second-value');

        // Exactly one row — a delete-then-recreate would leave a different id
        // here, and an insert-without-delete a second row.
        expect(listSecrets(app2.db)).toHaveLength(1);
        const resolved = getSecretByName(app2.db, 'rotate-me', 'local')!;
        expect(resolved.id).toBe(created.id);
      } finally {
        await app2.close();
      }
    });

    it('REFUSES a name in the body — rotation may never rename the lookup key', async () => {
      const app2 = await buildTestApp();
      try {
        const created = (
          await app2.inject({
            method: 'POST',
            url: '/api/secrets',
            payload: { name: 'keep-my-name', secret: 'v1' },
          })
        ).json();

        const res = await app2.inject({
          method: 'PATCH',
          url: `/api/secrets/${created.id}`,
          payload: { name: 'renamed', secret: 'v2' },
        });
        expect(res.statusCode).toBe(400);
        // …and it is a REFUSAL, not a silent drop of the extra key: the value
        // must not have rotated either.
        const row = getSecret(app2.db, created.id)!;
        expect(row.name).toBe('keep-my-name');
        await expect(decrypt(row.ciphertext, app2.masterKey)).resolves.toBe('v1');
      } finally {
        await app2.close();
      }
    });

    it('a body with no value at all is a 400', async () => {
      const app2 = await buildTestApp();
      try {
        const created = (
          await app2.inject({
            method: 'POST',
            url: '/api/secrets',
            payload: { name: 'needs-a-value', secret: 'v1' },
          })
        ).json();
        const res = await app2.inject({
          method: 'PATCH',
          url: `/api/secrets/${created.id}`,
          payload: {},
        });
        expect(res.statusCode).toBe(400);
      } finally {
        await app2.close();
      }
    });

    it('PATCH of an unknown id is a 404', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/secrets/sec_missing',
        payload: { secret: 'v' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('owner scoping: another owner’s secret 404s and is left untouched', async () => {
      const app2 = await buildTestApp();
      try {
        const theirs = createSecret(app2.db, {
          ref: 'secref_theirs_1061',
          ciphertext: await encrypt('their-value', app2.masterKey),
          ownerId: 'someone-else',
          name: 'not-mine',
        });

        const res = await app2.inject({
          method: 'PATCH',
          url: `/api/secrets/${theirs.id}`,
          payload: { secret: 'stolen' },
        });
        expect(res.statusCode).toBe(404);
        await expect(
          decrypt(getSecret(app2.db, theirs.id)!.ciphertext, app2.masterKey),
        ).resolves.toBe('their-value');
      } finally {
        await app2.close();
      }
    });

    it('a CONNECTION-owned secret is unreachable here, even though this route could reach the row', async () => {
      const app2 = await buildTestApp();
      try {
        const conn = (
          await app2.inject({
            method: 'POST',
            url: '/api/connections',
            payload: { name: 'keyed', kind: 'anthropic_api', config: {}, secret: 'conn-value' },
          })
        ).json();
        const ref = getConnection(app2.db, conn.id)!.secretRef!;
        const connSecret = getSecretByRef(app2.db, ref)!;
        expect(connSecret.name).toBeNull();

        // A connection's secret is managed through its connection
        // (`PATCH /api/connections/:id`), never by id here.
        const res = await app2.inject({
          method: 'PATCH',
          url: `/api/secrets/${connSecret.id}`,
          payload: { secret: 'sideways' },
        });
        expect(res.statusCode).toBe(404);
        await expect(
          decrypt(getSecretByRef(app2.db, ref)!.ciphertext, app2.masterKey),
        ).resolves.toBe('conn-value');
      } finally {
        await app2.close();
      }
    });

    /*
     * The test above passes on `requireOwned` ALONE — a connection-owned secret
     * carries `ownerId = null`, so it can never match a principal and is
     * already unreachable. That makes it silent about the route's SECOND
     * guard, `name === null`, which the DELETE route documents as
     * belt-and-braces "even if a future connection-owned secret were ever
     * stamped with an owner". This test constructs exactly that row, so the
     * guard is load-bearing somewhere rather than asserted only in prose. A
     * nameless secret has no `{ "$secret": "<name>" }` marker to rotate for,
     * and this route addresses standalone secrets only.
     */
    it('a nameless secret stamped WITH an owner is still refused — the standalone guard, on its own', async () => {
      const app2 = await buildTestApp();
      try {
        const nameless = createSecret(app2.db, {
          ref: 'secref_nameless_1061',
          ciphertext: await encrypt('nameless-value', app2.masterKey),
          ownerId: 'local',
          name: null,
        });

        const res = await app2.inject({
          method: 'PATCH',
          url: `/api/secrets/${nameless.id}`,
          payload: { secret: 'sideways' },
        });
        expect(res.statusCode).toBe(404);
        await expect(
          decrypt(getSecret(app2.db, nameless.id)!.ciphertext, app2.masterKey),
        ).resolves.toBe('nameless-value');
      } finally {
        await app2.close();
      }
    });
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
