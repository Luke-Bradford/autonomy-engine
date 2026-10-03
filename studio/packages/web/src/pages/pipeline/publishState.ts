import type { ActivePipelineVersion, WorkspaceGitStatus } from '@autonomy-studio/shared';
import { getActivePipelineVersion } from '../../api/pipelines';
import { getWorkspaceGit } from '../../api/workspaceGit';

/** The two facts a publish/bind decision needs, as one indivisible reading. */
export interface PublishState {
  active: ActivePipelineVersion | null;
  gitConnected: boolean;
  /** #1476 OR28 — the repo itself, for the editor's git badge; `null` when none. */
  git: WorkspaceGitStatus | null;
}

/**
 * #979 — the two facts a Publish decision needs, read together.
 *
 * Together because they are meaningless apart: an active pointer without knowing
 * whether a repo is connected cannot tell "never published" from "publishing is
 * not available here". Either read failing rejects the pair, so the caller lands
 * in one unread state rather than a half-known one.
 *
 * A module-level function, not a `useCallback`: it holds no component state, and
 * calling a setState-bearing callback from an effect body is exactly what the
 * `set-state-in-effect` rule forbids — the caller applies the result in a
 * promise callback, the form the initial load beside it already uses.
 *
 * #981 lifted it out of `PipelineCanvas.tsx` so the trigger form can ask the
 * same question. The pairing is the whole point of the helper and is what makes
 * it worth sharing: the trigger form's first design read git-mode once at page
 * load and the active pointer lazily, which reintroduces exactly the half-known
 * state this docblock was written to rule out — a git-mode workspace whose
 * active pointer failed to read would have rendered as "nothing is published",
 * which is a different claim entirely.
 */
export async function readPublishState(
  pipelineId: string,
  signal?: AbortSignal,
): Promise<PublishState> {
  const [active, git] = await Promise.all([
    getActivePipelineVersion(pipelineId, signal),
    getWorkspaceGit(signal),
  ]);
  return { active, gitConnected: git !== null, git };
}

/**
 * #1502 — an order for the reads of one piece of state that several callers
 * read and one caller writes (the editor's publish state: read on open, on
 * focus and after a refused publish; written by a publish). Every read and
 * write takes the next ticket; an answer applies only if its ticket is newer
 * than the last one applied, and applying records it. A read that FAILS applies
 * nothing, so it voids nothing: an older read still in flight is then the
 * newest answer, and lands.
 */
export interface ReadSequence {
  issued: number;
  applied: number;
}

export function takeTicket(seq: ReadSequence): number {
  return ++seq.issued;
}

/** Whether an answer with this ticket is newer than what is applied; if so, it now is. */
export function claimTicket(seq: ReadSequence, ticket: number): boolean {
  if (ticket <= seq.applied) return false;
  seq.applied = ticket;
  return true;
}
