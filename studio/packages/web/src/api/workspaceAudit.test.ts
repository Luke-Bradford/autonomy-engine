import { afterEach, describe, expect, it, vi } from 'vitest';
import { listWorkspaceAudit } from './workspaceAudit';

function eventRow(seq: number, payload: unknown) {
  return {
    id: `wse_${seq}`,
    ownerId: 'local',
    seq,
    type: (payload as { type: string }).type,
    payload,
    createdAt: 1_700_000_000_000 + seq,
  };
}

const ARCHIVED = {
  type: 'pipeline.archived',
  resourceId: 'res_a',
  name: 'Nightly report',
  disabledTriggerIds: [],
  by: 'local',
};

function stubFetch(pages: unknown[]) {
  let call = 0;
  const fetchMock = vi.fn().mockImplementation(() => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace-audit API (#1075)', () => {
  it('reads GET /api/workspace/audit and returns the parsed rows', async () => {
    const fetchMock = stubFetch([{ items: [eventRow(0, ARCHIVED)], nextCursor: null }]);

    const out = await listWorkspaceAudit();

    expect(out).toHaveLength(1);
    expect(out[0]!.payload).toEqual(ARCHIVED);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workspace/audit?limit=100');
  });

  /**
   * The page renders the newest entries by reversing this walk, so a wrapper
   * that stopped at the first page would show the OLDEST events under a
   * "most recent first" caption — wrong in the one direction that matters.
   */
  it('walks every page, keeping the server append order', async () => {
    const fetchMock = stubFetch([
      { items: [eventRow(0, ARCHIVED), eventRow(1, ARCHIVED)], nextCursor: 'cur_1' },
      { items: [eventRow(2, ARCHIVED)], nextCursor: null },
    ]);

    const out = await listWorkspaceAudit();

    expect(out.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/workspace/audit?limit=100&cursor=cur_1');
  });

  it('threads the abort signal through every page of the walk', async () => {
    const fetchMock = stubFetch([
      { items: [eventRow(0, ARCHIVED)], nextCursor: 'cur_1' },
      { items: [eventRow(1, ARCHIVED)], nextCursor: null },
    ]);
    const controller = new AbortController();

    await listWorkspaceAudit(controller.signal);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBe(controller.signal);
    }
  });

  /**
   * The parse is deliberately ALL-OR-NOTHING (see the module docblock): on an
   * audit surface, a row that cannot be read must fail loudly rather than be
   * dropped, because a silently partial history reads exactly like a complete
   * one. This pins that polarity so a later "resilience" change has to argue
   * with a test rather than with a comment.
   */
  it('rejects the whole load rather than dropping a row it cannot parse', async () => {
    stubFetch([
      {
        items: [eventRow(0, ARCHIVED), eventRow(1, { type: 'pipeline.teleported' })],
        nextCursor: null,
      },
    ]);

    await expect(listWorkspaceAudit()).rejects.toThrow();
  });
});
