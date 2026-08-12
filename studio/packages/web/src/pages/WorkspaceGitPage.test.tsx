import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  WorkspaceGitApplyResult,
  WorkspaceGitCommitResult,
  WorkspaceGitDivergence,
  WorkspaceGitDrift,
  WorkspaceGitImportPreview,
  WorkspaceGitStatus,
} from '@autonomy-studio/shared';
import { WorkspaceGitPage } from './WorkspaceGitPage';
import { ApiError } from '../api/client';
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
    readWorkspaceGitDivergence: vi.fn(),
    previewWorkspaceGitImport: vi.fn(),
    importWorkspaceGit: vi.fn(),
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
const divergenceMock = vi.mocked(api.readWorkspaceGitDivergence);
const previewMock = vi.mocked(api.previewWorkspaceGitImport);
const importMock = vi.mocked(api.importWorkspaceGit);

/** The collab head `status()` reports as observed — a preview at this sha is CURRENT. */
const HEAD = 'abcdef1234567890';

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

function divergence(overrides: Partial<WorkspaceGitDivergence> = {}): WorkspaceGitDivergence {
  return { state: 'behind', importBase: '1111111222222', collabHead: HEAD, ...overrides };
}

function preview(overrides: Partial<WorkspaceGitImportPreview> = {}): WorkspaceGitImportPreview {
  return { head: HEAD, resources: [], archive: [], diagnostics: [], ...overrides };
}

function previewResource(
  overrides: Partial<WorkspaceGitImportPreview['resources'][number]> = {},
): WorkspaceGitImportPreview['resources'][number] {
  return {
    path: 'pipelines/nightly.json',
    kind: 'pipeline',
    resourceId: 'res_1',
    name: 'Nightly',
    disposition: 'update',
    nameChanged: false,
    contentChanged: true,
    versionContentUnverified: false,
    ...overrides,
  };
}

function applyResult(overrides: Partial<WorkspaceGitApplyResult> = {}): WorkspaceGitApplyResult {
  return {
    head: HEAD,
    refused: false,
    applied: [],
    deferred: [],
    archived: [],
    diagnostics: [],
    ...overrides,
  };
}

/**
 * Read a check for incoming to completion.
 *
 * The two reads are SEQUENTIAL in the component, so the assertion has to wait
 * for the second — a test that clicked and asserted immediately would be racing
 * the preview and would pass or fail on scheduling.
 */
async function checkForIncoming(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Check for incoming' }));
  await waitFor(() => expect(previewMock).toHaveBeenCalled());
}

/** The import surface's own region — every other section has a table too. */
function incoming(): HTMLElement {
  return screen.getByLabelText('Incoming changes');
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
    fetchMock.mockResolvedValue(
      status({ state: 'fetch_error', lastFetchError: 'host unreachable' }),
    );

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

  /**
   * One act at a time, across the WHOLE page.
   *
   * The race this closes: start a token write, then disconnect before it
   * resolves. Disconnect lands first and the page correctly shows the connect
   * form — then the token response arrives carrying a CONNECTED status and
   * writes it back, resurrecting a workspace the server no longer has. Because
   * the sections are separate components, a per-section busy flag cannot see
   * the other section's request at all.
   */
  it('locks every other act while one is in flight', async () => {
    await renderConnected({ hasStoredToken: false });
    // Never resolves: the act stays in flight for the whole assertion.
    setTokenMock.mockReturnValue(new Promise(() => {}));

    await userEvent.type(screen.getByLabelText('Token'), 'ghp_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Store token' }));

    // Asserted over EVERY button rather than by name: a busy control relabels
    // itself ("Refresh" → "Working…"), so naming them would test the labels.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled());
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(3);
    for (const button of buttons) expect(button).toBeDisabled();
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
      // #964 — prose, not the raw wire enum, and prose in the COMMIT direction:
      // a drift `modified` is this workspace's edit on its way out.
      expect(within(row).getByText('content differs')).toBeInTheDocument();
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
          diagnostics: [
            { path: 'pipelines/broken.json', code: 'unparseable', message: 'not valid JSON' },
          ],
        }),
      );

      await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));

      expect(await screen.findByText('pipelines/broken.json')).toBeInTheDocument();
      expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    });

    /**
     * The server re-observes the remote BEFORE doing the work, so a failed
     * check has still rewritten `state`/`lastFetchAt`/`lastFetchError` — and
     * that is precisely when the recorded reason is worth showing. Re-reading
     * only on success leaves the panel asserting a pre-failure "Ready" right
     * next to the failure.
     */
    it('re-reads the status after a FAILED check, not just a successful one', async () => {
      await renderConnected();
      getMock.mockClear();
      getMock.mockResolvedValue(
        status({ state: 'fetch_error', lastFetchError: 'host unreachable' }),
      );
      driftMock.mockRejectedValue(new Error('could not reach the remote'));

      await userEvent.click(screen.getByRole('button', { name: 'Check for changes' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach the remote/);
      await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
      expect(fact('State')).toBe('Last check failed: host unreachable');
    });

    it('re-reads the status after a FAILED commit too', async () => {
      await renderConnected();
      getMock.mockClear();
      getMock.mockResolvedValue(
        status({ state: 'fetch_error', lastFetchError: 'host unreachable' }),
      );
      commitMock.mockRejectedValue(new Error('push rejected'));

      await userEvent.type(screen.getByLabelText('Message'), 'nope');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/push rejected/);
      await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
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

    /**
     * The notice belongs to the attempt that produced it.
     *
     * This has to commit SUCCESSFULLY first: the "rejected push" test below
     * starts from no notice at all, so its `queryByRole('status')` assertion
     * passes trivially and cannot see a stale one. The failure mode is a
     * second attempt failing while the FIRST attempt's "Committed <sha>" line
     * is still on screen — which reads as confirmation the failed attempt was
     * pushed.
     */
    it('does not leave a previous success on screen when a later commit fails', async () => {
      await renderConnected();
      commitMock.mockResolvedValue(commitResult());

      await userEvent.type(screen.getByLabelText('Message'), 'first');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Committed fedcba9');

      commitMock.mockRejectedValue(new Error('push rejected: not a fast-forward'));
      await userEvent.type(screen.getByLabelText('Message'), 'second');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not a fast-forward/);
      expect(screen.queryByRole('status')).toBeNull();
    });

    /**
     * The server's 409 message says to "fetch/import the latest changes", and
     * import is deferred out of this slice — so passing it through unqualified
     * would send the operator hunting for a control that is not on the page.
     */
    it('qualifies a push conflict with a remedy this page can actually offer', async () => {
      await renderConnected();
      commitMock.mockRejectedValue(
        new ApiError(409, 'push rejected: the remote has moved — fetch/import and re-commit.'),
      );

      await userEvent.type(screen.getByLabelText('Message'), 'racy');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/push rejected/);
      // Slice 2 turned the apology into a pointer: the remedy the server's own
      // message names is now a control on this page.
      expect(alert).toHaveTextContent(/Check for incoming/);
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

  describe('incoming (divergence, preview and import)', () => {
    it('reads divergence AND the preview from one check', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ state: 'behind' }));
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));

      await checkForIncoming();

      expect(divergenceMock).toHaveBeenCalledTimes(1);
      expect(previewMock).toHaveBeenCalledTimes(1);
      expect(incoming()).toHaveTextContent(/main has moved on/);
      expect(within(incoming()).getByRole('row', { name: /Nightly/ })).toHaveTextContent(
        'content differs',
      );
    });

    /**
     * `unknown` is TWO different facts wearing one enum value, and the server
     * hands back both shas precisely so the client can tell them apart. A single
     * string would be false for whichever case it was not written for.
     */
    it('says a null import base means this workspace has never imported', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(
        divergence({ state: 'unknown', importBase: null, collabHead: HEAD }),
      );
      previewMock.mockResolvedValue(preview());

      await checkForIncoming();

      expect(incoming()).toHaveTextContent(/never imported from main/);
      expect(incoming()).not.toHaveTextContent(/Up to date/);
    });

    it('says a null collab head means the branch is empty or gone, not that nothing was imported', async () => {
      await renderConnected({ observedCollabHead: null });
      divergenceMock.mockResolvedValue(
        divergence({ state: 'unknown', importBase: '1111111222222', collabHead: null }),
      );
      previewMock.mockResolvedValue(preview({ head: null }));

      await checkForIncoming();

      expect(incoming()).toHaveTextContent(
        /main has no commits at the remote, or no longer exists/,
      );
      expect(incoming()).not.toHaveTextContent(/never imported/);
    });

    it('warns that a diverged branch replaces local resources', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ state: 'diverged' }));
      previewMock.mockResolvedValue(preview());

      await checkForIncoming();

      expect(incoming()).toHaveTextContent(/history was rewritten/);
    });

    /**
     * A pruned import base comes back as a 502 from `/divergence`. Leaving the
     * previous "Up to date" beside that error would render a FAILED check as a
     * clean one — the #473 shape, in the one place where the manufactured fact
     * talks the operator out of an import they need.
     */
    it('clears the previous reading when a later check fails', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ state: 'current' }));
      previewMock.mockResolvedValue(preview());

      await checkForIncoming();
      expect(incoming()).toHaveTextContent(/Up to date with main/);

      divergenceMock.mockRejectedValue(new Error('import base 1111111 is not in the repository'));
      await userEvent.click(screen.getByRole('button', { name: 'Check for incoming' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/not in the repository/);
      expect(screen.queryByLabelText('Incoming changes')).toBeNull();
    });

    it('offers no Import at all until a check has been made', async () => {
      await renderConnected();

      expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    });

    it('refuses to import an empty branch, which would report a success that did nothing', async () => {
      await renderConnected({ observedCollabHead: null });
      divergenceMock.mockResolvedValue(divergence({ collabHead: null, state: 'unknown' }));
      previewMock.mockResolvedValue(preview({ head: null }));

      await checkForIncoming();

      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
      expect(screen.getByText(/nothing on the branch to import/)).toBeInTheDocument();
    });

    it('refuses to import while a file on the branch cannot be read', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({
          diagnostics: [
            { path: 'pipelines/broken.json', code: 'unparseable', message: 'unexpected token' },
          ],
        }),
      );

      await checkForIncoming();

      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
      expect(incoming()).toHaveTextContent(/an import refuses outright and changes nothing/);
    });

    /**
     * The branch moving between the preview and the import is a gap no control
     * can close — `/import` takes no expected-head token. So the UI's job is to
     * stop offering a reading it can already see is stale.
     */
    it('refuses to import a preview the branch has already moved past', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ collabHead: 'deadbeef00000000' }));
      previewMock.mockResolvedValue(preview({ head: 'deadbeef00000000' }));

      await checkForIncoming();

      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
      expect(screen.getByText(/out of date — check again/)).toBeInTheDocument();
    });

    it('refuses to import when the two halves of one check saw different commits', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ collabHead: HEAD }));
      previewMock.mockResolvedValue(preview({ head: 'deadbeef00000000' }));

      await checkForIncoming();

      expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        /moved while it was being checked/,
      );
    });

    /**
     * The widest-blast-radius consequence on the page, and the one nobody
     * clicked for: a pipeline missing from the branch is archived and its
     * triggers are switched off.
     */
    it('names the pipelines an import would archive, in the confirmation', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({
          archive: [
            {
              path: 'pipelines/legacy.json',
              kind: 'pipeline',
              resourceId: 'res_9',
              name: 'Legacy',
            },
          ],
        }),
      );
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

      await checkForIncoming();
      expect(incoming()).toHaveTextContent(/Legacy/);

      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      const message = confirm.mock.calls[0]?.[0] as string;
      expect(message).toContain('Legacy');
      expect(message).toMatch(/ARCHIVED/);
      expect(message).toMatch(/trigger depending on them will be disabled/);
      // The preview is not a promise — the branch is re-read on import.
      expect(message).toMatch(/re-read now/);
      expect(importMock).not.toHaveBeenCalled();
    });

    /**
     * The confirmation counts the way the OUTCOME counts. Stating the whole
     * branch's resource count would overstate the blast radius at exactly the
     * moment the operator is deciding, and would then be contradicted by the
     * "N resources changed" line that follows.
     */
    it('counts only the differing resources in the confirmation, not the whole branch', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({
          resources: [
            previewResource({ path: 'a.json', disposition: 'update' }),
            previewResource({ path: 'b.json', disposition: 'unchanged' }),
            previewResource({ path: 'c.json', disposition: 'unchanged' }),
          ],
        }),
      );
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(confirm.mock.calls[0]?.[0]).toMatch(/1 resource on the branch differs from/);
    });

    /**
     * The count and its verb have to agree, because the singular case is the
     * common one — one edited pipeline is the ordinary import — and "1 resource
     * differ" is the sentence the operator reads most often.
     */
    it('agrees the verb with the count in the confirmation', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({
          resources: [
            previewResource({ path: 'a.json', disposition: 'update' }),
            previewResource({ path: 'b.json', disposition: 'create' }),
          ],
        }),
      );
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(confirm.mock.calls[0]?.[0]).toMatch(/2 resources on the branch differ from/);
    });

    /**
     * #983 — the pull-direction twin of the `superseded` roll-up rule above. The
     * count was a bare `!== 'unchanged'`, so a branch pinned to versions this
     * workspace already holds would have been confirmed as "3 resources will be
     * applied" and then reported as an import that wrote nothing.
     */
    it('does not count a SUPERSEDED resource as a pending change in the confirmation', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({
          resources: [
            previewResource({ path: 'a.json', disposition: 'update' }),
            previewResource({ path: 'b.json', disposition: 'superseded' }),
            previewResource({ path: 'c.json', disposition: 'unchanged' }),
          ],
        }),
      );
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(confirm.mock.calls[0]?.[0]).toMatch(/1 resource on the branch differs from/);
    });

    /**
     * #983 — and it must SAY so in the table, in the same words the outcome
     * screen uses minutes later. Before this, the row read "content differs",
     * which is true and reads as a promise of a write that never comes.
     */
    it('labels a superseded resource in the preview table, not as a content difference', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({ resources: [previewResource({ disposition: 'superseded' })] }),
      );

      await checkForIncoming();

      const row = within(await screen.findByRole('table')).getByRole('row', { name: /Nightly/ });
      expect(
        within(row).getByText('already here — this workspace has authored past it'),
      ).toBeInTheDocument();
      expect(within(row).queryByText('content differs')).not.toBeInTheDocument();
    });

    /** `refused: true` arrives as a 200. A 200 is not an import. */
    it('reports a refusal as a refusal, not as a successful import', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          refused: true,
          diagnostics: [
            { path: 'pipelines/broken.json', code: 'unparseable', message: 'unexpected token' },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(/Import refused/);
      expect(screen.getByText(/unexpected token/)).toBeInTheDocument();
      expect(screen.queryByRole('status')).toBeNull();
      // A refusal wrote nothing, so the reading it was taken against is still
      // an accurate account of the branch. Discarding it would cost the
      // operator a second check to see the very same thing.
      expect(screen.queryByLabelText('Incoming changes')).not.toBeNull();
    });

    /**
     * `deferred` has no producer today. The day one appears, a client that
     * ignores it reports a clean import over resources that were never applied
     * — the silent-omission shape this page refuses everywhere else.
     */
    it('surfaces resources the server neither applied nor explained', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          deferred: [
            {
              path: 'datasets/orders.json',
              kind: 'connection',
              resourceId: null,
              disposition: 'create',
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /1 resource it did not apply and did not explain/,
      );
      expect(screen.getByText('datasets/orders.json')).toBeInTheDocument();
    });

    it('reports what changed, and does not count an unchanged resource as a change', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          applied: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              action: 'updated',
              versionMinted: true,
              versionContentUnverified: false,
            },
            {
              path: 'connections/api.json',
              kind: 'connection',
              resourceId: 'res_2',
              action: 'unchanged',
              versionMinted: false,
              versionContentUnverified: false,
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('status')).toHaveTextContent('1 resource changed');
      expect(screen.getByText(/pipelines\/nightly\.json/)).toHaveTextContent('new version');
      expect(screen.queryByText(/connections\/api\.json/)).toBeNull();
      // The preview described the pre-import state; leaving it up would assert
      // changes that have now been applied.
      expect(screen.queryByLabelText('Incoming changes')).toBeNull();
    });

    /**
     * #963 — `superseded` (the branch names a version this workspace already holds
     * and has authored past) writes nothing, so it must not inflate the roll-up.
     * The filter was a bare `action !== 'unchanged'`, which is structural and so
     * failed to compile nowhere when a THIRD did-nothing action arrived: the page
     * would have said "1 resource changed" about an import that touched nothing,
     * while the row beside it correctly read "already here".
     */
    it('does not count a SUPERSEDED resource as a change', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          applied: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              action: 'superseded',
              versionMinted: false,
              versionContentUnverified: false,
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('status')).toHaveTextContent(/Nothing to import/);
    });

    /**
     * #1018 — the operator deleted a connection an older, immutable version still
     * references. That ref cannot be put in resourceId-space, so it is excused
     * from the comparison — and BOTH tables have to say so, because "already
     * here" on its own asserts a byte-identity the import could not check. The
     * suffix is one shared constant for the same reason `superseded` is worded
     * identically in both: two phrasings read as two different findings.
     */
    it('says a ref could not be compared, in the preview AND in the outcome', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({
          resources: [
            previewResource({ disposition: 'superseded', versionContentUnverified: true }),
          ],
        }),
      );
      importMock.mockResolvedValue(
        applyResult({
          applied: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              action: 'superseded',
              versionMinted: false,
              versionContentUnverified: true,
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      expect(screen.getByRole('table')).toHaveTextContent(
        'already here — this workspace has authored past it (a ref names a deleted resource, so it was not compared)',
      );

      // The outcome for THIS case is the no-op sentence, because a superseded
      // resource wrote nothing and so never reaches the changed list. That
      // sentence claims the workspace "already matches" the branch — the very
      // thing the excused ref left unchecked — so it is where the caveat has to
      // land.
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));
      expect(await screen.findByRole('status')).toHaveTextContent(
        /already matches .* \(a ref names a deleted resource, so it was not compared\)\./,
      );
    });

    /**
     * The other render site: when the same import ALSO writes something, the
     * resource appears in the changed list, and the caveat has to travel with the
     * row rather than only with the no-op sentence (which is not shown at all in
     * that case). Reachable via a row-field patch — the version comparison passes
     * with an excused ref while `concurrency` differs, so the action is `updated`.
     */
    it('carries the caveat on the changed ROW when the import also wrote something', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          applied: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              action: 'updated',
              versionMinted: false,
              versionContentUnverified: true,
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      const row = (await screen.findAllByRole('listitem')).find((li) =>
        li.textContent?.includes('pipelines/nightly.json'),
      );
      expect(row).toHaveTextContent('a ref names a deleted resource, so it was not compared');
    });

    /** ...and an ordinary comparison claims nothing of the sort. */
    it('does not qualify a change whose comparison WAS fully made', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(
        preview({ resources: [previewResource({ disposition: 'superseded' })] }),
      );

      await checkForIncoming();
      expect(screen.getByRole('table')).not.toHaveTextContent(/was not compared/);
    });

    /** The commonest outcome, and the analogue of `committed: false`. */
    it('does NOT phrase an all-unchanged import as a failure', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ state: 'current' }));
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          applied: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              action: 'unchanged',
              versionMinted: false,
              versionContentUnverified: false,
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('status')).toHaveTextContent(
        /Nothing to import — this workspace already matches main at abcdef1/,
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    /**
     * "Already matches" is a claim about the WHOLE branch, so anything deferred
     * falsifies it. Without `deferred` in the condition the page states it as a
     * `role="status"` success a few lines above the `role="alert"` saying the
     * workspace does NOT match — a contradiction, and a screen reader hears the
     * reassuring half first.
     */
    it('does not claim the workspace already matches when a resource was deferred', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ state: 'current' }));
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(
        applyResult({
          applied: [
            {
              path: 'pipelines/nightly.json',
              kind: 'pipeline',
              resourceId: 'res_1',
              action: 'unchanged',
              versionMinted: false,
              versionContentUnverified: false,
            },
          ],
          deferred: [
            {
              path: 'datasets/orders.json',
              kind: 'connection',
              resourceId: null,
              disposition: 'create',
            },
          ],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /This workspace does not match main/,
      );
      expect(screen.queryByText(/already matches main/)).toBeNull();
    });

    /**
     * The time-of-check/time-of-use gap made visible. No CAS token exists to
     * close it, so the least dishonest thing available is to say when the thing
     * applied was not the thing shown.
     */
    it('says so when the branch moved between the preview and the import', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockResolvedValue(applyResult({ head: '9999999888888888' }));
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /abcdef1 was shown, 9999999 was applied/,
      );
    });

    it('reports an archive the preview never proposed', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ archive: [] }));
      importMock.mockResolvedValue(
        applyResult({
          archived: [{ resourceId: 'res_9', name: 'Legacy', disabledTriggerIds: ['tr_1', 'tr_2'] }],
        }),
      );
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      const archived = await screen.findByText(/Legacy/);
      expect(archived).toHaveTextContent('2 triggers disabled');
    });

    /**
     * `WorkspaceApplyError` reaches the client as a bare 500 "An unexpected
     * error occurred", which leaves the only question that matters unanswered.
     * The apply and the import-base stamp share one transaction, so the answer
     * is assertable rather than hoped for.
     */
    it('states that a thrown import changed nothing and did not move the base', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockRejectedValue(new ApiError(500, 'An unexpected error occurred.'));
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /No resources were changed and the import base did not move/,
      );
      expect(screen.queryByRole('status')).toBeNull();
    });

    /**
     * Both acts re-observe the remote server-side, so the status panel above is
     * rewritten whether or not the act then succeeded — and a failed check is
     * exactly when the recorded reason matters most.
     */
    it('re-reads the status after a FAILED import too', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockRejectedValue(new ApiError(502, 'git fetch failed'));
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      const before = getMock.mock.calls.length;
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(before));
    });

    /**
     * The counterpart to the reassurance above, and the reason it is
     * conditional. A transport failure carries NO response, so the request may
     * well have been applied and acknowledged into a socket nobody was left
     * holding. Claiming "nothing changed" there would be a guess in the voice
     * of a guarantee, and would send the operator to retry an import that has
     * already landed.
     */
    it('refuses to promise anything when the failure carried no response', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));
      importMock.mockRejectedValue(new TypeError('Failed to fetch'));
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      await checkForIncoming();
      await userEvent.click(screen.getByRole('button', { name: 'Import' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/not known whether the import was applied/);
      expect(alert).not.toHaveTextContent(/No resources were changed/);
    });

    /**
     * A commit rewrites the working copy every disposition was computed
     * against: a resource just committed would still read `unchanged` in a
     * preview taken before it.
     */
    it('discards an incoming reading once a commit rewrites the working copy', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));

      await checkForIncoming();
      expect(incoming()).toBeInTheDocument();

      commitMock.mockResolvedValue(commitResult({ committed: true }));
      await userEvent.type(screen.getByLabelText('Message'), 'later work');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      await waitFor(() => expect(screen.queryByLabelText('Incoming changes')).toBeNull());
    });

    /**
     * The companion to the test above, and the one that makes it mean
     * something: `committed: false` means the branch already matched, so the
     * working copy did NOT change and the reading is still good. Without this,
     * hoisting the invalidation out of the `if (commit.committed)` guard would
     * leave every test green.
     */
    it('keeps an incoming reading when a commit turns out to be a no-op', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence());
      previewMock.mockResolvedValue(preview({ resources: [previewResource()] }));

      await checkForIncoming();

      commitMock.mockResolvedValue(commitResult({ committed: false }));
      await userEvent.type(screen.getByLabelText('Message'), 'nothing to say');
      await userEvent.click(screen.getByRole('button', { name: 'Commit' }));

      await waitFor(() =>
        expect(screen.getByRole('status')).toHaveTextContent(/Nothing to commit/),
      );
      expect(screen.queryByLabelText('Incoming changes')).not.toBeNull();
    });

    /**
     * The staleness check compares the preview's head against the status
     * panel's — so if OUR OWN status re-read failed, the panel still holds the
     * pre-check head and the comparison would report "the branch moved" on the
     * strength of nothing but our own failure. A check almost always advances
     * the head, so this would fire on virtually every workspace whose refresh
     * blipped, blocking Import behind a fact nobody observed.
     */
    it('does not claim the branch moved when its own status re-read failed', async () => {
      await renderConnected();
      divergenceMock.mockResolvedValue(divergence({ collabHead: 'deadbeef00000000' }));
      previewMock.mockResolvedValue(
        preview({ head: 'deadbeef00000000', resources: [previewResource()] }),
      );
      // The status GET that follows the check fails, so the panel keeps the OLD
      // head — which is exactly the disagreement that must NOT be read as drift.
      getMock.mockRejectedValueOnce(new Error('service unavailable'));

      await checkForIncoming();

      await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled());
      expect(screen.queryByText(/has moved since this preview was taken/)).toBeNull();
    });

    it('takes part in the page-wide lock rather than running beside another act', async () => {
      await renderConnected();
      divergenceMock.mockReturnValue(new Promise(() => {}));

      await userEvent.click(screen.getByRole('button', { name: 'Check for incoming' }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled(),
      );
      for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    });
  });
});
