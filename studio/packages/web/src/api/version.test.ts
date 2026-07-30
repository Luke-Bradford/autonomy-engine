import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVersion } from './version';

afterEach(() => vi.restoreAllMocks());

describe('getVersion', () => {
  it('parses the build identity through the shared schema', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          version: '2026.07.30',
          commit: 'e93ebf8',
          builtAt: '2026-07-30T09:12:44.000Z',
          arch: 'arm64',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(getVersion()).resolves.toMatchObject({ version: '2026.07.30', arch: 'arm64' });
  });

  // A response that does not match the shared schema must REJECT rather than
  // flow a half-typed object into the UI — the schema is a contract check.
  it('rejects a response of the wrong shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: 42 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(getVersion()).rejects.toThrow();
  });
});
