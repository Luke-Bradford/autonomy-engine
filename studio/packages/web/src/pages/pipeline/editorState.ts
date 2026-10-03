import type {
  WorkspaceGitPipelineDrift,
  WorkspaceGitStatus,
  WorkspaceGitSync,
} from '@autonomy-studio/shared';
import { shortSha } from '../../api/workspaceGit';
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

/** ` (abc1234 → def5678)`, or nothing when either end is unknown. */
function shasOf(from: string | null, to: string | null): string {
  return from !== null && to !== null ? ` (${shortSha(from)} → ${shortSha(to)})` : '';
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
}

const TONE_RANK: Record<BadgeTone, number> = { neutral: 0, success: 0, warning: 1, danger: 2 };
const worse = (a: BadgeTone, b: BadgeTone): BadgeTone => (TONE_RANK[b] > TONE_RANK[a] ? b : a);

/** Why this pipeline differs from the working branch, as a sentence. */
function driftSentence(change: WorkspaceGitPipelineDrift['change'], branch: string): string {
  switch (change) {
    case 'added':
      return `This pipeline is not on ${branch} yet.`;
    case 'modified':
      return `Its latest saved version differs from ${branch}.`;
    case 'renamed':
      return `It was renamed here; ${branch} still has the old name.`;
    case 'removed':
      return `It is archived here but still on ${branch}.`;
    case 'uncomparable':
      return `Its latest saved version could not be compared with ${branch}, so it is counted as uncommitted.`;
  }
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
 * neither. The reading is against the remote as fetched at `sync.fetchedAt`,
 * and the detail says when that was. Without a reading — unread, or the
 * server's fetch failed — none of these is claimed, and after a failed fetch
 * the `fetch failed` state stands alone rather than beside a comparison made
 * against refs it could not refresh.
 */
export function gitState({ git, source, sync, pipelineId }: GitInput): BadgePart | null {
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
  if (git.state !== 'fetch_error' && sync != null && pipelineId !== undefined) {
    const change = sync.pipelines.find((p) => p.pipelineId === pipelineId)?.change;
    const divergence = sync.divergence;
    if (change !== undefined) {
      parts.push('uncommitted');
      sentences.push(driftSentence(change, sync.workingBranch));
      tone = worse(tone, 'warning');
    }
    if (divergence.state === 'behind') {
      parts.push(`behind ${git.collabBranch} — pull first`);
      sentences.push(
        `${git.collabBranch} has moved since this workspace last imported from it` +
          `${shasOf(divergence.importBase, divergence.collabHead)}. Import it on Manage → Git before publishing.`,
      );
      tone = worse(tone, 'warning');
    } else if (divergence.state === 'diverged') {
      parts.push('diverged');
      sentences.push(
        `${git.collabBranch}'s history was rewritten since this workspace imported from it` +
          `${shasOf(divergence.importBase, divergence.collabHead)}, so the next import will not fast-forward.`,
      );
      tone = worse(tone, 'danger');
    } else if (change === undefined) {
      parts.push('in sync');
      sentences.push(
        `This pipeline matches ${sync.workingBranch}${sync.base !== null ? ` at ${shortSha(sync.base)}` : ''}` +
          (divergence.state === 'current'
            ? `, and ${git.collabBranch} has not moved since the last import.`
            : `. It is not compared with ${git.collabBranch}: this workspace has not imported from it.`),
      );
    }
    sentences.push(`Compared with the repo as fetched ${formatWhen(sync.fetchedAt)}.`);
  } else {
    sentences.push(
      git.lastFetchAt === null ? 'Never fetched.' : `Last fetched ${formatWhen(git.lastFetchAt)}.`,
    );
  }
  return {
    name: `${git.workingBranch} → ${git.collabBranch}`,
    label: parts.join(' · '),
    detail: sentences.join(' '),
    tone,
  };
}
