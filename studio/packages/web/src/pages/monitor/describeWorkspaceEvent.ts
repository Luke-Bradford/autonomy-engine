import type { WorkspaceEvent } from '@autonomy-studio/shared';
import { TRIGGERS_STAY_DISABLED_NOTE } from '../../api/pipelines';
import { namedList } from '../../lib/namedList';

/** A workspace-audit row rendered as prose: a one-line act, and the particulars. */
export interface WorkspaceEventDescription {
  /** What happened, one line. Always present. */
  summary: string;
  /** The particulars, or `null` when the summary already says everything. */
  detail: string | null;
}

/** Git object ids are rendered short, as every git surface in the app does. */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** `1 trigger` / `3 triggers` — the count is the point, so it is never elided. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * #1075 — the workspace-audit union rendered for a reader.
 *
 * EXHAUSTIVE BY CONSTRUCTION: a `switch` over the discriminant with a `never`
 * assertion in the default, so adding a sixth variant to `WorkspaceEventSchema`
 * fails TYPECHECK here rather than rendering an "unknown event" placeholder in
 * front of an operator. An audit surface that can silently under-report an act
 * is worse than one that does not build.
 *
 * NO NAME LOOKUP, and that is a decision rather than an omission. Four of the
 * five payloads carry the human name they need — `pipeline.archived` and
 * `pipeline.restored` have `name`, `import.applied.archived[]` has one per
 * entry, `repo.connected` needs none — so a join would serve only
 * `pipeline.published`, whose payload carries a bare `resourceId`. And the only
 * list that could supply that name is LIVE-ONLY (`repo/pipelines.ts` filters
 * `eq(pipelines.archived, …)`, the two readings being exact complements), so
 * the join would resolve to nothing for exactly the pipelines this log is most
 * often about — the archived ones. A raw `resourceId` is honest; a name that
 * silently goes missing for archived pipelines is not. #1077 covers naming it
 * properly, which needs a by-resourceId read the server does not offer yet.
 *
 * WORDING IS TRUTHFUL TO THE SCHEMA'S OWN SEMANTICS, which are load-bearing and
 * easy to paraphrase into a lie:
 *   - a RESTORE re-enables nothing (`PipelineRestoredEventSchema`'s docblock:
 *     an `enabledTriggerIds` field "would be a standing lie about what the act
 *     does"), so the detail says so, in the product's existing words;
 *   - an IMPORT's archives are reported here and NOT double-counted as separate
 *     `pipeline.archived` events, so the import's detail states them itself;
 *   - a PUBLISH's `from` is the CAS expected-previous active, `null` on the
 *     first publish — rendered as "the first publish", never as an empty field.
 */
export function describeWorkspaceEvent(event: WorkspaceEvent): WorkspaceEventDescription {
  switch (event.type) {
    case 'repo.connected':
      return {
        summary: `Connected the repository ${event.repoUrl}`,
        detail: `Collaboration branch ${event.collabBranch}.`,
      };

    case 'pipeline.archived':
      return {
        summary: `Archived the pipeline ${event.name}`,
        detail:
          event.disabledTriggerIds.length > 0
            ? `The archive disabled ${plural(event.disabledTriggerIds.length, 'trigger')}.`
            : 'No triggers were enabled, so none were disabled.',
      };

    case 'pipeline.restored':
      return {
        summary: `Restored the pipeline ${event.name} from archive`,
        // The product already states this contract on the canvas banner and in
        // the archive confirmation; one wording, one source (#907).
        detail: `Restoring re-enables nothing — ${TRIGGERS_STAY_DISABLED_NOTE}.`,
      };

    case 'import.applied': {
      const parts: string[] = [];
      if (event.applied.length > 0) {
        parts.push(`Applied ${namedList(event.applied.map((resource) => resource.path))}.`);
      }
      if (event.archived.length > 0) {
        parts.push(`Archived ${namedList(event.archived.map((pipeline) => pipeline.name))}.`);
      }
      return {
        summary: `Imported ${plural(
          event.applied.length + event.archived.length,
          'resource',
        )} from ${event.branch} at ${shortSha(event.head)}`,
        // An import is emitted only when it was EFFECTFUL, so at least one of
        // the two arrays is non-empty and this is never the empty string.
        detail: parts.join(' '),
      };
    }

    case 'pipeline.published':
      return {
        summary: `Published a new active version of pipeline ${event.pipeline}`,
        detail:
          event.from === null
            ? `Version ${event.to}, from commit ${shortSha(event.commit)} — the first publish.`
            : `Version ${event.to}, from commit ${shortSha(event.commit)}, replacing ${event.from}.`,
      };

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
