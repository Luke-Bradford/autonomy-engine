import { describe, expect, it } from 'vitest';
import {
  createWorkspaceGit,
  deleteWorkspaceGit,
  getWorkspaceGit,
  updateWorkspaceGitSync,
  updateWorkspaceGitWorkingBranch,
} from '../workspace-git.js';
import { freshDb } from './helpers.js';

const input = {
  ownerId: 'local',
  repoUrl: '/repos/widgets',
  collabBranch: 'main',
  workingBranch: 'studio/local/work',
  observedCollabHead: 'a'.repeat(40),
  lastFetchAt: 1_700_000_000_000,
  lastFetchError: null,
};

describe('workspace-git repo', () => {
  it('create → get round-trips (owner-scoped)', () => {
    const { db } = freshDb();
    const created = createWorkspaceGit(db, input);
    expect(created.id).toMatch(/^wsgit_/);
    expect(getWorkspaceGit(db, 'local')).toEqual(created);
    expect(getWorkspaceGit(db, 'other')).toBeNull();
  });

  it('a second row for the same owner is refused by the DB (one repo per owner)', () => {
    const { db } = freshDb();
    createWorkspaceGit(db, input);
    expect(() => createWorkspaceGit(db, { ...input, repoUrl: '/repos/other' })).toThrow(/UNIQUE/);
  });

  it('updateWorkspaceGitSync updates only the tracking fields + updatedAt', () => {
    const { db } = freshDb();
    const created = createWorkspaceGit(db, input);
    const updated = updateWorkspaceGitSync(db, 'local', {
      observedCollabHead: null,
      lastFetchAt: 1_700_000_001_000,
      lastFetchError: 'fetch failed',
    });
    expect(updated).not.toBeNull();
    expect(updated!.observedCollabHead).toBeNull();
    expect(updated!.lastFetchError).toBe('fetch failed');
    expect(updated!.repoUrl).toBe(created.repoUrl);
    expect(updated!.collabBranch).toBe(created.collabBranch);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(getWorkspaceGit(db, 'local')).toEqual(updated);
  });

  it('updateWorkspaceGitSync on an unconnected owner returns null', () => {
    const { db } = freshDb();
    expect(
      updateWorkspaceGitSync(db, 'local', {
        observedCollabHead: null,
        lastFetchAt: 1,
        lastFetchError: null,
      }),
    ).toBeNull();
  });

  it('updateWorkspaceGitWorkingBranch sets only the working branch + updatedAt', () => {
    const { db } = freshDb();
    const created = createWorkspaceGit(db, input);
    const updated = updateWorkspaceGitWorkingBranch(db, 'local', 'studio/luke/feature-x');
    expect(updated).not.toBeNull();
    expect(updated!.workingBranch).toBe('studio/luke/feature-x');
    // Every other field is preserved (the narrow single-field mutation).
    expect(updated!.repoUrl).toBe(created.repoUrl);
    expect(updated!.collabBranch).toBe(created.collabBranch);
    expect(updated!.observedCollabHead).toBe(created.observedCollabHead);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(getWorkspaceGit(db, 'local')).toEqual(updated);
  });

  it('updateWorkspaceGitWorkingBranch on an unconnected owner returns null', () => {
    const { db } = freshDb();
    expect(updateWorkspaceGitWorkingBranch(db, 'local', 'studio/luke/x')).toBeNull();
  });

  it('delete removes the row for that owner only', () => {
    const { db } = freshDb();
    createWorkspaceGit(db, input);
    createWorkspaceGit(db, { ...input, ownerId: 'other' });
    expect(deleteWorkspaceGit(db, 'local')).toBe(true);
    expect(getWorkspaceGit(db, 'local')).toBeNull();
    expect(getWorkspaceGit(db, 'other')).not.toBeNull();
    expect(deleteWorkspaceGit(db, 'local')).toBe(false);
  });
});
