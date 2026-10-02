import type { PipelineDependentsResponse } from '@autonomy-studio/shared';
import {
  GIT_COMMIT_DELETES_FILES_NOTE,
  listPipelineDependents,
  pipelineHasRunsMessage,
} from '../api/pipelines';
import { messageOf } from '../api/client';
import { formatNameList } from './connections/dependencyCheck';
import { nodeLabels } from './connections/dependentNodes';

/** The dependents read, settled: a failure is carried, never thrown. */
export type PipelineDependentsRead =
  | { state: 'known'; value: PipelineDependentsResponse }
  | { state: 'unavailable'; detail: string };

/**
 * What a pipeline Delete does next: refuse outright, or ask.
 *
 * `typeToConfirm` is set only when a read that SUCCEEDED found something the
 * delete takes with it or breaks — the connections rule (#1145/#1158): a failed
 * read is advisory and an outage adds no friction.
 */
export type PipelineDeletePlan =
  | { kind: 'refused'; message: string }
  | { kind: 'confirm'; message: string; typeToConfirm?: string };

/** `listPipelineDependents`, settled into a `PipelineDependentsRead`. */
export async function readPipelineDependents(id: string): Promise<PipelineDependentsRead> {
  try {
    return { state: 'known', value: await listPipelineDependents(id) };
  } catch (err) {
    return { state: 'unavailable', detail: messageOf(err) };
  }
}

/**
 * #1397 OR6 — the ONE pipeline-delete confirmation, shared by the Pipelines
 * page and the Factory Resources pane, whose two hand-written copies had
 * already drifted (straight vs curly quotes).
 *
 * The consequences it names are the ones the schema makes real: the triggers
 * bound to any version are DELETED by the cascade, not switched off; a
 * `call_pipeline` node elsewhere that names one of its versions fails when it
 * reaches that step; and on a git-connected workspace the next Commit deletes
 * the files. Run history refuses the delete, so that case is a refusal rather
 * than a question.
 */
export function pipelineDeletePlan(name: string, read: PipelineDependentsRead): PipelineDeletePlan {
  if (read.state === 'known' && read.value.hasRuns) {
    return { kind: 'refused', message: pipelineHasRunsMessage(name) };
  }
  const parts = [
    `Delete pipeline "${name}"?`,
    'Every version is deleted with it. This cannot be undone.',
  ];
  let hasDependants = false;
  if (read.state === 'unavailable') {
    parts.push(
      `Could not check what depends on it (${read.detail}) — any trigger bound to it is deleted with it, and any pipeline that calls it will fail at that step.`,
    );
  } else {
    const { triggers, callers, dynamicCallers } = read.value;
    if (triggers.length > 0) {
      const what = triggers.length === 1 ? '1 trigger' : `${triggers.length} triggers`;
      parts.push(
        `It also deletes ${what} bound to it (${formatNameList(triggers.map((t) => t.name))}), with their history.`,
      );
    }
    const literal = nodeLabels(callers);
    if (literal.length > 0) {
      const verb = literal.length === 1 ? 'calls' : 'call';
      parts.push(
        `${nodeCount(literal)} (${formatNameList(literal)}) ${verb} it and will fail when they reach that step.`,
      );
    }
    const dynamic = nodeLabels(dynamicCallers);
    if (dynamic.length > 0) {
      const verb = dynamic.length === 1 ? 'calls' : 'call';
      parts.push(
        `${nodeCount(dynamic)} (${formatNameList(dynamic)}) ${verb} a pipeline chosen at run time and may call this one.`,
      );
    }
    hasDependants = triggers.length + literal.length + dynamic.length > 0;
  }
  parts.push(`If this workspace is connected to git, ${GIT_COMMIT_DELETES_FILES_NOTE}.`);
  return {
    kind: 'confirm',
    message: parts.join('\n\n'),
    ...(hasDependants ? { typeToConfirm: name } : {}),
  };
}

function nodeCount(labels: readonly string[]): string {
  return labels.length === 1 ? '1 pipeline node' : `${labels.length} pipeline nodes`;
}
