import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApiErrorBody } from '@autonomy-studio/shared';
import {
  ADVISORY_DETAIL_MAX,
  advisoryDetail,
  apiFetch,
  ApiError,
  apiIssuesOf,
  formatApiIssues,
} from './client';

const Thing = z.object({ id: z.string(), n: z.number() });

function mockFetch(status: number, jsonBody: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(jsonBody),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('parses a 200 JSON body through the supplied schema', async () => {
    mockFetch(200, { id: 'a', n: 1 });
    const out = await apiFetch('/api/things/a', { schema: Thing });
    expect(out).toEqual({ id: 'a', n: 1 });
  });

  it('returns the raw JSON when no schema is given', async () => {
    mockFetch(200, { anything: true });
    const out = await apiFetch('/api/x');
    expect(out).toEqual({ anything: true });
  });

  it('throws a ZodError when the response violates the schema', async () => {
    mockFetch(200, { id: 'a', n: 'not-a-number' });
    await expect(apiFetch('/api/things/a', { schema: Thing })).rejects.toBeInstanceOf(z.ZodError);
  });

  it('sends a JSON body with a content-type header on writes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ id: 'a', n: 2 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/things', { method: 'POST', body: { n: 2 }, schema: Thing });

    expect(fetchMock).toHaveBeenCalledWith('/api/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 2 }),
    });
  });

  it('returns undefined for 204 without touching json()', async () => {
    const json = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, json }));
    const out = await apiFetch('/api/things/a', { method: 'DELETE' });
    expect(out).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('throws ApiError with the server message on a 404', async () => {
    mockFetch(404, { error: 'not_found', message: 'connection "x" not found' });
    await expect(apiFetch('/api/connections/x')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'connection "x" not found',
    });
  });

  it('joins validation issues into the ApiError message', async () => {
    mockFetch(400, {
      error: 'validation_error',
      issues: [
        { path: 'name', message: 'Required' },
        { path: 'kind', message: 'Invalid enum value' },
      ],
    });
    await expect(apiFetch('/api/connections', { method: 'POST', body: {} })).rejects.toThrow(
      'name: Required; kind: Invalid enum value',
    );
  });

  it('states the remainder when a capped validation_error body is truncated (#496)', async () => {
    mockFetch(400, {
      error: 'validation_error',
      issues: [
        { path: 'a', message: 'x' },
        { path: 'b', message: 'y' },
      ],
      truncated: true,
      totalIssues: 152,
    });
    // The joined message shows what the body carried, then names the remainder
    // (total minus shown), so the client never silently renders "first N of many".
    await expect(apiFetch('/api/connections', { method: 'POST', body: {} })).rejects.toThrow(
      'a: x; b: y; …and 150 more',
    );
  });

  it('falls back to a generic message when the error body violates the shared contract (#525)', async () => {
    // A wrong-typed `message` (number, not string) is not a valid ApiErrorBody.
    // The client parses through the shared schema, so it treats the body as
    // absent and falls back to the generic message rather than trusting a
    // blind cast — and never throws a second error while handling the first.
    mockFetch(500, { error: 'internal_error', message: 42 });
    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe('request failed (500)');
    expect((err as ApiError).body).toBeUndefined();
  });

  it('falls back to a generic message when the error body is unparseable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      }),
    );
    const err = await apiFetch('/api/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe('request failed (500)');
  });
});

describe('formatApiIssues / apiIssuesOf (#1396)', () => {
  const body: ApiErrorBody = {
    error: 'validation_error',
    issues: [
      { path: 'name', message: 'too short' },
      { path: 'config.url', message: 'bad url' },
    ],
    truncated: true,
    totalIssues: 5,
  };

  it('words a SUBSET of the issues, counting the remainder from the whole body', () => {
    expect(formatApiIssues([body.issues![1]!], body)).toBe('config.url: bad url; …and 3 more');
    // Every shown issue found a field: the uncounted remainder is still stated.
    expect(formatApiIssues([], body)).toBe('…and 3 more');
    expect(formatApiIssues(body.issues!, { issues: body.issues })).toBe(
      'name: too short; config.url: bad url',
    );
  });

  it('hands back the issues of a refused write, never of a message-bearing error', () => {
    expect(apiIssuesOf(new ApiError(400, 'x', body))).toEqual({ issues: body.issues, body });
    expect(apiIssuesOf(new ApiError(400, 'x', { ...body, message: 'said so' }))).toBeNull();
    expect(
      apiIssuesOf(new ApiError(400, 'x', { error: 'validation_error', issues: [] })),
    ).toBeNull();
    expect(apiIssuesOf(new Error('network'))).toBeNull();
  });
});

describe('advisoryDetail (#1487)', () => {
  it('collapses whitespace to one line and trims it', () => {
    expect(advisoryDetail('  offline:\n\tretry  later ')).toBe('offline: retry later');
  });

  it('keeps a detail at the bound whole', () => {
    const exact = 'x'.repeat(ADVISORY_DETAIL_MAX);
    expect(advisoryDetail(exact)).toBe(exact);
  });

  it('cuts a longer detail to the bound, ending in an ellipsis', () => {
    const out = advisoryDetail('y'.repeat(ADVISORY_DETAIL_MAX + 50));
    expect(out).toHaveLength(ADVISORY_DETAIL_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
});
