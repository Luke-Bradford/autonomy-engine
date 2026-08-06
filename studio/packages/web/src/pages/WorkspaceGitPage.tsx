import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatZodIssues,
  type WorkspaceGitCommitResult,
  type WorkspaceGitDrift,
  type WorkspaceGitStatus,
} from '@autonomy-studio/shared';
import {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  SetWorkspaceGitTokenBodySchema,
  clearWorkspaceGitToken,
  commitWorkspace,
  connectWorkspaceGit,
  disconnectWorkspaceGit,
  fetchWorkspaceGit,
  getWorkspaceGit,
  readWorkspaceGitDrift,
  setWorkspaceGitToken,
} from '../api/workspaceGit';
import { ApiError, messageOf } from '../api/client';
import { formatWhen } from './runs/format';

/**
 * #3 G10 / U18 slice 1 — Manage → Git (#956).
 *
 * The server has carried the whole workspace-git subsystem since the G-series;
 * no client ever called it, so "commit what I authored" was a path with a
 * complete back end and no front end at all. This page is that front end, at
 * its minimum honest size: see the connection, make one, hold a token, see what
 * is uncommitted, commit it, disconnect.
 *
 * DELIBERATELY NOT HERE (operator pre-settled the full "Git hub" as deferred):
 * the branch picker (`/working-branch` — the working branch is DISPLAY-only
 * here), `/divergence`, `/pull-request`, `/import-preview` + `/import`, and the
 * `Publish→active` command-bar states.
 *
 * WHY COMMIT LIVES HERE rather than on the pipeline command bar, which is where
 * the settled three-act model (#662: Save / Commit / Publish) puts it: a commit
 * serializes the WHOLE workspace — every pipeline, connection and trigger — and
 * returns the file set it wrote. It is not an act on the pipeline you happen to
 * have open, and dressing it as one would misreport its blast radius. The
 * command-bar half of U18 is still owed.
 */
export function WorkspaceGitPage() {
  /**
   * THREE distinct states, and collapsing any two of them would lie:
   * `undefined` = not loaded yet, `null` = loaded and genuinely not connected,
   * an object = connected. A read that has not happened, or that FAILED, must
   * never render the not-connected surface — that manufactures an absent fact
   * as a benign default (#473), and here the manufactured fact invites the
   * operator to connect a repo they may already have.
   */
  const [status, setStatus] = useState<WorkspaceGitStatus | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  /**
   * ONE act at a time, across the whole page — not a per-section busy flag.
   *
   * Every act here returns or invalidates the SAME status object, and the
   * sections are independent components, so per-section flags let two of them
   * be in flight at once and the later resolution wins by accident. The case
   * that made this a lock rather than a nicety: start "Store token", then
   * confirm Disconnect before the PUT resolves. Disconnect lands first and the
   * page correctly shows "no repository connected" — then the token PUT's
   * response arrives and writes a CONNECTED status back, resurrecting a
   * workspace the server no longer has. That is a manufactured fact (#473)
   * arriving by a race rather than by a default.
   *
   * The ref is what makes the guard real: two clicks in one tick both read the
   * same stale `busy` state, so the check has to be against a value that is
   * already updated synchronously.
   */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const runExclusive = useCallback(async (act: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await act();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    getWorkspaceGit(controller.signal)
      .then((git) => {
        setStatus(git);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(messageOf(err));
      });
    return () => controller.abort();
  }, []);

  return (
    <section aria-labelledby="workspace-git-heading">
      <div className="page-header">
        <h2 id="workspace-git-heading">Git</h2>
      </div>

      <p className="page-hint">
        Git is optional. Without a repo this workspace still works — saving a pipeline mints a
        version in the database either way. Connecting one lets you commit the whole workspace to a
        branch and review it like any other code.
      </p>

      {loadError && (
        <p role="alert" className="error">
          {loadError}
        </p>
      )}

      {status === undefined && !loadError && <p>Loading git connection…</p>}

      {status === null && <ConnectForm onConnected={setStatus} />}

      {status !== null && status !== undefined && (
        <GitStatusPanel
          status={status}
          onStatus={setStatus}
          onDisconnected={() => setStatus(null)}
          busy={busy}
          runExclusive={runExclusive}
        />
      )}
    </section>
  );
}

/** The not-connected surface: point the workspace at a repo. */
function ConnectForm({ onConnected }: { onConnected: (git: WorkspaceGitStatus) => void }) {
  const [repoUrl, setRepoUrl] = useState('');
  const [collabBranch, setCollabBranch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    /**
     * The blank branch key is OMITTED, not sent as `''`: `collabBranch` carries
     * the shared schema's `.default('main')`, so leaving the key out lets that
     * ONE default apply. Re-typing `'main'` here would be a second literal free
     * to drift from it.
     */
    const parsed = ConnectWorkspaceGitBodySchema.safeParse({
      repoUrl,
      ...(collabBranch !== '' ? { collabBranch } : {}),
    });
    if (!parsed.success) {
      setError(formatZodIssues(parsed.error.issues));
      return;
    }

    setSaving(true);
    try {
      onConnected(await connectWorkspaceGit(parsed.data));
    } catch (err) {
      setError(messageOf(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} aria-label="Connect a repository">
      <h3>No repository connected</h3>

      <label>
        Repository
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git, git@host:owner/repo.git, or a local path"
          required
        />
      </label>

      <label>
        Collaboration branch
        <input
          type="text"
          value={collabBranch}
          onChange={(e) => setCollabBranch(e.target.value)}
          placeholder="main"
        />
      </label>

      {/* Stated at the point of entry rather than left to a rejection: the
          shared schema REFUSES a credential embedded in the URL, because the
          URL is stored in plaintext and quoted back in error messages. */}
      <p className="page-hint">
        Authentication comes from your own environment (an SSH agent or a git credential helper), or
        from a token stored below once connected. Do not put a password in the URL — it is stored as
        written and will be refused.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

/** The connected surface: what the repo is, and the acts available on it. */
function GitStatusPanel({
  status,
  onStatus,
  onDisconnected,
  busy,
  runExclusive,
}: {
  status: WorkspaceGitStatus;
  onStatus: (git: WorkspaceGitStatus) => void;
  onDisconnected: () => void;
  busy: boolean;
  runExclusive: (act: () => Promise<void>) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const onRefresh = useCallback(
    () =>
      runExclusive(async () => {
        setError(null);
        try {
          onStatus(await fetchWorkspaceGit());
        } catch (err) {
          setError(messageOf(err));
        }
      }),
    [onStatus, runExclusive],
  );

  const onDisconnect = useCallback(async () => {
    if (
      !window.confirm(
        `Disconnect ${status.repoUrl}? Your pipelines stay in the database — only the link to the repository is removed.`,
      )
    )
      return;
    await runExclusive(async () => {
      setError(null);
      try {
        await disconnectWorkspaceGit();
        onDisconnected();
      } catch (err) {
        setError(messageOf(err));
      }
    });
  }, [status.repoUrl, onDisconnected, runExclusive]);

  return (
    <>
      <h3>Connected</h3>
      <dl className="run-meta">
        <dt>Repository</dt>
        <dd>{status.repoUrl}</dd>
        <dt>Collaboration branch</dt>
        <dd>{status.collabBranch}</dd>
        <dt>Working branch</dt>
        <dd>{status.workingBranch}</dd>
        <dt>State</dt>
        <dd>{describeState(status)}</dd>
        <dt>Last checked</dt>
        <dd>{formatWhen(status.lastFetchAt)}</dd>
        <dt>Collaboration branch head</dt>
        <dd>{shortSha(status.observedCollabHead)}</dd>
        <dt>Imported from</dt>
        <dd>{shortSha(status.importedFromCommit)}</dd>
      </dl>

      {/* The panel above is a pure DB read — every one of those fields is what
          the LAST sync recorded, so a repo that went unreachable an hour ago
          still reads `ready` until something re-observes it. */}
      <p className="page-hint">
        These are the values recorded at the last check, not a live reading. Refresh to re-observe
        the remote.
      </p>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="button" onClick={() => void onRefresh()} disabled={busy}>
          {busy ? 'Working…' : 'Refresh'}
        </button>
        <button type="button" onClick={() => void onDisconnect()} disabled={busy}>
          Disconnect
        </button>
      </div>

      <TokenForm status={status} onStatus={onStatus} busy={busy} runExclusive={runExclusive} />
      <CommitSection status={status} onStatus={onStatus} busy={busy} runExclusive={runExclusive} />
    </>
  );
}

/**
 * The stored-token half of G10. Write-only in both directions: the ciphertext
 * is never returned by any route, so there is nothing to prefill and the field
 * starts blank on every render. Blank submit is REFUSED rather than treated as
 * "clear" — clearing is its own explicit button, because silently deleting a
 * credential on an empty submit is the kind of destruction you cannot undo.
 */
function TokenForm({
  status,
  onStatus,
  busy,
  runExclusive,
}: {
  status: WorkspaceGitStatus;
  onStatus: (git: WorkspaceGitStatus) => void;
  busy: boolean;
  runExclusive: (act: () => Promise<void>) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = SetWorkspaceGitTokenBodySchema.safeParse({ token });
    if (!parsed.success) {
      setError(formatZodIssues(parsed.error.issues));
      return;
    }

    await runExclusive(async () => {
      try {
        onStatus(await setWorkspaceGitToken(parsed.data));
        setToken('');
      } catch (err) {
        setError(messageOf(err));
      }
    });
  }

  async function onClear() {
    if (!window.confirm('Remove the stored token? Pushes will fall back to your git credentials.'))
      return;
    await runExclusive(async () => {
      setError(null);
      try {
        onStatus(await clearWorkspaceGitToken());
      } catch (err) {
        setError(messageOf(err));
      }
    });
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} aria-label="Git token">
      <h3>Access token</h3>
      <p className="page-hint">
        {status.hasStoredToken
          ? 'A token is stored, encrypted. It is never shown again — enter a new one to replace it.'
          : 'No token stored. One is only needed if your environment cannot authenticate to the remote on its own.'}
      </p>

      <label>
        Token
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={status.hasStoredToken ? 'enter a new token to replace the stored one' : ''}
          autoComplete="off"
        />
      </label>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="form-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : status.hasStoredToken ? 'Replace token' : 'Store token'}
        </button>
        {status.hasStoredToken && (
          <button type="button" onClick={() => void onClear()} disabled={busy}>
            Remove stored token
          </button>
        )}
      </div>
    </form>
  );
}

/** Drift (what a commit would change) and the commit itself. */
function CommitSection({
  status,
  onStatus,
  busy,
  runExclusive,
}: {
  status: WorkspaceGitStatus;
  onStatus: (git: WorkspaceGitStatus) => void;
  busy: boolean;
  runExclusive: (act: () => Promise<void>) => Promise<void>;
}) {
  const [drift, setDrift] = useState<WorkspaceGitDrift | null>(null);
  const [result, setResult] = useState<WorkspaceGitCommitResult | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * Drift and commit both re-observe the remote server-side, which REWRITES the
   * status fields the panel above is displaying. Re-reading the status after
   * each keeps that panel from showing a pre-drift `lastFetchAt` next to a
   * post-drift answer. A failure to re-read is not a failure of the act that
   * succeeded, so it is deliberately not surfaced as one.
   */
  const syncStatus = useCallback(async () => {
    try {
      const git = await getWorkspaceGit();
      if (git !== null) onStatus(git);
    } catch {
      /* the act itself succeeded; a stale header is not worth an alarm */
    }
  }, [onStatus]);

  const onCheck = useCallback(
    () =>
      runExclusive(async () => {
        setError(null);
        setResult(null);
        try {
          setDrift(await readWorkspaceGitDrift());
          await syncStatus();
        } catch (err) {
          setError(messageOf(err));
        }
      }),
    [syncStatus, runExclusive],
  );

  async function onCommit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // The notice belongs to the attempt that produced it. Without this, a
    // commit that succeeds and is then re-attempted unsuccessfully leaves the
    // old "Committed <sha>…" line on screen NEXT TO the new failure — which
    // reads as confirmation that the failed attempt was pushed.
    setResult(null);

    const parsed = CommitWorkspaceGitBodySchema.safeParse({ message });
    if (!parsed.success) {
      setError(formatZodIssues(parsed.error.issues));
      return;
    }

    await runExclusive(async () => {
      try {
        const commit = await commitWorkspace(parsed.data);
        setResult(commit);
        // The drift on screen described the state BEFORE this commit; leaving it
        // up would assert changes that are now committed.
        setDrift(null);
        if (commit.committed) setMessage('');
        await syncStatus();
      } catch (err) {
        setError(describeCommitFailure(err));
      }
    });
  }

  return (
    <section aria-labelledby="commit-heading">
      <h3 id="commit-heading">Commit</h3>
      <p className="page-hint">
        A commit writes the whole workspace — every pipeline, connection and trigger — to{' '}
        <code>{status.workingBranch}</code> and pushes it.
      </p>

      <div className="form-actions">
        <button type="button" onClick={() => void onCheck()} disabled={busy}>
          {busy ? 'Working…' : 'Check for changes'}
        </button>
      </div>

      {drift !== null && <DriftReport drift={drift} />}

      <form onSubmit={(e) => void onCommit(e)} aria-label="Commit the workspace">
        <label>
          Message
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="what changed, and why"
            required
          />
        </label>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        {/* `committed: false` is a SUCCESS meaning the serialization already
            matched the branch tip. Reporting it as a commit would invent a
            commit that does not exist. */}
        {result !== null && (
          <p role="status">
            {result.committed
              ? `Committed ${shortSha(result.commitSha)} to ${result.branch} — ${countFiles(result.files)}.`
              : `Nothing to commit — ${result.branch} already matches the workspace (${countFiles(result.files)}).`}
          </p>
        )}

        <div className="form-actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The advisory drift read, including the files it could NOT compare. */
function DriftReport({ drift }: { drift: WorkspaceGitDrift }) {
  return (
    <div aria-label="Uncommitted changes">
      {!drift.hasUncommittedChanges && <p>No uncommitted changes.</p>}

      {drift.hasUncommittedChanges && drift.changes.length === 0 && (
        <p>Changes are pending, but no resource differs — see the unreadable files below.</p>
      )}

      {drift.changes.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Resource</th>
              <th scope="col">Kind</th>
              <th scope="col">Change</th>
              <th scope="col">Path</th>
            </tr>
          </thead>
          <tbody>
            {drift.changes.map((change) => (
              <tr key={`${change.change}:${change.path}`}>
                <td>{change.name}</td>
                <td>{change.kind}</td>
                <td>{change.change}</td>
                <td>
                  <code>{change.path}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* A committed file that would not parse could not be compared, so it is
          excluded from `changes` rather than manufactured as a match — which
          makes showing it here the only thing standing between the operator and
          a silent omission. */}
      {drift.diagnostics.length > 0 && (
        <>
          <h4>Files that could not be read</h4>
          <ul>
            {drift.diagnostics.map((d) => (
              <li key={d.path}>
                <code>{d.path}</code> — {d.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * A commit failure, said in terms of what the operator can actually do here.
 *
 * The 409 case earns its own branch. The server's message for a non-fast-
 * forward push (`GitPushRejectedError`) tells the reader to "fetch/import the
 * latest changes and re-commit" — but `/import` is deferred out of this slice,
 * so following that instruction is impossible from this page. Passing the
 * message through unqualified would send the operator looking for a control
 * that does not exist. Everything else is the server's own client-safe prose.
 */
function describeCommitFailure(err: unknown): string {
  const message = messageOf(err);
  if (err instanceof ApiError && err.status === 409) {
    return `${message} Importing the branch is not yet available here — reconcile the two histories with git directly, then commit again.`;
  }
  return message;
}

/** The human line for the derived sync state, carrying the error when there is one. */
function describeState(status: WorkspaceGitStatus): string {
  switch (status.state) {
    case 'ready':
      return 'Ready';
    case 'collab_branch_missing':
      return `The branch "${status.collabBranch}" does not exist at the remote yet — the first commit creates it.`;
    case 'fetch_error':
      return `Last check failed: ${status.lastFetchError ?? 'reason not recorded'}`;
  }
}

/** A commit sha at review length, or an em-dash when there is none to show. */
function shortSha(sha: string | null): string {
  return sha === null ? '—' : sha.slice(0, 7);
}

function countFiles(files: string[]): string {
  return `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
}
