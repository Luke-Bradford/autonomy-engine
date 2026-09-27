import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGlobalParam,
  deleteGlobalParam,
  listGlobalParams,
  updateGlobalParam,
} from './globalParams';

const sample = {
  id: 'gp_1',
  ownerId: 'local',
  name: 'apiUrl',
  type: 'string',
  value: 'https://example.test',
  description: '',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
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

describe('global-params API (#844 GL2)', () => {
  it('walks every page of GET /api/global-params', async () => {
    const second = { ...sample, id: 'gp_2', name: 'retries', type: 'number', value: 3 };
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
    expect(await listGlobalParams()).toEqual([sample, second]);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/global-params?limit=100');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/global-params?limit=100&cursor=cur_1');
  });

  it('applies the row schema — a row with an unknown type rejects', async () => {
    stubFetch(200, { items: [{ ...sample, type: 'secret' }], nextCursor: null });
    await expect(listGlobalParams()).rejects.toThrow();
  });

  it('creates via POST with the body as given', async () => {
    const fetchMock = stubFetch(201, sample);
    const body = { name: 'apiUrl', type: 'string' as const, value: 'x', description: '' };
    expect(await createGlobalParam(body)).toEqual(sample);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/global-params');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(body);
  });

  it('patches by id, URL-encoding it, sending only what it is given', async () => {
    const fetchMock = stubFetch(200, sample);
    await updateGlobalParam('gp/1', { value: 'y' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/global-params/gp%2F1');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ value: 'y' });
  });

  it('deletes by id, URL-encoding it', async () => {
    const fetchMock = stubFetch(204, undefined);
    await deleteGlobalParam('gp/1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/global-params/gp%2F1');
    expect(init?.method).toBe('DELETE');
  });
});
