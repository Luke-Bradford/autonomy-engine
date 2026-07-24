import { describe, expect, it } from 'vitest';
import {
  createWorkspaceGit,
  deleteWorkspaceGit,
  getWorkspaceGit,
  getWorkspaceGitToken,
  setWorkspaceGitToken,
  updateWorkspaceGitImportedCommit,
  updateWorkspaceGitSync,
  updateWorkspaceGitWorkingBranch,
  workspaceGitTokenPresent,
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

  it('#3 G10 — a fresh connection has a null import base (never manufactured)', () => {
    const { db } = freshDb();
    const created = createWorkspaceGit(db, input);
    expect(created.importedFromCommit).toBeNull();
  });

  it('#3 G10 — updateWorkspaceGitImportedCommit sets only the base + updatedAt', () => {
    const { db } = freshDb();
    const created = createWorkspaceGit(db, input);
    const sha = 'c'.repeat(40);
    const updated = updateWorkspaceGitImportedCommit(db, 'local', sha);
    expect(updated).not.toBeNull();
    expect(updated!.importedFromCommit).toBe(sha);
    // Every other field is preserved (the narrow single-field mutation).
    expect(updated!.repoUrl).toBe(created.repoUrl);
    expect(updated!.observedCollabHead).toBe(created.observedCollabHead);
    expect(updated!.workingBranch).toBe(created.workingBranch);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(getWorkspaceGit(db, 'local')).toEqual(updated);
  });

  it('#3 G10 — updateWorkspaceGitImportedCommit on an unconnected owner returns null', () => {
    const { db } = freshDb();
    expect(updateWorkspaceGitImportedCommit(db, 'local', 'c'.repeat(40))).toBeNull();
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

  describe('#3 G10 — stored git token', () => {
    it('a fresh row has no stored token', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      expect(getWorkspaceGitToken(db, 'local')).toBeNull();
      expect(workspaceGitTokenPresent(db, 'local')).toBe(false);
    });

    it('set → get round-trips the ENCRYPTED blob (server-only reader)', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      const updated = setWorkspaceGitToken(db, 'local', 'ENCRYPTED_BLOB');
      expect(updated).not.toBeNull();
      expect(getWorkspaceGitToken(db, 'local')).toBe('ENCRYPTED_BLOB');
      expect(workspaceGitTokenPresent(db, 'local')).toBe(true);
    });

    it('the ciphertext NEVER leaks into the client-facing row (stripped by WorkspaceGitSchema)', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      setWorkspaceGitToken(db, 'local', 'ENCRYPTED_BLOB');
      const row = getWorkspaceGit(db, 'local');
      expect(row).not.toBeNull();
      expect(row).not.toHaveProperty('gitTokenEncrypted');
    });

    it('setWorkspaceGitToken(null) CLEARS the token', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      setWorkspaceGitToken(db, 'local', 'ENCRYPTED_BLOB');
      setWorkspaceGitToken(db, 'local', null);
      expect(getWorkspaceGitToken(db, 'local')).toBeNull();
      expect(workspaceGitTokenPresent(db, 'local')).toBe(false);
    });

    it('setWorkspaceGitToken on an unconnected owner returns null (no row to write)', () => {
      const { db } = freshDb();
      expect(setWorkspaceGitToken(db, 'local', 'ENCRYPTED_BLOB')).toBeNull();
    });

    it('a tracking-field update does NOT clobber the stored token (Drizzle .set touches only provided keys)', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      setWorkspaceGitToken(db, 'local', 'ENCRYPTED_BLOB');
      updateWorkspaceGitSync(db, 'local', {
        observedCollabHead: 'b'.repeat(40),
        lastFetchAt: 1_700_000_002_000,
        lastFetchError: null,
      });
      expect(getWorkspaceGitToken(db, 'local')).toBe('ENCRYPTED_BLOB');
    });

    it('a working-branch update does NOT clobber the stored token', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      setWorkspaceGitToken(db, 'local', 'ENCRYPTED_BLOB');
      updateWorkspaceGitWorkingBranch(db, 'local', 'studio/local/feature');
      expect(getWorkspaceGitToken(db, 'local')).toBe('ENCRYPTED_BLOB');
    });

    it('a token set/clear is owner-scoped', () => {
      const { db } = freshDb();
      createWorkspaceGit(db, input);
      createWorkspaceGit(db, { ...input, ownerId: 'other' });
      setWorkspaceGitToken(db, 'local', 'LOCAL_BLOB');
      expect(getWorkspaceGitToken(db, 'local')).toBe('LOCAL_BLOB');
      expect(getWorkspaceGitToken(db, 'other')).toBeNull();
    });
  });
});
