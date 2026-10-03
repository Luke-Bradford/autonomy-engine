import { describe, expect, it } from 'vitest';
import type { WorkspaceGitStatus } from '@autonomy-studio/shared';
import { canvasVersion, editingState, gitState, liveState, type EditingInput } from './editorState';

const base: EditingInput = {
  dirty: false,
  loadedVersion: 3,
  headVersion: 3,
  previewedVersion: null,
  archived: false,
};

describe('editingState', () => {
  it('a clean canvas on the head reads as the latest version', () => {
    expect(editingState(base)).toMatchObject({ label: 'v3 (latest)', tone: 'neutral' });
  });

  it('a dirty canvas is a draft on the version it was opened from', () => {
    const p = editingState({ ...base, dirty: true });
    expect(p).toMatchObject({ label: 'Draft · v3', tone: 'warning' });
    expect(p.detail).toContain('Draft — unsaved changes on v3.');
  });

  it('names the LOADED version, not the head, when the head moved on', () => {
    // After a refused save the head is refetched; the canvas stays on v1.
    const clean = editingState({ ...base, loadedVersion: 1, headVersion: 2 });
    expect(clean).toMatchObject({ label: 'v1 · v2 is newer', tone: 'warning' });
    const dirty = editingState({ ...base, dirty: true, loadedVersion: 1, headVersion: 2 });
    expect(dirty.label).toBe('Draft · v1');
    expect(dirty.detail).toContain('v2 is newer');
  });

  it('a preview names the previewed version, and marks the head', () => {
    expect(editingState({ ...base, previewedVersion: 2 })).toMatchObject({
      label: 'Viewing v2',
      tone: 'neutral',
    });
    expect(editingState({ ...base, previewedVersion: 3 }).label).toBe('Viewing v3 (latest)');
  });

  it('a preview over unsaved changes says they are kept', () => {
    expect(editingState({ ...base, dirty: true, previewedVersion: 2 }).detail).toContain(
      'unsaved changes are kept',
    );
    expect(editingState({ ...base, previewedVersion: 2 }).detail).not.toContain('unsaved');
  });

  it('a pipeline with no saved version', () => {
    const none = { ...base, loadedVersion: null, headVersion: null };
    expect(editingState(none)).toMatchObject({ label: 'Not saved', tone: 'neutral' });
    expect(editingState({ ...none, dirty: true })).toMatchObject({
      label: 'Draft',
      tone: 'warning',
    });
  });

  it('a draft on an archived pipeline promises no save', () => {
    expect(editingState({ ...base, dirty: true }).detail).toContain('Save version keeps them');
    const archived = editingState({ ...base, dirty: true, archived: true });
    expect(archived.detail).not.toContain('Save version');
    expect(archived.detail).toContain('archived');
    const none = { ...base, loadedVersion: null, headVersion: null, dirty: true, archived: true };
    expect(editingState(none).detail).not.toContain('Save version');
  });
});

describe('canvasVersion', () => {
  it('is the preview, else the loaded version, else nothing while dirty', () => {
    expect(canvasVersion({ ...base, previewedVersion: 2 })).toBe(2);
    expect(canvasVersion({ ...base, dirty: true, previewedVersion: 2 })).toBe(2);
    expect(canvasVersion({ ...base, loadedVersion: 1, headVersion: 2 })).toBe(1);
    expect(canvasVersion({ ...base, dirty: true })).toBeNull();
  });
});

describe('liveState', () => {
  it('is hidden outside git mode and while the publish state is unread', () => {
    expect(liveState({ gitConnected: false, active: null, canvas: 3 })).toBeNull();
    expect(liveState({ gitConnected: undefined, active: null, canvas: 3 })).toBeNull();
    expect(liveState({ gitConnected: true, active: undefined, canvas: 3 })).toBeNull();
  });

  it('says when nothing is published', () => {
    expect(liveState({ gitConnected: true, active: null, canvas: 3 })).toMatchObject({
      label: 'Not published',
      tone: 'warning',
    });
  });

  it('is green with a check only when the canvas IS the live version', () => {
    expect(liveState({ gitConnected: true, active: 3, canvas: 3 })).toMatchObject({
      label: 'Live: v3',
      tone: 'success',
      current: true,
    });
    const other = liveState({ gitConnected: true, active: 2, canvas: 3 });
    expect(other).toMatchObject({ label: 'Live: v2', tone: 'warning' });
    expect(other?.current).toBeUndefined();
    expect(other?.detail).toContain('the canvas shows v3');
    const dirty = liveState({ gitConnected: true, active: 3, canvas: null });
    expect(dirty).toMatchObject({ label: 'Live: v3', tone: 'warning' });
    expect(dirty?.detail).toContain('unsaved changes');
  });

  it('an active version the page has not listed is named as such, never guessed', () => {
    expect(liveState({ gitConnected: true, active: 'unnamed', canvas: 3 })).toMatchObject({
      label: 'Live: not listed yet',
      tone: 'warning',
    });
  });
});

describe('gitState', () => {
  const git: WorkspaceGitStatus = {
    id: 'wg_1',
    ownerId: null,
    repoUrl: 'file:///tmp/repo.git',
    collabBranch: 'main',
    workingBranch: 'feature/x',
    observedCollabHead: 'c0ffee0000000000000000000000000000000000',
    importedFromCommit: null,
    lastFetchAt: 1,
    lastFetchError: null,
    createdAt: 1,
    updatedAt: 1,
    state: 'ready',
    hasStoredToken: false,
  };
  const saved = { version: 3, sourceCommit: null, sourceBranch: null };

  it('is hidden with no repo, and while the repo is unread', () => {
    expect(gitState({ git: null, source: saved })).toBeNull();
    expect(gitState({ git: undefined, source: saved })).toBeNull();
  });

  it('names the working branch against the collaboration branch', () => {
    const p = gitState({ git, source: saved });
    expect(p).toMatchObject({ label: 'feature/x → main', tone: 'neutral' });
    expect(p?.detail).toMatch(
      /^Commits go to feature\/x; pull requests open into main\. Last fetched /,
    );
  });

  it('adds the commit the canvas version came from, and only when it has one', () => {
    const p = gitState({
      git,
      source: { version: 2, sourceCommit: 'abcdef1234567890', sourceBranch: 'main' },
    });
    expect(p?.label).toBe('feature/x → main · from abcdef1');
    expect(p?.detail).toContain('v2 was imported from commit abcdef1 on main.');
    expect(gitState({ git, source: null })?.label).toBe('feature/x → main');
  });

  it('says in words when the last fetch failed, and draws it as danger', () => {
    const p = gitState({
      git: { ...git, state: 'fetch_error', lastFetchError: 'could not resolve host' },
      source: saved,
    });
    expect(p).toMatchObject({ label: 'feature/x → main · fetch failed', tone: 'danger' });
    expect(p?.detail).toContain('The last fetch from the repo failed: could not resolve host');
  });

  it('says when the collaboration branch does not exist at the repo yet', () => {
    const p = gitState({ git: { ...git, state: 'collab_branch_missing' }, source: saved });
    expect(p).toMatchObject({ label: 'feature/x → main · no main yet', tone: 'warning' });
  });
});
