import { useCallback, useEffect, useRef, useState } from 'react';
import {
  appliedActionWroteNothing,
  dispositionWritesNothing,
  formatZodIssues,
  type WorkspaceGitApplyResult,
  type WorkspaceGitCommitResult,
  type WorkspaceGitDivergence,
  type WorkspaceGitDrift,
  type WorkspaceGitImportPreview,
  type WorkspaceGitStatus,
  type WorkspaceParseDiagnostic,
} from '@autonomy-studio/shared';
import {
  CommitWorkspaceGitBodySchema,
  ConnectWorkspaceGitBodySchema,
  SetWorkspaceGitTokenBodySchema,
  clearWorkspaceGitToken,
  commitWorkspace,
  connectWorkspaceGit,
  describeAppliedAction,
  describeDisposition,
  describeDriftChange,
  disconnectWorkspaceGit,
  fetchWorkspaceGit,
  getWorkspaceGit,
  importWorkspaceGit,
  previewWorkspaceGitImport,
  readWorkspaceGitDivergence,
  readWorkspaceGitDrift,
  setWorkspaceGitToken,
} from '../api/workspaceGit';
import { ApiError, messageOf } from '../api/client';
import { formatWhen } from './runs/format';

/**
 * #3 G10 / U18 slices 1-2 — Manage → Git (#956, #962).
 *
 * The server has carried the whole workspace-git subsystem since the G-series;
 * no client ever called it, so "commit what I authored" was a path with a
 * complete back end and no front end at all. This page is that front end: see
 * the connection, make one, hold a token, see what is uncommitted, commit it,
 * see what is INCOMING and apply it, disconnect.
 *
 * Slice 2 (#962) added the incoming half — divergence, import preview, import —
 * because it is what mints git provenance. `POST /api/pipelines/:id/publish`
 * refuses any version whose `sourceCommit`/`sourceBlobSha` is null, and the git
 * import is the ONLY writer of those fields (`portability/workspace-apply.ts`);
 * a version minted by Save leaves them null by construction. So Publish is not
 * merely nicer after import — without it, it can only ever refuse.
 *
 * DELIBERATELY NOT HERE (operator pre-settled the full "Git hub" as deferred):
 * the branch picker (`/working-branch` — the working branch is DISPLAY-only
 * here), `/pull-request`, any merge/conflict-RESOLUTION UX, and the
 * `Publish→active` command-bar states.
 *
 * WHY COMMIT LIVES HERE rather than on the pipeline command bar, which is where
 * the settled three-act model (#662: Save / Commit / Publish) puts it: a commit
 * serializes the WHOLE workspace — every pipeline, connection and trigger — and
 * returns the file set it wrote. It is not an act on the pipeline you happen to
 * have open, and dressing it as one would misreport its blast radius. An import
 * is the same shape in the other direction, which is why it is here too. The
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

  /**
   * The incoming readings live HERE, not inside `ImportSection`, because two
   * things outside that section invalidate them.
   *
   * A successful COMMIT rewrites the working copy every disposition in the
   * preview was computed against — a resource you have just committed would
   * still be listed as `unchanged` by a preview taken before it. That is the
   * same reason the commit clears its own drift report, and the section that
   * knows a commit happened is not the section holding the reading.
   *
   * (The other invalidation — the collab branch moving under the preview — is
   * DERIVED rather than stored: `preview.head` against the status panel's
   * `observedCollabHead`. See `ImportSection`.)
   */
  const [readings, setReadings] = useState<GitReadings | null>(null);

  /**
   * Re-read the status after any act that re-observes the remote server-side.
   *
   * Hoisted out of `CommitSection` at slice 2 rather than copied into the new
   * one: drift, commit, divergence, preview and import ALL re-observe the
   * remote before doing their work, so all five rewrite `lastFetchAt`/`state`/
   * `lastFetchError` on the panel above.
   *
   * It swallows its own failure ON PURPOSE — the act that just succeeded did
   * not fail because a follow-up read did. The corollary binds every caller: a
   * resolved `syncStatus()` is NOT evidence that the act it follows landed.
   *
   * It DOES report whether it refreshed, because a caller that goes on to
   * compare the panel's fields against its own reading needs to know it is
   * comparing against a current observation rather than a pre-act one.
   */
  const syncStatus = useCallback(async (): Promise<boolean> => {
    try {
      const git = await getWorkspaceGit();
      if (git !== null) onStatus(git);
      return true;
    } catch {
      /* the act itself succeeded; a stale header is not worth an alarm */
      return false;
    }
  }, [onStatus]);

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
      <CommitSection
        status={status}
        syncStatus={syncStatus}
        onWorkspaceChanged={() => setReadings(null)}
        busy={busy}
        runExclusive={runExclusive}
      />
      <ImportSection
        status={status}
        readings={readings}
        onReadings={setReadings}
        syncStatus={syncStatus}
        busy={busy}
        runExclusive={runExclusive}
      />
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
  syncStatus,
  onWorkspaceChanged,
  busy,
  runExclusive,
}: {
  status: WorkspaceGitStatus;
  /** Resolves to whether the panel above was actually re-read; ignored here. */
  syncStatus: () => Promise<boolean>;
  /** A commit rewrote the working copy — anything derived from it is now stale. */
  onWorkspaceChanged: () => void;
  busy: boolean;
  runExclusive: (act: () => Promise<void>) => Promise<void>;
}) {
  const [drift, setDrift] = useState<WorkspaceGitDrift | null>(null);
  const [result, setResult] = useState<WorkspaceGitCommitResult | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onCheck = useCallback(
    () =>
      runExclusive(async () => {
        setError(null);
        setResult(null);
        try {
          setDrift(await readWorkspaceGitDrift());
        } catch (err) {
          setError(messageOf(err));
        } finally {
          // In the FINALLY, not the try. The server re-observes the remote
          // before doing the work, so `lastFetchAt`/`state`/`lastFetchError`
          // have been rewritten whether or not the work then succeeded — and a
          // failed check is exactly when the recorded reason matters most.
          // Re-reading only on success would leave the panel asserting a
          // pre-failure "Ready" beside the failure itself.
          await syncStatus();
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
        // up would assert changes that are now committed. The incoming readings
        // go for the same reason one step further out: their dispositions were
        // computed against the pre-commit working copy.
        setDrift(null);
        if (commit.committed) {
          onWorkspaceChanged();
          setMessage('');
        }
      } catch (err) {
        setError(describeCommitFailure(err));
      } finally {
        // See `onCheck`: the remote was re-observed before the push either way,
        // so the panel is re-read on the failure path too.
        await syncStatus();
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

/**
 * One check, one pair. Divergence and the preview are always read together and
 * always discarded together, so they are one value rather than two `useState`s
 * that can disagree about whether a check has happened.
 */
interface GitReadings {
  divergence: WorkspaceGitDivergence;
  preview: WorkspaceGitImportPreview;
  /**
   * Whether the status panel was successfully re-read after this check.
   *
   * Load-bearing for the staleness comparison below, which is `preview.head`
   * against the panel's `observedCollabHead`. If that re-read FAILED, the panel
   * still holds the head from BEFORE the check — and a check almost always
   * advances the head, so the comparison would report "the branch moved" for
   * every workspace whose status refresh happened to fail. That is a
   * manufactured fact (#473) with our own failed read as its only evidence,
   * which is precisely the inversion this page refuses everywhere else.
   */
  statusObserved: boolean;
}

/** An import outcome, beside the head the operator was actually shown. */
interface ImportOutcome {
  result: WorkspaceGitApplyResult;
  /** `preview.head` at the moment Import was pressed — see `ImportSection`. */
  previewedHead: string | null;
}

/**
 * The incoming half: what is on the collaboration branch, and applying it.
 *
 * THE HAZARD THIS SECTION IS SHAPED AROUND. `POST /import` takes no body and no
 * expected-head token: it re-fetches and applies whatever is at the branch tip
 * at that instant. Preview-then-import is therefore a plain time-of-check /
 * time-of-use gap, and no amount of button-disabling closes it. So the UI does
 * the two things that ARE honest: it never claims the preview is what will
 * land, and it compares the head that came back against the head it showed,
 * saying so loudly when they differ.
 *
 * Import is gated on having a preview all the same — not as a safety
 * guarantee, but because applying a change set nobody has looked at is a
 * different act from applying one they have.
 */
function ImportSection({
  status,
  readings,
  onReadings,
  syncStatus,
  busy,
  runExclusive,
}: {
  status: WorkspaceGitStatus;
  readings: GitReadings | null;
  onReadings: (readings: GitReadings | null) => void;
  syncStatus: () => Promise<boolean>;
  busy: boolean;
  runExclusive: (act: () => Promise<void>) => Promise<void>;
}) {
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onCheck = useCallback(
    () =>
      runExclusive(async () => {
        setError(null);
        setOutcome(null);
        /**
         * Held rather than published inside the `try`, because the readings are
         * only complete once the status re-read below has reported whether it
         * succeeded — see `GitReadings.statusObserved`.
         */
        let read: Omit<GitReadings, 'statusObserved'> | null = null;
        try {
          /**
           * SEQUENTIAL, not `Promise.all`. Both calls re-observe the remote and
           * both are serialized per-owner server-side, so concurrency buys
           * nothing — while a partial failure under `Promise.all` would leave
           * one reading resolved and the other rejected, which is the exact
           * half-truth this section exists to avoid.
           */
          const divergence = await readWorkspaceGitDivergence();
          read = { divergence, preview: await previewWorkspaceGitImport() };
        } catch (err) {
          setError(messageOf(err));
        } finally {
          // In the FINALLY, for the reason `CommitSection.onCheck` gives: the
          // remote was re-observed before the work either way.
          const statusObserved = await syncStatus();
          /**
           * A failed check discards the previous reading along with itself. A
           * pruned import base comes back as a 502 from `/divergence`, and
           * leaving the last successful "Up to date" on screen beside that
           * error would render a failed check as a clean one — an absent fact
           * manufactured as a benign default (#473), in the one place where the
           * default invites the operator to skip an import they need.
           */
          onReadings(read === null ? null : { ...read, statusObserved });
        }
      }),
    [onReadings, syncStatus, runExclusive],
  );

  const preview = readings?.preview ?? null;

  /**
   * The branch moved since the preview was taken — derived, not stored.
   * `preview.head` IS the collab head at preview time, and the status panel
   * carries the latest observation of it, so any later act that re-observes the
   * remote (a refresh, a drift check, a commit) surfaces the drift for free.
   *
   * Gated on `statusObserved`: without it, our OWN failed status read would be
   * the sole evidence for a claim about the remote.
   */
  const previewIsStale =
    readings !== null &&
    readings.statusObserved &&
    readings.preview.head !== status.observedCollabHead;

  /**
   * The branch moved BETWEEN the two calls of a single check — the divergence
   * read one head and the preview read another, so the pair does not describe
   * one moment and neither half can be trusted to explain the other.
   */
  const checkWasTorn =
    readings !== null && readings.divergence.collabHead !== readings.preview.head;

  const blocked = describeImportBlock({ preview, previewIsStale, checkWasTorn });

  async function onImport() {
    if (readings === null || blocked !== null) return;
    if (!window.confirm(buildImportConfirmation(readings.preview, readings.divergence, status)))
      return;

    const previewedHead = readings.preview.head;
    await runExclusive(async () => {
      setError(null);
      setOutcome(null);
      try {
        const result = await importWorkspaceGit();
        setOutcome({ result, previewedHead });
        // Only an import that APPLIED invalidates the preview. A refusal wrote
        // nothing, so the reading on screen is still an accurate account of the
        // branch — discarding it would make the operator re-run a check to see
        // the same thing again.
        if (!result.refused) onReadings(null);
      } catch (err) {
        setError(describeImportFailure(err));
      } finally {
        // See `onCheck`. Note this resolving proves nothing about the import —
        // `syncStatus` swallows its own failure by design.
        await syncStatus();
      }
    });
  }

  return (
    <section aria-labelledby="import-heading">
      <h3 id="import-heading">Incoming</h3>
      <p className="page-hint">
        An import applies everything on <code>{status.collabBranch}</code> to this workspace, and it
        is what stamps a version with the git provenance that publishing requires. The branch is
        re-read when you import, so what lands can differ from what is shown below.
      </p>

      <div className="form-actions">
        <button type="button" onClick={() => void onCheck()} disabled={busy}>
          {busy ? 'Working…' : 'Check for incoming'}
        </button>
      </div>

      {readings !== null && (
        <div aria-label="Incoming changes">
          <p>{describeDivergence(readings.divergence, status.collabBranch)}</p>

          {checkWasTorn && (
            <p role="alert" className="error">
              {status.collabBranch} moved while it was being checked — these two readings describe
              different commits. Check again before importing.
            </p>
          )}

          {previewIsStale && !checkWasTorn && (
            <p role="alert" className="error">
              {status.collabBranch} has moved since this preview was taken. Check again before
              importing.
            </p>
          )}

          <ImportPreviewReport preview={readings.preview} collabBranch={status.collabBranch} />
        </div>
      )}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {outcome !== null && (
        <ImportOutcomeReport outcome={outcome} collabBranch={status.collabBranch} />
      )}

      {readings !== null && (
        <div className="form-actions">
          <button type="button" onClick={() => void onImport()} disabled={busy || blocked !== null}>
            {busy ? 'Importing…' : 'Import'}
          </button>
          {blocked !== null && <span className="page-hint">{blocked}</span>}
        </div>
      )}
    </section>
  );
}

/**
 * Why Import is unavailable, or `null` when it is available.
 *
 * One function rather than a disabled-button expression plus a separate
 * sentence, so the reason shown can never disagree with the reason enforced.
 */
function describeImportBlock({
  preview,
  previewIsStale,
  checkWasTorn,
}: {
  preview: WorkspaceGitImportPreview | null;
  previewIsStale: boolean;
  checkWasTorn: boolean;
}): string | null {
  if (preview === null) return 'Check for incoming changes first.';
  if (checkWasTorn || previewIsStale) return 'This reading is out of date — check again.';
  // The empty-branch path early-returns a `refused: false` result with nothing
  // applied AND without moving the import base, so the click would report a
  // success that did nothing at all.
  if (preview.head === null) return 'There is nothing on the branch to import.';
  // A parse diagnostic makes the apply refuse, by construction and before any
  // write. Leaving the button live to earn that refusal wastes the operator's
  // time and teaches them to ignore the warning.
  if (preview.diagnostics.length > 0)
    return 'The import would be refused while any file on the branch cannot be read.';
  return null;
}

/**
 * The divergence sentence.
 *
 * `unknown` has TWO causes and they are not the same news: the server's
 * precheck returns it when the import base is null (this workspace has never
 * imported) OR when the collab head is null (the branch is empty, or was
 * deleted at the remote). Both shas are in the payload, so the reader is told
 * which — one sentence covering both would be false for whichever case it was
 * not written for.
 */
function describeDivergence(divergence: WorkspaceGitDivergence, collabBranch: string): string {
  switch (divergence.state) {
    case 'current':
      return `Up to date with ${collabBranch}.`;
    case 'behind':
      return `${collabBranch} has moved on since this workspace last imported. Importing brings it up to date.`;
    case 'diverged':
      return `${collabBranch}'s history was rewritten since this workspace last imported — importing replaces local resources with the branch's, and the commits this workspace came from are no longer on it.`;
    case 'unknown':
      if (divergence.importBase === null && divergence.collabHead === null)
        return `This workspace has never imported, and ${collabBranch} has no commits at the remote.`;
      if (divergence.importBase === null)
        return `This workspace has never imported from ${collabBranch}, so there is nothing to compare against — everything on the branch is incoming.`;
      return `${collabBranch} has no commits at the remote, or no longer exists.`;
  }
}

/** What is on the branch: the dispositions, the archive proposals, the unreadable files. */
function ImportPreviewReport({
  preview,
  collabBranch,
}: {
  preview: WorkspaceGitImportPreview;
  collabBranch: string;
}) {
  if (preview.head === null) {
    return <p>{collabBranch} has no commits yet — there is nothing to import.</p>;
  }

  return (
    <>
      <p>
        {collabBranch} is at <code>{shortSha(preview.head)}</code>.
      </p>

      {preview.resources.length === 0 && preview.diagnostics.length === 0 && (
        <p>The branch carries no resources.</p>
      )}

      {preview.resources.length > 0 && (
        <ResourceChangeTable
          rows={preview.resources.map((resource) => ({
            key: resource.path,
            name: resource.name,
            kind: resource.kind,
            change: describeDisposition(resource.disposition),
            path: resource.path,
          }))}
        />
      )}

      {/* The widest-blast-radius consequence on this page, and the one the
          operator did not ask for: a pipeline missing from the branch is
          archived and every trigger depending on it is switched off. Naming
          them before the act — and again in the confirmation — is the whole
          difference between an import and a surprise. */}
      {preview.archive.length > 0 && (
        <>
          <h4>Will be archived</h4>
          <p>
            These pipelines are not on {collabBranch}. Importing archives them and disables any
            trigger that depends on them. Nothing is deleted.
          </p>
          <ul>
            {preview.archive.map((proposal) => (
              <li key={proposal.resourceId}>{proposal.name}</li>
            ))}
          </ul>
        </>
      )}

      <ParseDiagnostics
        diagnostics={preview.diagnostics}
        note="While any of these cannot be read, an import refuses outright and changes nothing."
      />
    </>
  );
}

/** What the import actually did — which is not necessarily what the preview said. */
function ImportOutcomeReport({
  outcome,
  collabBranch,
}: {
  outcome: ImportOutcome;
  collabBranch: string;
}) {
  const { result, previewedHead } = outcome;

  /**
   * `refused` is a 200. It means a file on the branch would not parse and the
   * server abandoned the whole apply — nothing was written. Reporting it under
   * the success voice, or letting the 200 imply one, would invent an import.
   */
  if (result.refused) {
    return (
      <div>
        <p role="alert" className="error">
          Import refused — a file on {collabBranch} could not be read, so nothing was changed.
        </p>
        <ParseDiagnostics diagnostics={result.diagnostics} note={null} />
      </div>
    );
  }

  // #963 — asked through the shared predicate, not a bare `!== 'unchanged'`:
  // `superseded` is a did-nothing outcome too, and counting it here would claim
  // this import changed resources it never touched.
  const changed = result.applied.filter((applied) => !appliedActionWroteNothing(applied.action));

  return (
    <div>
      {/* The time-of-check/time-of-use gap, made visible rather than papered
          over: no CAS token exists to close it, so the least dishonest thing
          available is to say when the thing applied was not the thing shown. */}
      {previewedHead !== null && result.head !== previewedHead && (
        <p role="alert" className="error">
          {collabBranch} moved between the preview and the import: {shortSha(previewedHead)} was
          shown, {shortSha(result.head)} was applied. What landed is below.
        </p>
      )}

      {changed.length === 0 && result.archived.length === 0 && result.deferred.length === 0 ? (
        /* The commonest outcome, and the analogue of `committed: false`: every
           resource wrote nothing, so "0 changed" is a success, not a
           failure, and must not be phrased as one. `deferred` is part of the
           condition because "already matches" is a claim about the WHOLE
           branch: with anything deferred it is false, and would otherwise be
           asserted a few lines above the alert that contradicts it. */
        <p role="status">
          Nothing to import — this workspace already matches {collabBranch} at{' '}
          {shortSha(result.head)}.
        </p>
      ) : (
        <p role="status">
          Imported {shortSha(result.head)} from {collabBranch} — {countResources(changed.length)}{' '}
          changed.
        </p>
      )}

      {changed.length > 0 && (
        <ul>
          {changed.map((applied) => (
            <li key={applied.path}>
              {applied.path} — {describeAppliedAction(applied.action)}
              {applied.versionMinted && ' (new version)'}
            </li>
          ))}
        </ul>
      )}

      {result.archived.length > 0 && (
        <>
          <h4>Archived</h4>
          <ul>
            {result.archived.map((archived) => (
              <li key={archived.resourceId}>
                {archived.name}
                {archived.disabledTriggerIds.length > 0 &&
                  ` — ${countTriggers(archived.disabledTriggerIds.length)} disabled`}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* `deferred` has no producer today — the schema keeps it for a resource
          kind added ahead of its apply slice. Rendered anyway, and as an alert:
          the alternative is that the day something does populate it, those
          resources are neither applied nor archived nor diagnosed, and the page
          reports a clean import over a silent omission. Cheap now, invisible
          until it matters, and impossible to add retrospectively once a wrong
          answer has already been believed. */}
      {result.deferred.length > 0 && (
        <>
          <h4>Not applied</h4>
          <p role="alert" className="error">
            The server returned {countResources(result.deferred.length)} it did not apply and did
            not explain. This workspace does not match {collabBranch}.
          </p>
          <ul>
            {result.deferred.map((deferred) => (
              <li key={deferred.path}>
                <code>{deferred.path}</code> — {deferred.kind}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One row of a resource-change table: which resource, and what the act would do to it. */
interface ResourceChangeRow {
  key: string;
  name: string;
  kind: string;
  change: string;
  path: string;
}

/**
 * #964 — the Resource / Kind / Change / Path table, shared by the OUTGOING drift
 * report and the INCOMING import preview, which had built the same four columns
 * twice. `ParseDiagnostics` below is this file's precedent for extracting a
 * repeated block, but NOT for this signature: its two callers pass the same wire
 * type unchanged, so it takes that type directly.
 *
 * Here the rows are prepared by the caller instead, because the two tables
 * describe opposite comparisons (drift is workspace-vs-branch, preview is
 * branch-vs-workspace) over different enums with their own prose. Sharing the
 * MARKUP is the win; a shared vocabulary would invert one of the two sentences
 * (see `describeDriftChange`). The `key` comes from the caller for the same
 * reason: a preview row is unique by path, while two different drift rows can
 * carry one path — an `added` and a `removed` resource that happen to serialize
 * to the same filename — so drift keys on the change as well.
 */
function ResourceChangeTable({ rows }: { rows: ResourceChangeRow[] }) {
  return (
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
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.name}</td>
            <td>{row.kind}</td>
            <td>{row.change}</td>
            <td>
              <code>{row.path}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The files git served that this workspace could not parse. Shared by preview and outcome. */
function ParseDiagnostics({
  diagnostics,
  note,
}: {
  diagnostics: WorkspaceParseDiagnostic[];
  note: string | null;
}) {
  if (diagnostics.length === 0) return null;
  return (
    <>
      <h4>Files that could not be read</h4>
      {note !== null && <p>{note}</p>}
      <ul>
        {diagnostics.map((diagnostic) => (
          <li key={diagnostic.path}>
            <code>{diagnostic.path}</code> — {diagnostic.message}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The confirmation, which has to carry the two facts the button cannot.
 *
 * First that the preview is not a promise — the branch is re-read on import.
 * Second, and by NAME, the pipelines this will archive and the triggers it will
 * switch off, because that is the consequence nobody clicked for.
 */
function buildImportConfirmation(
  preview: WorkspaceGitImportPreview,
  divergence: WorkspaceGitDivergence,
  status: WorkspaceGitStatus,
): string {
  /**
   * Counted the way the OUTCOME counts, which is to say excluding the
   * unchanged. A workspace with one real change among twenty matching
   * resources would otherwise be confirmed as "20 resources" and then reported
   * as "1 resource changed" — the same quantity stated two ways, and the
   * overstatement landing at exactly the moment the operator is deciding.
   *
   * #983 — via the shared predicate rather than `!== 'unchanged'`, which is the
   * trap `dispositionWritesNothing` documents: `superseded` writes nothing
   * either, and the literal comparison would have gone on compiling while
   * quietly counting those resources as pending changes.
   */
  const differing = preview.resources.filter(
    (resource) => !dispositionWritesNothing(resource.disposition),
  );

  const lines = [
    `Import ${shortSha(preview.head)} from ${status.collabBranch} into this workspace?`,
    '',
    `${countResources(differing.length)} on the branch ${differing.length === 1 ? 'differs' : 'differ'} from this workspace and will be applied. The branch is re-read now, so what lands may differ from the preview.`,
  ];

  if (preview.archive.length > 0) {
    lines.push(
      '',
      `${countPipelines(preview.archive.length)} will be ARCHIVED because they are not on the branch, and any trigger depending on them will be disabled: ${preview.archive.map((proposal) => proposal.name).join(', ')}.`,
    );
  }

  if (divergence.state === 'diverged') {
    lines.push(
      '',
      `${status.collabBranch}'s history was rewritten since this workspace last imported.`,
    );
  }

  return lines.join('\n');
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
        <ResourceChangeTable
          rows={drift.changes.map((change) => ({
            key: `${change.change}:${change.path}`,
            name: change.name,
            kind: change.kind,
            change: describeDriftChange(change.change),
            path: change.path,
          }))}
        />
      )}

      {/* A committed file that would not parse could not be compared, so it is
          excluded from `changes` rather than manufactured as a match — which
          makes showing it here the only thing standing between the operator and
          a silent omission. */}
      <ParseDiagnostics diagnostics={drift.diagnostics} note={null} />
    </div>
  );
}

/**
 * A commit failure, said in terms of what the operator can actually do here.
 *
 * The 409 case earns its own branch. The server's message for a non-fast-
 * forward push (`GitPushRejectedError`) tells the reader to "fetch/import the
 * latest changes and re-commit"; until slice 2 that instruction named a control
 * this page did not have, and this qualifier apologised for it. Now it points
 * at the control instead. WORDING ONLY — deliberately not a button or a scroll
 * into the import section: an error message that moves the page under the
 * reader is a different feature, and a worse one.
 */
function describeCommitFailure(err: unknown): string {
  const message = messageOf(err);
  if (err instanceof ApiError && err.status === 409) {
    return `${message} Use "Check for incoming" below to see what is on the branch, import it, then commit again.`;
  }
  return message;
}

/**
 * An import failure that is NOT a refusal.
 *
 * A refusal (`refused: true`) arrives as a 200 and carries diagnostics saying
 * why. Everything else THROWS — including `WorkspaceApplyError`, which the
 * server's handler flattens to a bare 500 "An unexpected error occurred." A
 * branch whose docs no longer resolve (an unresolvable node ref, a cyclic
 * `call_pipeline`) lands exactly there, and the generic prose leaves the
 * operator with the one question that matters unanswered: did it half-apply?
 *
 * It did not, and for an `ApiError` that is assertable rather than hoped: the
 * whole apply AND the `importedFromCommit` stamp run inside ONE `db.transaction`
 * server-side, so a response-bearing failure is a rollback. Every earlier
 * failure (no repo, no git binary, a fetch error) throws before any write.
 *
 * The reassurance is therefore withheld for anything that is NOT an `ApiError`.
 * A transport failure — a dropped connection, a proxy timeout, a backgrounded
 * tab — carries no response, so the request may well have been applied and
 * acknowledged into a socket nobody was left holding. Saying "nothing changed"
 * there would be a guess wearing the voice of a guarantee, and it would send
 * the operator to retry an import that has already landed.
 */
function describeImportFailure(err: unknown): string {
  const message = messageOf(err);
  if (err instanceof ApiError) {
    return `${message} No resources were changed and the import base did not move.`;
  }
  return `${message} It is not known whether the import was applied — check for incoming changes again before retrying.`;
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

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function countFiles(files: string[]): string {
  return pluralize(files.length, 'file', 'files');
}

function countResources(count: number): string {
  return pluralize(count, 'resource', 'resources');
}

function countPipelines(count: number): string {
  return pluralize(count, 'pipeline', 'pipelines');
}

function countTriggers(count: number): string {
  return pluralize(count, 'trigger', 'triggers');
}
