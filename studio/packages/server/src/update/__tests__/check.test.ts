import { describe, expect, it, vi } from 'vitest';
import { checkForUpdate } from '../check.js';

const current = {
  version: '2026.07.29',
  commit: 'aaa',
  builtAt: '2026-07-29T00:00:00.000Z',
  arch: 'arm64',
};
const remote = (version: string) =>
  new Response(
    JSON.stringify({ version, commit: 'bbb', builtAt: '2026-07-30T00:00:00.000Z', arch: 'arm64' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('checkForUpdate', () => {
  it('reports an update when the published version differs', async () => {
    const res = await checkForUpdate(current, vi.fn().mockResolvedValue(remote('2026.07.30')));
    expect(res.updateAvailable).toBe(true);
    expect(res.latest?.version).toBe('2026.07.30');
  });

  it('reports none when the published version matches', async () => {
    const res = await checkForUpdate(current, vi.fn().mockResolvedValue(remote('2026.07.29')));
    expect(res.updateAvailable).toBe(false);
  });

  // Offline is NOT "up to date". Reporting no-update on a failed fetch would be
  // fail-open on the one signal this endpoint exists to give.
  it('reports latest=null, not updateAvailable=false, when the check fails', async () => {
    const res = await checkForUpdate(current, vi.fn().mockRejectedValue(new Error('offline')));
    expect(res.latest).toBeNull();
    expect(res.updateAvailable).toBe(false);
  });

  // A dev build must never claim an update is available: its placeholder version
  // differs from every published one, which would show the banner permanently.
  it('never reports an update for a dev build', async () => {
    const dev = { ...current, version: '0.0.0-dev', commit: 'dev' };
    const res = await checkForUpdate(dev, vi.fn().mockResolvedValue(remote('2026.07.30')));
    expect(res.updateAvailable).toBe(false);
  });
});
