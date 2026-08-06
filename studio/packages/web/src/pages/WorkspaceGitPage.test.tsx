import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  WorkspaceGitCommitResult,
  WorkspaceGitDrift,
  WorkspaceGitStatus,
} from '@autonomy-studio/shared';
import { WorkspaceGitPage } from './WorkspaceGitPage';
import * as api from '../api/workspaceGit';

// Mock the NETWORK only. The body schemas re-exported by the same module stay
// real, so every client-side refusal below is the one that ships.
vi.mock('../api/workspaceGit', async (importActual) => {
  const actual = await importActual<typeof import('../api/workspaceGit')>();
  return {
    ...actual,
    getWorkspaceGit: vi.fn(),
    connectWorkspaceGit: vi.fn(),
    disconnectWorkspaceGit: vi.fn(),
    fetchWorkspaceGit: vi.fn(),
    setWorkspaceGitToken: vi.fn(),
    clearWorkspaceGitToken: vi.fn(),
    readWorkspaceGitDrift: vi.fn(),
    commitWorkspace: vi.fn(),
  };
});

const getMock = vi.mocked(api.getWorkspaceGit);
const connectMock = vi.mocked(api.connectWorkspaceGit);
const disconnectMock = vi.mocked(api.disconnectWorkspaceGit);
const fetchMock = vi.mocked(api.fetchWorkspaceGit);
const setTokenMock = vi.mocked(api.setWorkspaceGitToken);
const clearTokenMock = vi.mocked(api.clearWorkspaceGitToken);
const driftMock = vi.mocked(api.readWorkspaceGitDrift);
const commitMock = vi.mocked(api.commitWorkspace);

function status(overrides: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    id: 'wg_1',
    ownerId: 'local',
    repoUrl: 'https://github.com/acme/flows.git',
    collabBranch: 'main',
    workingBranch: 'studio/local/work',
    observedCollabHead: 'abcdef1234567890',
    importedFromCommit: null,
    lastFetchAt: 1_700_000_000_000,
    lastFetchError: null,
    createdAt: 1_699_000_000_000,
    updatedAt: 1_700_000_000_000,
    state: 'ready',
    hasStoredToken: false,
    ...overrides,
  };
}

function drift(overrides: Partial<WorkspaceGitDrift> = {}): WorkspaceGitDrift {
  return {
    base: 'aaaaaaa1111111',
    hasUncommittedChanges: true,
    changes: [],
    diagnostics: [],
    ...overrides,
  };
}

function commitResult(overrides: Partial<WorkspaceGitCommitResult> = {}): WorkspaceGitCommitResult {
  return {
    committed: true,
    branch: 'studio/local/work',
    commitSha: 'fedcba9876543210',
    files: ['pipelines/a.json'],
    ...overrides,
  };
}

/**
 * The value the fact list shows under a given term.
 *
 * Read by PAIRING rather than by searching the page for the text: a branch name
 * also appears in the commit hint, so a bare `getByText` both collides and
 * would pass even if the value were rendered under the wrong label.
 */
function fact(term: string): string {
  const dd = screen.getByText(term).nextElementSibling;
  if (dd === null || dd.tagName !== 'DD') throw new Error(`no value rendered for "${term}"`);
  return dd.textContent ?? '';
}

/** Mount already connected — the precondition for most of the acts below. */
async function renderConnected(overrides: Partial<WorkspaceGitStatus> = {}) {
  getMock.mockResolvedValue(status(overrides));
  render(<WorkspaceGitPage />);
  expect(await screen.findByRole('heading', { name: 'Connected' })).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkspaceGitPage', () => {
  it('offers the connect form when the workspace has no repo', async () => {
    getMock.mockResolvedValue(null);
    render(<WorkspaceGitPage />);

    expect(await screen.findByRole('form', { name: 'Connect a repository' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connected' })).toBeNull();
  });

  /**
   * The three-state guard. A FAILED read must not render the not-connected
   * surface — that would state an absent fact as "no repo" and invite the
   * operator to connect over a repo that may well exist (#473 shape).
   */
  it('shows a load failure WITHOUT presenting the workspace as unconnected', async () => {
    getMock.mockRejectedValue(new Error('service unavailable'));
    render(<WorkspaceGitPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('service unavailable');
    expect(screen.queryByRole('form', { name: 'Connect a repository' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Connected' })).toBeNull();
  });

  it('shows the recorded repo, branches and state when connected', async () => {
    await renderConnected();

    expect(fact('Repository')).toBe('https://github.com/acme/flows.git');
    expect(fact('Collaboration branch')).toBe('main');
    expect(fact('Working branch')).toBe('studio/local/work');
    expect(fact('State')).toBe('Ready');
    // Shas are shown at review length, not raw.
    expect(fact('Collaboration branch head')).toBe('abcdef1');
    // An absent fact reads as absent, never as a plausible-looking value.
    expect(fact('Imported from')).toBe('—');
  });

  it('names the missing collaboration branch rather than reporting ready', async () => {
    await renderConnected({ state: 'collab_branch_missing', observedCollabHead: null });

    expect(fact('State')).toMatch(/does not exist at the remote yet/);
    expect(fact('State')).not.toBe('Ready');
  });

  it('surfaces the recorded reason for a failed fetch', async () => {
    await renderConnected({ state: 'fetch_error', lastFetchError: 'host unreachable' });

    expect(fact('State')).toBe('Last check failed: host unreachable');
  });

  it('omits a blank collaboration branch so the shared default applies', async () => {
    getMock.mockResolvedValue(null);
    connectMock.mockResolvedValue(status());
    render(<WorkspaceGitPage />);
    await screen.findByRole('form', { name: 'Connect a repository' });

    await userEvent.type(screen.getByLabelText('Repository'), '/srv/repos/flows.git');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(1));
    // The schema's own `.default('main')` fills it — the page never re-types it.
    expect(connectMock).toHaveBeenCalledWith({
      repoUrl: '/srv/repos/flows.git',
      collabBranch: 'main',
    });
  });

  it('sends an explicit collaboration branch when one is given', async () => {
    getMock.mockResolvedValue(null);
    connectMock.mockResolvedValue(status({ collabBranch: 'trunk' }));
    render(<WorkspaceGitPage />);
    await screen.findByRole('form', { name: 'Connect a repository' });

    await userEvent.type(screen.getByLabelText('Repository'), '/srv/repos/flows.git');
    await userEvent.type(screen.getByLabelText('Collaboration branch'), 'trunk');
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(connectMock).toHaveBeenCalledWith({
        repoUrl: '/srv/repos/flows.git',
        collabBranch: 'trunk',
      }),
    );
  });

  /**
   * The refusal is the SHARED schema's, evaluated client-side: the same rule
   * the server would apply, so the operator is not told to try again by a
   * round trip.
   */
  it('refuses a credential-bearing repo URL without calling the API', async () => {
    getMock.mockResolvedValue(null);
    render(<WorkspaceGitPage />);
    await screen.findByRole('form', { name: 'Connect a repository' });

    await userEvent.type(
      screen.getByLabelText('Repository'),
      'https://user:tok@github.com/acme/flows.git',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/must not embed a credential/);
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('re-observes the remote on Refresh and shows the new reading', async () => {
    await renderConnected();
    fetchMock.mockResolvedValue(status({ state: 'fetch_error', lastFetchError: 'host unreachable' }));

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(/Last check failed: host unreachable/)).toBeInTheDocument();
  });

  it('disconnects only after the confirmation is accepted', async () => {
    await renderConnected();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(disconnectMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    disconnectMock.mockResolvedValue();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByRole('form', { name: 'Connect a repository' })).toBeInTheDocument();
  });

  describe('token', () => {
    it('never offers to clear a token that is not stored', async () => {
      await renderConnected({ hasStoredToken: false });

      expect(screen.queryByRole('button', { name: 'Remove stored token' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Store token' })).toBeInTheDocument();
    });

    it('offers replacement and removal once one is stored, and never shows it', async () => {
      await renderConnected({ hasStoredToken: true });

      expect(screen.getByRole('button', { name: 'Replace token' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove stored token' })).toBeInTheDocument();
      // Write-only: nothing is prefilled, because nothing is ever returned.
      expect(screen.getByLabelText('Token')).toHaveValue('');
    });

    /**
     * Blank submit is a REFUSAL, not a clear. Deleting a credential because a
     * field happened to be empty is unrecoverable and unasked-for; removal has
     * its own button and its own confirmation.
     */
    it('refuses a blank token instead of treating it as a removal', async () => {
      await renderConnected({ hasStoredToken: true });

      await userEvent.click(screen.getByRole('button', { name: 'Replace token' }));

      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(setTokenMock).not.toHaveBeenCalled();
      expect(clearTokenMock).not.toHaveBeenCalled();
    });

    it('stores a token and clears the field afterwards', async () => {
      await renderConnected({ hasStoredToken: false });
      setTokenMock.mockResolvedValue(status({ hasStoredToken: true }));

      await userEvent.type(screen.getByLabelText('Token'), 'ghp_secret');
      await userEvent.click(screen.getByRole('button', { name: 'Store token' }));

      await waitFor(() => expect(setTokenMock).toHaveBeenCalledWith({ token: 'ghp_secret' }));
      await waitFor(() => expect(screen.getByLabelText('Token')).toHaveValue(''));
      expect(await screen.findByRole('button', { name: 'Replace token' })).toBeInTheDocument();
    });

    it('removes a stored token only after confirmation', async () => {
      await renderConnected({ hasStoredToken: true });
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      clearTokenMock.mockResolvedValue(status({ hasStoredToken: false }));

      await userEvent.click(screen.getByRole('button', { name: 'Remove stored token' }));

      await waitFor(() => expect(clearTokenMock).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole('button', { name: 'Store token' })).toBeInTheDocument();
    });
  });

  describe('drift and commit', () => {
    it('says so plainly when nothing is uncommitted', async () => {
      await renderConnected();
      driftMock.mockResolvedValue(drift({ hasUncommittedChanges: false }));

      await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));

      expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument();
    });

    it('lists each drifted resource with its change', async () => {
      await renderConnected();
      driftMock.mockResolvedValue(
        drift({
          changes: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              name: 'Nightly',
              change: 'modified',
            },
          ],
        }),
      );

      await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));

      const row = within(await screen.findByRole('table')).getByRole('row', { name: /Nightly/ });
      expect(within(row).getByText('modified')).toBeInTheDocument();
      expect(within(row).getByText('pipelines/nightly.json')).toBeInTheDocument();
    });

    /**
     * A committed file that would not parse is EXCLUDED from `changes` rather
     * than manufactured as a match, so if the page did not render diagnostics
     * the operator would see "changes pending" over an empty table with no
     * explanation anywhere.
     */
    it('shows the files it could not read', async () => {
      await renderConnected();
      driftMock.mockResolvedValue(
        drift({
          diagnostics: [{ path: 'pipelines/broken.json', message: 'not valid JSON' }],
        }),
      );

      await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));

      expect(await screen.findByText('pipelines/broken.json')).toBeInTheDocument();
      expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    });

    it('refuses a blank commit message without calling the API', async () => {
      await renderConnected();

      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      expect(commitMock).not.toHaveBeenCalled();
    });

    it('reports a commit with its sha, branch and file count', async () => {
      await renderConnected();
      commitMock.mockResolvedValue(commitResult());

      await userEvent.type(screen.getByLabelText('Message'), 'nightly tweak');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      await waitFor(() => expect(commitMock).toHaveBeenCalledWith({ message: 'nightly tweak' }));
      const note = await screen.findByRole('status');
      expect(note).toHaveTextContent('Committed fedcba9 to studio/local/work — 1 file.');
    });

    /**
     * `committed: false` is a success meaning "the branch already matches".
     * Rendering it as a commit would invent a commit that does not exist —
     * the operator would believe their work was pushed.
     */
    it('does NOT claim a commit when nothing needed committing', async () => {
      await renderConnected();
      commitMock.mockResolvedValue(commitResult({ committed: false, commitSha: null, files: [] }));

      await userEvent.type(screen.getByLabelText('Message'), 'no-op');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      const note = await screen.findByRole('status');
      expect(note).toHaveTextContent(/Nothing to commit/);
      expect(note).not.toHaveTextContent(/^Committed/);
    });

    it('clears a stale drift report once a commit lands', async () => {
      await renderConnected();
      driftMock.mockResolvedValue(
        drift({
          changes: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              name: 'Nightly',
              change: 'modified',
            },
          ],
        }),
      );
      commitMock.mockResolvedValue(commitResult());

      await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));
      expect(await screen.findByRole('table')).toBeInTheDocument();

      await userEvent.type(screen.getByLabelText('Message'), 'ship it');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    });

    it('surfaces a rejected push instead of reporting success', async () => {
      await renderConnected();
      commitMock.mockRejectedValue(new Error('push rejected: not a fast-forward'));

      await userEvent.type(screen.getByLabelText('Message'), 'racy');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not a fast-forward/);
      expect(screen.queryByRole('status')).toBeNull();
    });
  });
});
