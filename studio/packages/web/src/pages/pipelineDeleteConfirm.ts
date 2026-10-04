import type { PipelineDependentsResponse } from '@autonomy-studio/shared';
import {
  ARCHIVE_INSTEAD,
  GIT_COMMIT_DELETES_FILES_NOTE,
  listPipelineDependents,
  pipelineHasRunsMessage,
} from '../api/pipelines';
import { advisoryDetail, messageOf } from '../api/client';
import { formatNameList } from './connections/dependencyCheck';
import { nodeLabels, nodePhrase } from './connections/dependentNodes';
import { debugKeptFor } from './pipeline/runNowRules';

/** The dependents read, settled: a failure is carried, never thrown. */
export type PipelineDependentsRead =
  { state: 'known'; value: PipelineDependentsResponse } | { state: 'unavailable'; detail: string };

/**
 * What a pipeline Delete does next: refuse outright, or ask.
 *
 * `typeToConfirm` is set only when a read that SUCCEEDED found something the
 * delete definitely takes with it or breaks — the connections rule
 * (#1145/#1158): a failed read is advisory and an outage adds no friction. A
 * `${}` caller is a MAY, and advisory too (see `pipelineDeletePlan`).
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
    const message = read.value.debugRunsOnly
      ? debugRunsOnlyMessage(name, read.value.debugRetentionDays)
      : pipelineHasRunsMessage(name);
    return { kind: 'refused', message };
  }
  const parts = [
    `Delete pipeline "${name}"?`,
    'Every version is deleted with it. This cannot be undone.',
  ];
  let hasDependants = false;
  if (read.state === 'unavailable') {
    parts.push(
      `Could not check what depends on it (${advisoryDetail(read.detail)}) — any trigger bound to it is deleted with it, and any pipeline that calls it will fail at that step.`,
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
      parts.push(`${nodePhrase(literal)} ${verb} it and will fail when they reach that step.`);
    }
    const dynamic = nodeLabels(dynamicCallers);
    if (dynamic.length > 0) {
      const verb = dynamic.length === 1 ? 'calls' : 'call';
      parts.push(
        `${nodePhrase(dynamic)} ${verb} a pipeline chosen at run time and may call this one.`,
      );
    }
    // A `${}` caller is NAMED but does not arm the typed name, unlike a
    // connection's dynamic ref: a call target can resolve to ANY pipeline, so
    // one router node in the workspace would make every pipeline delete demand
    // the name — friction that teaches typing without reading.
    hasDependants = triggers.length + literal.length > 0;
  }
  parts.push(`If this workspace is connected to git, ${GIT_COMMIT_DELETES_FILES_NOTE}.`);
  return {
    kind: 'confirm',
    message: parts.join('\n\n'),
    ...(hasDependants ? { typeToConfirm: name } : {}),
  };
}

/**
 * #1433 — the refusal when the only runs are DEBUG runs. Those are not kept
 * forever like a saved version's: they go with their debug version after the
 * server's window (`DEBUG_RETENTION_DAYS`, aged from when the Debug started),
 * and the pipeline can be deleted then — so say that, rather than send the user
 * to archive a pipeline that merely has to wait.
 */
export function debugRunsOnlyMessage(name: string, retentionDays: number | null): string {
  if (retentionDays === null) {
    return (
      `Cannot delete “${name}”: its only runs are Debug runs, and this server keeps ` +
      `those until they are deleted (DEBUG_RETENTION_DAYS is 0). ${ARCHIVE_INSTEAD}`
    );
  }
  return (
    `Cannot delete “${name}”: its only runs are Debug runs, ${debugKeptFor(retentionDays)} ` +
    "after each Debug starts — it can be deleted once they are gone. To hide it now, archive it " +
    "from the Pipelines list or the editor's ⋯ menu."
  );
}
