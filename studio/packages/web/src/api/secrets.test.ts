import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecret, deleteSecret, listSecrets } from './secrets';

const sample = {
  id: 'sec_1',
  ownerId: 'local',
  name: 'stripe-key',
  createdAt: 1_700_000_000_000,
};

function stubFetch(status: number, jsonBody: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(jsonBody),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('secrets API', () => {
  it('lists secrets and hits GET /api/secrets (paginated envelope, #534)', async () => {
    const fetchMock = stubFetch(200, { items: [sample], nextCursor: null });
    const out = await listSecrets();
    expect(out).toEqual([sample]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/secrets?limit=100');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('never carries key material — ciphertext and ref are stripped, not surfaced', async () => {
    // `SecretPublicSchema` omits both, so even a server that leaked them could
    // not put them in front of the page. This is the page's write-only claim
    // enforced at the client boundary, not merely assumed of the server.
    stubFetch(200, {
      items: [{ ...sample, ciphertext: 'base64:opaque', ref: 'secref_1' }],
      nextCursor: null,
    });
    const [out] = await listSecrets();
    expect(out).not.toHaveProperty('ciphertext');
    expect(out).not.toHaveProperty('ref');
  });

  it('REJECTS a nameless row rather than rendering a nameless secret', async () => {
    // `SecretSchema.name` is nullable because it also covers CONNECTION-owned
    // rows (`name = null`, addressed by opaque ref). This endpoint cannot
    // return one — `listNamedSecretsPage` filters `isNotNull(secrets.name)`
    // (packages/server/src/repo/secrets.ts) — so a null here means the server
    // broke that contract. Failing loudly beats rendering "Delete null" and
    // offering a delete the route would 404: the DELETE route refuses a
    // `name === null` row on purpose.
    stubFetch(200, { items: [{ ...sample, name: null }], nextCursor: null });
    await expect(listSecrets()).rejects.toThrow();
  });

  it('applies the public schema — a malformed row rejects', async () => {
    const noCreatedAt: Record<string, unknown> = { ...sample };
    delete noCreatedAt.createdAt;
    stubFetch(200, { items: [noCreatedAt], nextCursor: null });
    await expect(listSecrets()).rejects.toThrow();
  });

  it('walks every page, so the list is not silently truncated at one page', async () => {
    const second = { ...sample, id: 'sec_2', name: 'openai-key' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [sample], nextCursor: 'cur_1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ items: [second], nextCursor: null }),
      });
    vi.stubGlobal('fetch', fetchMock);

    expect(await listSecrets()).toEqual([sample, second]);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/secrets?limit=100&cursor=cur_1');
  });

  it('creates a secret via POST and returns the public projection', async () => {
    const fetchMock = stubFetch(201, sample);
    const out = await createSecret({ name: 'stripe-key', secret: 'sk_live_123' });
    expect(out).toEqual(sample);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/secrets');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'stripe-key',
      secret: 'sk_live_123',
    });
  });

  it('deletes by id, URL-encoding it', async () => {
    const fetchMock = stubFetch(204, null);
    await deleteSecret('sec/1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/secrets/sec%2F1');
    expect(init?.method).toBe('DELETE');
  });
});
