import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_PAGE_SIZE, fetchWorkspaceAuditPage } from './workspaceAudit';

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

describe('workspace-audit API (#1075, paged newest-first by #1076)', () => {
  const url = `/api/workspace/audit?order=desc&limit=${AUDIT_PAGE_SIZE}`;

  it('reads ONE page and returns it whole — items and the cursor', async () => {
    const fetchMock = stubFetch([{ items: [eventRow(9, ARCHIVED)], nextCursor: 'cur_1' }]);

    const page = await fetchWorkspaceAuditPage(undefined);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.payload).toEqual(ARCHIVED);
    // The cursor is handed BACK rather than followed. Before #1076 this wrapper
    // walked to the end of the log to render its newest rows; a walk would show
    // up here as a second call.
    expect(page.nextCursor).toBe('cur_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(url);
  });

  /**
   * `order=desc` is what makes the FIRST page the newest entries. Without it the
   * page would render the oldest events under a "most recent first" caption —
   * wrong in the one direction that matters — and a cursor names a position with
   * no direction of its own, so it has to be on every request, not just the
   * first.
   */
  it('asks for descending order on every page, and threads the cursor', async () => {
    const fetchMock = stubFetch([
      { items: [eventRow(9, ARCHIVED)], nextCursor: 'cur_1' },
      { items: [eventRow(8, ARCHIVED)], nextCursor: null },
    ]);

    await fetchWorkspaceAuditPage(undefined);
    const older = await fetchWorkspaceAuditPage('cur_1');

    expect(older.items.map((row) => row.seq)).toEqual([8]);
    expect(fetchMock.mock.calls[0]![0]).toBe(url);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${url}&cursor=cur_1`);
  });

  it('threads the abort signal through', async () => {
    const fetchMock = stubFetch([{ items: [eventRow(0, ARCHIVED)], nextCursor: null }]);
    const controller = new AbortController();

    await fetchWorkspaceAuditPage(undefined, controller.signal);

    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(controller.signal);
  });

  /**
   * The parse is deliberately ALL-OR-NOTHING (see the module docblock): on an
   * audit surface, a row that cannot be read must fail loudly rather than be
   * dropped, because a silently partial history reads exactly like a complete
   * one. This pins that polarity so a later "resilience" change has to argue
   * with a test rather than with a comment.
   */
  it('rejects the whole page rather than dropping a row it cannot parse', async () => {
    stubFetch([
      {
        items: [eventRow(0, ARCHIVED), eventRow(1, { type: 'pipeline.teleported' })],
        nextCursor: null,
      },
    ]);

    await expect(fetchWorkspaceAuditPage(undefined)).rejects.toThrow();
  });
});
