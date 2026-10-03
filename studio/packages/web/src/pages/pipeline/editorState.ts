import type {
  PipelineVersionState,
  WorkspaceGitPipelineDrift,
  WorkspaceGitPullRequestReading,
  WorkspaceGitStatus,
  WorkspaceGitSync,
} from '@autonomy-studio/shared';
import { describeDivergence, describePipelineDrift, shortSha } from '../../api/workspaceGit';
import { formatWhen } from '../runs/format';
import { activePhrase, type ActiveVersionLabel } from './versionHistory';

/**
 * #1476 OR28 — the editor's state badge, as pure rules.
 *
 * Colour follows ONE rule: `success` when the live version is what the canvas
 * shows, `warning` when something is pending — a draft, a newer saved version,
 * nothing published, or a live version that is not the canvas — `danger` when
 * the repo could not be read, and `neutral` otherwise. The text always carries
 * the meaning on its own, so the colour is never the only cue (WCAG 1.4.1).
 *
 * Labels are SHORT on purpose: they share the fixed-height toolbar row with the
 * title, the notice strip and every action, and that row must not wrap at
 * 1280px (#1475). The sentence lives in `detail`.
 */
export type BadgeTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface BadgePart {
  /**
   * A name drawn BEFORE the label that may be cut short with an ellipsis — a
   * branch has no length limit — so the label, which carries the state, never
   * is. Absent on parts that name nothing.
   */
  name?: string;
  /** The state, in words. Empty only when `name` alone says everything. */
  label: string;
  /** The full sentence behind the label: its tooltip and its hidden text. */
  detail: string;
  tone: BadgeTone;
  /** The canvas IS this version — drawn as a ✓ beside the label. */
  current?: boolean;
  /**
   * #1476 OR28 — a link drawn after the label (the open pull request): `label`
   * is its text, `name` its accessible name, `href` an http(s) URL. Not part of
   * `label`, so nothing says it twice.
   */
  link?: { label: string; name: string; href: string };
}

export interface EditingInput {
  dirty: boolean;
  /** The version the editor was opened from (`loaded`), the draft's basis. */
  loadedVersion: number | null;
  /** The newest saved version (`latestVersion`). */
  headVersion: number | null;
  /** The version shown read-only in place of the editor, or `null`. */
  previewedVersion: number | null;
  /** An archived pipeline refuses every save, so a draft must not promise one. */
  archived: boolean;
}

/**
 * The version the canvas SHOWS, or `null` when it shows something no saved
 * version holds (unsaved edits, or nothing saved yet).
 *
 * `loaded`, not the head: after a refused save the head is refetched and moves
 * on while the canvas stays on the version it was opened from, and a badge
 * reading the head would then name a version that is not on screen.
 */
export function canvasVersion(s: EditingInput): number | null {
  if (s.previewedVersion !== null) return s.previewedVersion;
  return s.dirty ? null : s.loadedVersion;
}

export function editingState(s: EditingInput): BadgePart {
  if (s.previewedVersion !== null) {
    const v = s.previewedVersion;
    const isHead = v === s.headVersion;
    return {
      label: `Viewing v${String(v)}${isHead ? ' (latest)' : ''}`,
      detail:
        `A read-only preview of v${String(v)}${isHead ? ', the latest saved version' : ''}.` +
        (s.dirty ? ' Your unsaved changes are kept and return when the preview closes.' : ''),
      tone: 'neutral',
    };
  }
  if (s.loadedVersion === null) {
    return s.dirty
      ? {
          label: 'Draft',
          detail: `Unsaved changes; nothing is saved yet.${saveHint(s.archived, 'as v1')}`,
          tone: 'warning',
        }
      : { label: 'Not saved', detail: 'This pipeline has no saved version yet.', tone: 'neutral' };
  }
  const v = String(s.loadedVersion);
  const newer =
    s.headVersion !== null && s.headVersion > s.loadedVersion ? String(s.headVersion) : null;
  if (s.dirty) {
    return {
      label: `Draft · v${v}`,
      detail:
        `Draft — unsaved changes on v${v}.` +
        (newer !== null ? ` v${newer} is newer.` : '') +
        saveHint(s.archived, 'as a new version'),
      tone: 'warning',
    };
  }
  if (newer !== null) {
    return {
      label: `v${v} · v${newer} is newer`,
      detail: `The canvas shows v${v}; v${newer} is the latest saved version.`,
      tone: 'warning',
    };
  }
  return { label: `v${v} (latest)`, detail: `v${v}, the latest saved version.`, tone: 'neutral' };
}

/** What Save would do with a draft — or that it will not, on an archived pipeline. */
function saveHint(archived: boolean, as: string): string {
  return archived
    ? ' The pipeline is archived, so it cannot be saved.'
    : ` Save version keeps them ${as}.`;
}

export interface LiveInput {
  /** Is a git repo connected? `undefined` while unread or after a failed read. */
  gitConnected: boolean | undefined;
  /** `activeVersionLabel(active, versions)`. */
  active: ActiveVersionLabel;
  /** `canvasVersion(...)`. */
  canvas: number | null;
}

/**
 * The live part, or `null` when it is not shown. "Live" is the ACTIVE
 * (published) version — the history list's word, used in every detail below.
 *
 * Hidden outside git mode: a DB-only workspace has no publish and no active
 * pointer (triggers bind to the latest version), so "Not published" there would
 * be a false alarm. Hidden too when the publish state is UNREAD — a failed read
 * shows nothing rather than a guess (absent, not wrong).
 */
export function liveState(s: LiveInput): BadgePart | null {
  if (s.gitConnected !== true || s.active === undefined) return null;
  if (s.active === null) {
    return {
      label: 'Not published',
      detail: 'No version is active (published) yet.',
      tone: 'warning',
    };
  }
  if (s.active === 'unnamed') {
    return {
      label: 'Live: not listed yet',
      detail: `Active (published): ${activePhrase('unnamed')}.`,
      tone: 'warning',
    };
  }
  const v = String(s.active);
  if (s.active === s.canvas) {
    return {
      label: `Live: v${v}`,
      detail: `v${v} is the active (published) version, and is what the canvas shows.`,
      tone: 'success',
      current: true,
    };
  }
  return {
    label: `Live: v${v}`,
    detail: `v${v} is the active (published) version; the canvas shows ${s.canvas === null ? 'unsaved changes' : `v${String(s.canvas)}`}.`,
    tone: 'warning',
  };
}

/** A part as one line of text: its name, then its label. */
export function partText(part: BadgePart): string {
  return [part.name, part.label].filter((t) => t !== undefined && t !== '').join(' · ');
}

/** ` Imported from abc1234; it is now at def5678.` — only once main has moved. */
function shasOf(state: string, from: string | null, to: string | null): string {
  if ((state !== 'behind' && state !== 'diverged') || from === null || to === null) return '';
  return ` Imported from ${shortSha(from)}; it is now at ${shortSha(to)}.`;
}

/** Where the version on the canvas came from in git, off its row. */
export interface VersionSource {
  version: number;
  sourceCommit: string | null;
  sourceBranch: string | null;
}

export interface GitInput {
  /** The workspace's repo, `null` when none is connected, `undefined` while unread. */
  git: WorkspaceGitStatus | null | undefined;
  /**
   * The saved version the canvas shows or was opened from (the preview, else
   * `loaded`), or `null` when nothing is saved yet.
   */
  source: VersionSource | null;
  /**
   * #1476 OR28 slice 6 — the repo compared with this workspace
   * (`POST /api/workspace/git/sync`): `undefined` while unread or after a
   * failed read, `null` when the server's last fetch failed so it compared
   * nothing. Either way no drift or divergence is claimed.
   */
  sync?: WorkspaceGitSync | null;
  /** The pipeline on the canvas, to pick its entry out of `sync.pipelines`. */
  pipelineId?: string;
  /**
   * #1476 OR28 slice 7 — the pull request open from the working branch
   * (`GET /api/workspace/git/pull-request`), `undefined` while unread or after
   * a failed read.
   */
  pullRequest?: WorkspaceGitPullRequestReading;
}

/**
 * The git part: which branch this workspace commits to, against the branch it
 * opens pull requests into, and the commit the canvas version came from.
 *
 * Hidden when no repo is connected, and while the repo is unread — absent, not
 * wrong, the live part's rule. The commit is the one the version was IMPORTED
 * from (`sourceCommit` is stamped only by an import), so it is worded that way:
 * a bare sha beside the branch pair would read as that branch's head. A version
 * saved here has none, and naming the branch head instead would claim a
 * provenance it does not have.
 *
 * The repo's state is the one recorded at its last fetch — the read behind it
 * is a DB read, not a fetch — so the detail says when that was.
 *
 * #1476 slice 6 — with a `sync` reading it also says whether THIS pipeline is
 * `uncommitted` (its latest saved version differs from the working branch),
 * whether the collaboration branch has moved since the workspace last imported
 * (`behind main — pull first`, or `diverged` when its history was rewritten —
 * a workspace-wide fact, worded as one in the detail), and `in sync` when
 * neither — or `committed` when main was never imported, so only the commit
 * direction was compared. The reading is against the remote as fetched at `sync.fetchedAt`,
 * and the detail says when that was. Without a reading — unread, or the
 * server's fetch failed — none of these is claimed, and after a failed fetch
 * the `fetch failed` state stands alone rather than beside a comparison made
 * against refs it could not refresh.
 */
export function gitState({
  git,
  source,
  sync,
  pipelineId,
  pullRequest,
}: GitInput): BadgePart | null {
  if (git === null || git === undefined) return null;
  const commit = source?.sourceCommit ?? null;
  const parts: string[] = [];
  const sentences = [
    `Commits go to ${git.workingBranch}; pull requests open into ${git.collabBranch}.`,
  ];
  if (source !== null && commit !== null) {
    parts.push(`from ${shortSha(commit)}`);
    sentences.push(
      `v${String(source.version)} was imported from commit ${shortSha(commit)}` +
        (source.sourceBranch !== null ? ` on ${source.sourceBranch}.` : '.'),
    );
  }
  let tone: BadgeTone = 'neutral';
  if (git.state === 'fetch_error') {
    parts.push('fetch failed');
    sentences.push(
      `The last fetch from the repo failed${git.lastFetchError !== null ? `: ${git.lastFetchError.replace(/\.?$/, '.')}` : '.'}`,
    );
    tone = 'danger';
  } else if (git.state === 'collab_branch_missing') {
    parts.push(`no ${git.collabBranch} yet`);
    sentences.push(`${git.collabBranch} was not found at the repo when it was last fetched.`);
    tone = 'warning';
  }
  // The tone only ever rises below: danger (`diverged`) is the last state set.
  if (git.state !== 'fetch_error' && sync != null && pipelineId !== undefined) {
    const { change, against } = pipelineDrift(sync, pipelineId);
    const divergence = sync.divergence;
    if (change !== undefined) {
      parts.push('uncommitted');
      sentences.push(describePipelineDrift(change, against));
      tone = 'warning';
    } else {
      sentences.push(
        `This pipeline matches ${against}` +
          (sync.base !== null ? ` at ${shortSha(sync.base)}` : '') +
          (against !== sync.workingBranch
            ? `; ${sync.workingBranch} has not been created yet.`
            : '.'),
      );
      // The workspace flag also counts what no pipeline entry carries (another
      // resource kind, a committed file that will not parse), so this pipeline
      // being clean is not the workspace being clean.
      if (sync.hasUncommittedChanges) {
        sentences.push('Other resources in this workspace are uncommitted.');
      }
    }
    if (divergence.state === 'behind') {
      parts.push(`behind ${git.collabBranch} — pull first`);
      tone = 'warning';
    } else if (divergence.state === 'diverged') {
      parts.push('diverged');
      tone = 'danger';
    } else if (change === undefined) {
      // `in sync` claims BOTH directions, so only once main was compared too; a
      // workspace that never imported has only the commit direction.
      parts.push(divergence.state === 'current' ? 'in sync' : 'committed');
    }
    // The Git page's own sentence, so the two surfaces say one thing.
    sentences.push(
      describeDivergence(divergence, git.collabBranch) +
        shasOf(divergence.state, divergence.importBase, divergence.collabHead),
    );
    sentences.push(`Compared with the repo as fetched ${formatWhen(sync.fetchedAt)}.`);
  } else {
    sentences.push(
      git.lastFetchAt === null ? 'Never fetched.' : `Last fetched ${formatWhen(git.lastFetchAt)}.`,
    );
  }
  // A reading for another repo or branch (either changed while it was in
  // flight, or a reconnect kept the default branch name) is not this one's: no
  // link rather than the old one's PR.
  const pr =
    pullRequest?.repoUrl === git.repoUrl && pullRequest.workingBranch === git.workingBranch
      ? pullRequest
      : undefined;
  sentences.push(...pullRequestSentence(pr));
  return {
    name: `${git.workingBranch} → ${git.collabBranch}`,
    label: parts.join(' · '),
    detail: sentences.join(' '),
    tone,
    ...(pr?.state === 'open' && {
      link: {
        label: `PR #${String(pr.number)}`,
        // Starts with the visible text, so voice control can say what it sees.
        name: `PR #${String(pr.number)} (pull request)`,
        href: pr.url,
      },
    }),
  };
}

/**
 * This pipeline's entry in a sync reading — `undefined` when it matches — and
 * the branch it was compared against: whatever `base` is. Before the working
 * branch exists that is the collaboration branch, and naming the working
 * branch then would describe a branch with no such state.
 */
export function pipelineDrift(
  sync: WorkspaceGitSync,
  pipelineId: string,
): { change: WorkspaceGitPipelineDrift['change'] | undefined; against: string } {
  return {
    change: sync.pipelines.find((p) => p.pipelineId === pipelineId)?.change,
    against: sync.baseBranch ?? sync.workingBranch,
  };
}

export interface ListRowInput {
  /** This pipeline's head and live version (`GET /api/pipelines/version-states`). */
  state: PipelineVersionState;
  /** Is a git repo connected? `undefined` while unread or after a failed read. */
  gitConnected: boolean | undefined;
  /** As `GitInput.sync`: `undefined` unread or failed, `null` when the server's fetch failed. */
  sync: WorkspaceGitSync | null | undefined;
}

/**
 * #1476 OR28 slice 8 — the badge, compact, for one row of the pipelines list,
 * so which pipelines differ from live shows without opening each one.
 *
 * The same rules as the editor's, about the LATEST SAVED version rather than a
 * canvas — a list row has no draft and no preview: the editing part is
 * `editingState` of a clean editor on the head, and the live part says the
 * live version against the head, in those words. Git says only `uncommitted`,
 * for a pipeline the sync reading lists; a clean row says nothing, so the rows
 * that differ are the ones that stand out. Without a reading — unread, or the
 * server's fetch failed — nothing is claimed either way.
 */
export function listRowBadge({ state, gitConnected, sync }: ListRowInput): {
  editing: BadgePart;
  live: BadgePart | null;
  git: BadgePart | null;
} {
  const head = state.latestVersion;
  const editing = editingState({
    dirty: false,
    loadedVersion: head,
    headVersion: head,
    previewedVersion: null,
    archived: false,
  });
  const active = state.active === null ? null : (state.active.version ?? 'unnamed');
  let live: BadgePart | null;
  if (typeof active !== 'number') {
    // Not published / not listed: nothing in those sentences is about a canvas.
    live = liveState({ gitConnected, active, canvas: head });
  } else if (gitConnected !== true) {
    live = null;
  } else if (active === head) {
    live = {
      label: `Live: v${String(active)}`,
      detail: `v${String(active)} is the active (published) version, and is the latest saved version.`,
      tone: 'success',
      current: true,
    };
  } else {
    live = {
      label: `Live: v${String(active)}`,
      detail: `v${String(active)} is the active (published) version; the latest saved version is ${head === null ? 'none' : `v${String(head)}`}.`,
      tone: 'warning',
    };
  }
  let git: BadgePart | null = null;
  if (gitConnected === true && sync != null) {
    const { change, against } = pipelineDrift(sync, state.pipelineId);
    if (change !== undefined) {
      git = {
        label: 'uncommitted',
        detail: describePipelineDrift(change, against),
        tone: 'warning',
      };
    }
  }
  return { editing, live, git };
}

/**
 * The pull request's sentence. `none` only when the host said so; a failed
 * lookup says it could not check, and a remote studio cannot ask (local, not
 * GitHub) says nothing — absent, not wrong. Never a tone: a PR is neither good
 * nor bad news.
 */
function pullRequestSentence(pr: WorkspaceGitPullRequestReading | undefined): string[] {
  if (pr === undefined) return [];
  // When the host answered: the server reuses one answer for a while.
  if (pr.state === 'open') {
    return [
      `Pull request #${String(pr.number)} is open from ${pr.workingBranch} (checked ${formatWhen(pr.checkedAt)}).`,
    ];
  }
  if (pr.state === 'none') {
    return [
      `No pull request is open from ${pr.workingBranch} (checked ${formatWhen(pr.checkedAt)}).`,
    ];
  }
  if (pr.reason === 'no_token') return ['Pull requests are not checked: no GitHub token is set.'];
  if (pr.reason === 'lookup_failed') {
    return [
      `Could not check for a pull request${pr.detail !== null ? `: ${pr.detail.replace(/\.?$/, '.')}` : '.'}`,
    ];
  }
  return [];
}
