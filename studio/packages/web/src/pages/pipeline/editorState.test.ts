import { describe, expect, it } from 'vitest';
import type { WorkspaceGitStatus, WorkspaceGitSync } from '@autonomy-studio/shared';
import {
  canvasVersion,
  editingState,
  gitState,
  listRowBadge,
  liveState,
  liveStateKeys,
  partText,
  type EditingInput,
} from './editorState';

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
    expect(gitState({ zone: 'UTC', git: null, source: saved })).toBeNull();
    expect(gitState({ zone: 'UTC', git: undefined, source: saved })).toBeNull();
  });

  it('says when the repo has never been fetched, rather than printing a dash', () => {
    expect(
      gitState({ zone: 'UTC', git: { ...git, lastFetchAt: null }, source: saved })?.detail,
    ).toContain('Never fetched.');
  });

  it('names the working branch against the collaboration branch', () => {
    const p = gitState({ zone: 'UTC', git, source: saved });
    expect(p).toMatchObject({ name: 'feature/x → main', label: '', tone: 'neutral' });
    expect(partText(p!)).toBe('feature/x → main');
    expect(p?.detail).toMatch(
      /^Commits go to feature\/x; pull requests open into main\. Last fetched /,
    );
  });

  it('links the open pull request from the working branch, beside the label', () => {
    const p = gitState({
      zone: 'UTC',
      git,
      source: saved,
      pullRequest: {
        state: 'open',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        checkedAt: 1,
      },
    });
    expect(p?.link).toEqual({
      label: 'PR #7',
      name: 'PR #7 (pull request)',
      href: 'https://github.com/acme/widgets/pull/7',
    });
    // Not in the label: the link is drawn after it, so it is never said twice.
    expect(p?.label).toBe('');
    expect(p?.detail).toMatch(/Pull request #7 is open from feature\/x \(checked .+\)\./);
    expect(p?.tone).toBe('neutral');

    // A reading for the branch this workspace was on before: not this one's.
    const moved = gitState({
      zone: 'UTC',
      git: { ...git, workingBranch: 'feature/y' },
      source: saved,
      pullRequest: {
        state: 'open',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        checkedAt: 1,
      },
    });
    expect(moved?.link).toBeUndefined();
    expect(moved?.detail).not.toContain('Pull request #7');

    // And one for another repo, though the branch name is the same.
    const reconnected = gitState({
      zone: 'UTC',
      git: { ...git, repoUrl: 'file:///tmp/other.git' },
      source: saved,
      pullRequest: {
        state: 'open',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        checkedAt: 1,
      },
    });
    expect(reconnected?.link).toBeUndefined();
  });

  it('says there is no pull request only when the host said so', () => {
    const none = gitState({
      zone: 'UTC',
      git,
      source: saved,
      pullRequest: {
        state: 'none',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        checkedAt: 1,
      },
    });
    expect(none?.link).toBeUndefined();
    expect(none?.detail).toMatch(/No pull request is open from feature\/x \(checked .+\)\./);

    const failed = gitState({
      zone: 'UTC',
      git,
      source: saved,
      pullRequest: {
        state: 'unknown',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        reason: 'lookup_failed',
        detail: 'HTTP 502',
      },
    });
    expect(failed?.link).toBeUndefined();
    expect(failed?.detail).not.toContain('No pull request');
    expect(failed?.detail).toContain('Could not check for a pull request: HTTP 502.');
    expect(failed?.tone).toBe('neutral');

    const noToken = gitState({
      zone: 'UTC',
      git,
      source: saved,
      pullRequest: {
        state: 'unknown',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        reason: 'no_token',
        detail: null,
      },
    });
    expect(noToken?.detail).toContain('Pull requests are not checked: no GitHub token is set.');

    // A local or non-GitHub remote has no pull requests studio can see: nothing said.
    const local = gitState({
      zone: 'UTC',
      git,
      source: saved,
      pullRequest: {
        state: 'unknown',
        repoUrl: 'file:///tmp/repo.git',
        workingBranch: 'feature/x',
        reason: 'unsupported_host',
        detail: null,
      },
    });
    expect(local?.detail).toBe(gitState({ zone: 'UTC', git, source: saved })?.detail);
  });

  it('adds the commit the canvas version came from, and only when it has one', () => {
    const p = gitState({
      zone: 'UTC',
      git,
      source: { version: 2, sourceCommit: 'abcdef1234567890', sourceBranch: 'main' },
    });
    expect(partText(p!)).toBe('feature/x → main · from abcdef1');
    expect(p?.detail).toContain('v2 was imported from commit abcdef1 on main.');
    expect(gitState({ zone: 'UTC', git, source: null })?.label).toBe('');
  });

  it('says in words when the last fetch failed, and draws it as danger', () => {
    const p = gitState({
      zone: 'UTC',
      git: { ...git, state: 'fetch_error', lastFetchError: 'could not resolve host' },
      source: saved,
    });
    // The state is the LABEL, not part of the name, so a long branch name can
    // be cut short without cutting the words that carry the state.
    expect(p).toMatchObject({ name: 'feature/x → main', label: 'fetch failed', tone: 'danger' });
    expect(p?.detail).toContain(
      'The last fetch from the repo failed: could not resolve host. Last',
    );
  });

  it('says when the collaboration branch does not exist at the repo yet', () => {
    const p = gitState({
      zone: 'UTC',
      git: { ...git, state: 'collab_branch_missing' },
      source: saved,
    });
    expect(p).toMatchObject({ label: 'no main yet', tone: 'warning' });
  });

  describe('with a sync reading (#1476 slice 6)', () => {
    const base = 'b45e000000000000000000000000000000000000';
    const sync = (over: Partial<WorkspaceGitSync> = {}): WorkspaceGitSync => ({
      fetchedAt: 2,
      fetched: false,
      workingBranch: 'feature/x',
      base,
      baseBranch: 'feature/x',
      hasUncommittedChanges: false,
      pipelines: [],
      divergence: { state: 'current', importBase: base, collabHead: base },
      ...over,
    });
    const read = (s: WorkspaceGitSync | null | undefined, g: WorkspaceGitStatus = git) =>
      gitState({ zone: 'UTC', git: g, source: saved, sync: s, pipelineId: 'p1' });

    it('says in sync when this pipeline matches the branch and main has not moved', () => {
      const p = read(sync());
      expect(p).toMatchObject({ label: 'in sync', tone: 'neutral' });
      expect(p?.detail).toContain(
        'This pipeline matches feature/x at b45e000. Up to date with main.',
      );
      expect(p?.detail).toContain('Compared with the repo as fetched');
      expect(p?.detail).not.toContain('Other resources');
    });

    it('says committed, not in sync, when main was never imported to compare', () => {
      const p = read(
        sync({ divergence: { state: 'unknown', importBase: null, collabHead: base } }),
      );
      expect(p).toMatchObject({ label: 'committed', tone: 'neutral' });
      expect(p?.detail).toContain('This workspace has never imported from main');
    });

    it('names main, not the working branch, before the working branch exists', () => {
      const p = read(sync({ baseBranch: 'main' }));
      expect(p?.detail).toContain(
        'This pipeline matches main at b45e000; feature/x has not been created yet.',
      );
      const added = read(
        sync({ baseBranch: 'main', pipelines: [{ pipelineId: 'p1', change: 'added' }] }),
      );
      expect(added?.detail).toContain('This pipeline is not on main yet.');
    });

    it('says when other resources are uncommitted though this pipeline is not', () => {
      const p = read(sync({ hasUncommittedChanges: true }));
      expect(p?.label).toBe('in sync');
      expect(p?.detail).toContain('Other resources in this workspace are uncommitted.');
    });

    it('marks only THIS pipeline uncommitted, in amber, and says why', () => {
      const other = read(sync({ pipelines: [{ pipelineId: 'p2', change: 'added' }] }));
      expect(other?.label).toBe('in sync');
      const p = read(sync({ pipelines: [{ pipelineId: 'p1', change: 'removed' }] }));
      expect(p).toMatchObject({ label: 'uncommitted', tone: 'warning' });
      expect(p?.detail).toContain('It is archived here but still on feature/x.');
    });

    it('says behind main — pull first, with both commits', () => {
      const head = 'ead0000000000000000000000000000000000000';
      const p = read(sync({ divergence: { state: 'behind', importBase: base, collabHead: head } }));
      expect(p).toMatchObject({ label: 'behind main — pull first', tone: 'warning' });
      expect(p?.detail).toContain(
        'main has moved on since this workspace last imported. Importing brings it up to date. Imported from b45e000; it is now at ead0000.',
      );
    });

    it('draws diverged as danger, and danger wins over an amber uncommitted', () => {
      const p = read(
        sync({
          pipelines: [{ pipelineId: 'p1', change: 'modified' }],
          divergence: { state: 'diverged', importBase: base, collabHead: 'f00' },
        }),
      );
      expect(p).toMatchObject({ label: 'uncommitted · diverged', tone: 'danger' });
    });

    it('claims nothing without a reading, or when the fetch failed', () => {
      expect(read(undefined)?.label).toBe('');
      expect(read(null)?.label).toBe('');
      const failed = read(sync({ pipelines: [{ pipelineId: 'p1', change: 'added' }] }), {
        ...git,
        state: 'fetch_error',
        lastFetchError: 'boom',
      });
      expect(failed?.label).toBe('fetch failed');
    });
  });
});

describe('listRowBadge (#1476 slice 8)', () => {
  const sha = 'abc1234000000000000000000000000000000000';
  const sync = (over: Partial<WorkspaceGitSync> = {}): WorkspaceGitSync => ({
    fetchedAt: 2,
    fetched: false,
    workingBranch: 'feature/x',
    base: sha,
    baseBranch: 'feature/x',
    hasUncommittedChanges: false,
    pipelines: [],
    divergence: { state: 'current', importBase: sha, collabHead: sha },
    ...over,
  });
  // `gitConnected` is read with `in`, not a default: `undefined` is a case.
  const row = (
    latestVersion: number | null,
    active: { versionId: string; version: number | null } | null,
    over: { gitConnected?: boolean | undefined; sync?: WorkspaceGitSync | null } = {},
  ) =>
    listRowBadge({
      state: { pipelineId: 'p1', latestVersion, active },
      gitConnected: 'gitConnected' in over ? over.gitConnected : true,
      sync: over.sync,
    });

  it('says Not saved, or Saved where no live part says more — never a version number', () => {
    expect(row(null, null).editing).toMatchObject({ label: 'Not saved', tone: 'neutral' });
    // DB-only: no live part, so the row says the head is saved; the number is
    // the hover detail's (#1569).
    expect(row(3, null, { gitConnected: false }).editing).toEqual({
      ...editingState(base),
      label: 'Saved',
    });
    // Git mode: the live part carries the state, so the editing part is gone.
    expect(row(3, null).editing).toBeNull();
    expect(row(3, { versionId: 'v3', version: 3 }).editing).toBeNull();
  });

  it('is green with ✓ when live IS the latest saved version, in list words', () => {
    expect(row(2, { versionId: 'v2', version: 2 }).live).toEqual({
      label: 'Live',
      detail: 'v2 is the active (published) version, and is the latest saved version.',
      tone: 'success',
      current: true,
    });
  });

  it('is amber when live is behind the latest saved version, and says which', () => {
    const live = row(3, { versionId: 'v1', version: 1 }).live;
    expect(live).toMatchObject({ label: 'Live (behind)', tone: 'warning' });
    expect(live?.current).toBeUndefined();
    expect(live?.detail).toBe(
      'v1 is the active (published) version; the latest saved version is v3.',
    );
    expect(row(null, { versionId: 'v1', version: 1 }).live?.detail).toBe(
      'v1 is the active (published) version; there is no saved version.',
    );
  });

  it('says Not published, or not listed, rather than a number it does not have', () => {
    expect(row(2, null).live).toMatchObject({ label: 'Not published', tone: 'warning' });
    expect(row(null, null).live).toMatchObject({ label: 'Not published' });
    expect(row(2, { versionId: 'vx', version: null }).live).toMatchObject({
      label: 'Live: not listed yet',
      tone: 'warning',
    });
  });

  it('has no live part outside git mode, or while that is unread', () => {
    for (const connected of [false, undefined]) {
      expect(row(2, null, { gitConnected: connected }).live).toBeNull();
      expect(row(2, { versionId: 'v2', version: 2 }, { gitConnected: connected }).live).toBeNull();
    }
  });

  it('says uncommitted only for a pipeline the sync reading lists', () => {
    const listed = sync({ pipelines: [{ pipelineId: 'p1', change: 'modified' }] });
    expect(row(2, null, { sync: listed }).git).toEqual({
      label: 'uncommitted',
      detail: 'Its latest saved version differs from feature/x.',
      tone: 'warning',
    });
    // Before the working branch exists, it was compared with main.
    expect(row(2, null, { sync: sync({ ...listed, baseBranch: 'main' }) }).git?.detail).toBe(
      'Its latest saved version differs from main.',
    );
    // A clean row, another pipeline listed, no reading, a failed fetch: nothing.
    expect(row(2, null, { sync: sync() }).git).toBeNull();
    expect(
      row(2, null, { sync: sync({ pipelines: [{ pipelineId: 'p2', change: 'added' }] }) }).git,
    ).toBeNull();
    expect(row(2, null, { sync: undefined }).git).toBeNull();
    expect(row(2, null, { sync: null }).git).toBeNull();
    expect(row(2, null, { gitConnected: false, sync: listed }).git).toBeNull();
  });
});

describe('liveStateKeys (#1569 OR37 slice 2)', () => {
  const sha = 'abc1234000000000000000000000000000000000';
  const drifted: WorkspaceGitSync = {
    fetchedAt: 2,
    fetched: false,
    workingBranch: 'feature/x',
    base: sha,
    baseBranch: 'feature/x',
    hasUncommittedChanges: true,
    pipelines: [{ pipelineId: 'p1', change: 'modified' }],
    divergence: { state: 'current', importBase: sha, collabHead: sha },
  };
  const input = (
    latestVersion: number | null,
    active: { versionId: string; version: number | null } | null,
    gitConnected: boolean | undefined,
    sync?: WorkspaceGitSync | null,
  ) => ({ state: { pipelineId: 'p1', latestVersion, active }, gitConnected, sync });

  it.each([
    // DB-only: no live part, whatever the publish pointer says.
    [input(null, null, false), ['unsaved']],
    [input(3, null, false), ['saved']],
    [input(3, { versionId: 'v3', version: 3 }, false), ['saved']],
    // Publish state unread: no live part, so nothing about live is claimed.
    [input(3, { versionId: 'v1', version: 1 }, undefined), ['saved']],
    // Git mode.
    [input(3, null, true), ['unpublished']],
    [input(null, null, true), ['unsaved', 'unpublished']],
    [input(2, { versionId: 'v2', version: 2 }, true), ['live']],
    [input(3, { versionId: 'v1', version: 1 }, true), ['live', 'behind']],
    // "Not listed yet" is live, not behind; no saved head is nothing to be behind.
    [input(3, { versionId: 'vx', version: null }, true), ['live']],
    [input(null, { versionId: 'v1', version: 1 }, true), ['unsaved', 'live']],
    [input(2, { versionId: 'v2', version: 2 }, true, drifted), ['live', 'uncommitted']],
  ] as const)('%#: the keys the badge implies', (row, keys) => {
    expect(liveStateKeys(row)).toEqual(keys);
  });

  it('agrees with the badge it is derived from, label for label', () => {
    const rows = [
      input(null, null, false),
      input(3, null, false),
      input(3, null, true),
      input(null, null, true),
      input(2, { versionId: 'v2', version: 2 }, true),
      input(3, { versionId: 'v1', version: 1 }, true),
      input(3, { versionId: 'vx', version: null }, true),
      input(null, { versionId: 'v1', version: 1 }, true, drifted),
    ];
    for (const r of rows) {
      const keys = liveStateKeys(r);
      const { editing, live, git } = listRowBadge(r);
      expect(keys.includes('unsaved'), JSON.stringify(r)).toBe(editing?.label === 'Not saved');
      expect(keys.includes('saved'), JSON.stringify(r)).toBe(editing?.label === 'Saved');
      expect(keys.includes('unpublished'), JSON.stringify(r)).toBe(live?.label === 'Not published');
      expect(keys.includes('behind'), JSON.stringify(r)).toBe(live?.label === 'Live (behind)');
      expect(keys.includes('uncommitted'), JSON.stringify(r)).toBe(git !== null);
    }
  });
});
