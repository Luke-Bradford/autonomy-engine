import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConnection,
  deleteConnection,
  listConnections,
  updateConnection,
} from './connections';

const sample = {
  id: 'conn_1',
  ownerId: 'local',
  name: 'Claude',
  kind: 'anthropic_api' as const,
  config: { model: 'claude-opus-4-8' },
  parameters: [],
  createdAt: 1,
  updatedAt: 1,
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

describe('connections API', () => {
  it('lists connections and hits GET /api/connections (paginated envelope, #534)', async () => {
    const fetchMock = stubFetch(200, { items: [sample], nextCursor: null });
    const out = await listConnections();
    expect(out).toEqual([sample]);
    const [url, init] = fetchMock.mock.calls[0]!;
    // The list is keyset-paginated: the wrapper requests a bounded page.
    expect(url).toBe('/api/connections?limit=100');
    // GET is the default: no explicit method needed, and no body is sent.
    expect(init?.method ?? 'GET').toBe('GET');
    expect(out[0]).not.toHaveProperty('secretRef');
  });

  it('applies the public schema — a malformed row rejects', async () => {
    // Drop a required field so the response genuinely violates the schema;
    // this fails only if `listConnections` actually validates (not raw JSON).
    const noName: Record<string, unknown> = { ...sample };
    delete noName.name;
    stubFetch(200, { items: [noName], nextCursor: null });
    await expect(listConnections()).rejects.toThrow();
  });

  it('strips a stray secretRef from a list response instead of surfacing it', async () => {
    // ConnectionPublicSchema strips unknown keys, so a stray secretRef is
    // dropped rather than surfaced — assert it is gone.
    stubFetch(200, { items: [{ ...sample, secretRef: 'sec_leak' }], nextCursor: null });
    const out = await listConnections();
    expect(out[0]).not.toHaveProperty('secretRef');
  });

  it('threads an AbortSignal through to fetch', async () => {
    const fetchMock = stubFetch(200, { items: [], nextCursor: null });
    const controller = new AbortController();
    await listConnections(controller.signal);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.signal).toBe(controller.signal);
  });

  it('POSTs a create body to /api/connections', async () => {
    const fetchMock = stubFetch(201, sample);
    await createConnection({ name: 'Claude', kind: 'anthropic_api', config: {}, secret: 'sk-x' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/connections');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'Claude',
      kind: 'anthropic_api',
      config: {},
      secret: 'sk-x',
    });
  });

  it('PATCHes an update and URL-encodes the id', async () => {
    const fetchMock = stubFetch(200, sample);
    await updateConnection('conn/with space', { name: 'Renamed' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/connections/conn%2Fwith%20space');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed' });
  });

  it('DELETEs by id and resolves undefined on 204', async () => {
    const fetchMock = stubFetch(204, undefined);
    const out = await deleteConnection('conn_1');
    expect(out).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/connections/conn_1');
    expect(init.method).toBe('DELETE');
  });
});
