import type { ActivePipelineVersion } from '@autonomy-studio/shared';
import { getActivePipelineVersion } from '../../api/pipelines';
import { getWorkspaceGit } from '../../api/workspaceGit';

/** The two facts a publish/bind decision needs, as one indivisible reading. */
export interface PublishState {
  active: ActivePipelineVersion | null;
  gitConnected: boolean;
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
  return { active, gitConnected: git !== null };
}
