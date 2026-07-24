import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkspaceEvent } from '@autonomy-studio/shared';
import { workspaceEvents } from '../../db/schema.js';
import {
  appendWorkspaceEvent,
  getActivePublishedVersion,
  listWorkspaceEventsPage,
} from '../workspace-events.js';
import * as workspaceEventsRepo from '../workspace-events.js';
import { decodeCursor } from '../pagination.js';
import { freshDb } from './helpers.js';

const OWNER = 'owner_a';
const OTHER = 'owner_b';

const repoConnected: WorkspaceEvent = {
  type: 'repo.connected',
  repoUrl: 'https://example.com/repo.git',
  collabBranch: 'main',
  by: 'user_1',
};
const pipelineArchived: WorkspaceEvent = {
  type: 'pipeline.archived',
  resourceId: 'res_pipe',
  name: 'My Pipeline',
  disabledTriggerIds: ['trg_1', 'trg_2'],
  by: 'user_1',
};
const importApplied: WorkspaceEvent = {
  type: 'import.applied',
  head: 'deadbeefcafe',
  branch: 'main',
  applied: [
    {
      path: 'pipelines/my-pipeline.json',
      kind: 'pipeline',
      resourceId: 'res_pipe',
      action: 'updated',
      versionMinted: true,
    },
  ],
  archived: [],
  by: 'user_1',
};

function published(
  overrides: Partial<Extract<WorkspaceEvent, { type: 'pipeline.published' }>> = {},
): WorkspaceEvent {
  return {
    type: 'pipeline.published',
    pipeline: 'res_pipe',
    from: null,
    to: 'pv_1',
    commit: 'commit_sha_1',
    blob: 'blob_sha_1',
    by: 'user_1',
    ...overrides,
  };
}

function firstPage(db: ReturnType<typeof freshDb>['db'], ownerId: string, limit = 50) {
  return listWorkspaceEventsPage(db, ownerId, { limit });
}

describe('workspace-events repo (#3 G6a — the workspace-audit log)', () => {
  it('appends each event kind and reads it back, typed', () => {
    const { db } = freshDb();
    const a = appendWorkspaceEvent(db, OWNER, repoConnected);
    const b = appendWorkspaceEvent(db, OWNER, pipelineArchived);
    const c = appendWorkspaceEvent(db, OWNER, importApplied);

    // The envelope `type` column is stamped FROM the payload — never disagrees.
    expect([a.type, b.type, c.type]).toEqual([
      'repo.connected',
      'pipeline.archived',
      'import.applied',
    ]);
    expect(a.payload).toEqual(repoConnected);
    expect(b.payload).toEqual(pipelineArchived);
    expect(c.payload).toEqual(importApplied);

    const page = firstPage(db, OWNER);
    expect(page.items.map((e) => e.payload)).toEqual([
      repoConnected,
      pipelineArchived,
      importApplied,
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('assigns a monotonic per-owner seq starting at 0', () => {
    const { db } = freshDb();
    const a0 = appendWorkspaceEvent(db, OWNER, repoConnected);
    const a1 = appendWorkspaceEvent(db, OWNER, pipelineArchived);
    const a2 = appendWorkspaceEvent(db, OWNER, importApplied);
    expect([a0.seq, a1.seq, a2.seq]).toEqual([0, 1, 2]);
  });

  it('scopes seq (and reads) per owner — two owners each start at 0, never cross', () => {
    const { db } = freshDb();
    const a0 = appendWorkspaceEvent(db, OWNER, repoConnected);
    const b0 = appendWorkspaceEvent(db, OTHER, repoConnected);
    const a1 = appendWorkspaceEvent(db, OWNER, pipelineArchived);

    expect([a0.seq, a1.seq]).toEqual([0, 1]);
    expect(b0.seq).toBe(0);
    // Owner isolation: OTHER never sees OWNER's events (authn ≠ authz).
    expect(firstPage(db, OTHER).items.map((e) => e.id)).toEqual([b0.id]);
    expect(firstPage(db, OWNER).items.map((e) => e.id)).toEqual([a0.id, a1.id]);
  });

  it('lists an empty owner as an empty page (no rows, no cursor)', () => {
    const { db } = freshDb();
    appendWorkspaceEvent(db, OTHER, repoConnected); // a different owner has data
    const page = firstPage(db, OWNER);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a malformed payload through the union — nothing is inserted', () => {
    const { db } = freshDb();
    expect(() =>
      appendWorkspaceEvent(db, OWNER, {
        type: 'repo.connected',
        // missing collabBranch + by
        repoUrl: 'https://example.com/repo.git',
      } as unknown as WorkspaceEvent),
    ).toThrow();
    // An unknown discriminant is refused too.
    expect(() =>
      appendWorkspaceEvent(db, OWNER, { type: 'not.a.real.event' } as unknown as WorkspaceEvent),
    ).toThrow();
    expect(firstPage(db, OWNER).items).toEqual([]);
  });

  it('is append-only at the DB layer — a raw UPDATE or DELETE aborts (SQL trigger)', () => {
    const { db } = freshDb();
    const row = appendWorkspaceEvent(db, OWNER, repoConnected);
    expect(() =>
      db
        .update(workspaceEvents)
        .set({ type: 'tampered' })
        .where(eq(workspaceEvents.id, row.id))
        .run(),
    ).toThrow();
    expect(() => db.delete(workspaceEvents).where(eq(workspaceEvents.id, row.id)).run()).toThrow();
    // The row survived both attempts, unchanged.
    expect(firstPage(db, OWNER).items).toEqual([row]);
  });

  it('rejects a duplicate (ownerId, seq) pair at the DB layer (unique index)', () => {
    const { db } = freshDb();
    const row = {
      id: 'wev_dup_1',
      ownerId: OWNER,
      seq: 0,
      type: 'repo.connected',
      payload: repoConnected,
      createdAt: Date.now(),
    };
    db.insert(workspaceEvents).values(row).run();
    expect(() =>
      db
        .insert(workspaceEvents)
        .values({ ...row, id: 'wev_dup_2' })
        .run(),
    ).toThrow();
  });

  it('has no update/delete export — the append-only invariant in the module surface', () => {
    const mod = workspaceEventsRepo as unknown as Record<string, unknown>;
    expect(mod['updateWorkspaceEvent']).toBeUndefined();
    expect(mod['deleteWorkspaceEvent']).toBeUndefined();
  });

  it('paginates with the shared keyset cursor — complete, non-overlapping pages', () => {
    const { db } = freshDb();
    const ids = [
      appendWorkspaceEvent(db, OWNER, repoConnected).id,
      appendWorkspaceEvent(db, OWNER, pipelineArchived).id,
      appendWorkspaceEvent(db, OWNER, importApplied).id,
    ];

    const page1 = listWorkspaceEventsPage(db, OWNER, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const cursor = page1.nextCursor;
    if (cursor === null) throw new Error('expected a next cursor');
    const key = decodeCursor(cursor);
    if (key === null) throw new Error('expected a decodable cursor');
    const page2 = listWorkspaceEventsPage(db, OWNER, { limit: 2, cursor: key });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    // Union of both pages = every event, no duplicates.
    const seen = [...page1.items, ...page2.items].map((e) => e.id);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(3);
  });
});

describe('getActivePublishedVersion (#3 G6c-1 — the active pointer projection)', () => {
  it('appends and reads back a pipeline.published event, typed', () => {
    const { db } = freshDb();
    const row = appendWorkspaceEvent(db, OWNER, published());
    expect(row.type).toBe('pipeline.published');
    expect(row.payload).toEqual(published());
  });

  it('returns null when the pipeline has never been published', () => {
    const { db } = freshDb();
    // Other event kinds for the same owner must not be mistaken for a publish.
    appendWorkspaceEvent(db, OWNER, repoConnected);
    appendWorkspaceEvent(db, OWNER, pipelineArchived);
    expect(getActivePublishedVersion(db, OWNER, 'res_pipe')).toBeNull();
  });

  it('projects the LATEST publish (by append seq), not the newest wall-clock', () => {
    const { db } = freshDb();
    appendWorkspaceEvent(db, OWNER, published({ from: null, to: 'pv_1' }));
    appendWorkspaceEvent(db, OWNER, published({ from: 'pv_1', to: 'pv_2' }));
    appendWorkspaceEvent(
      db,
      OWNER,
      published({ from: 'pv_2', to: 'pv_3', commit: 'c3', blob: 'b3' }),
    );
    const active = getActivePublishedVersion(db, OWNER, 'res_pipe');
    expect(active).not.toBeNull();
    expect(active?.to).toBe('pv_3');
    expect(active?.commit).toBe('c3');
    expect(active?.blob).toBe('b3');
  });

  it('is scoped per pipeline resourceId — two pipelines never cross', () => {
    const { db } = freshDb();
    appendWorkspaceEvent(db, OWNER, published({ pipeline: 'res_a', to: 'pv_a' }));
    appendWorkspaceEvent(db, OWNER, published({ pipeline: 'res_b', to: 'pv_b' }));
    expect(getActivePublishedVersion(db, OWNER, 'res_a')?.to).toBe('pv_a');
    expect(getActivePublishedVersion(db, OWNER, 'res_b')?.to).toBe('pv_b');
    expect(getActivePublishedVersion(db, OWNER, 'res_missing')).toBeNull();
  });

  it('is owner-scoped — one owner never sees another owner active pointer', () => {
    const { db } = freshDb();
    appendWorkspaceEvent(db, OTHER, published({ pipeline: 'res_pipe', to: 'pv_other' }));
    // OWNER has no publish for res_pipe, even though OTHER does.
    expect(getActivePublishedVersion(db, OWNER, 'res_pipe')).toBeNull();
    expect(getActivePublishedVersion(db, OTHER, 'res_pipe')?.to).toBe('pv_other');
  });
});
