import { appliedActionWroteNothing, type WorkspaceEvent } from '@autonomy-studio/shared';
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
 * NO NAME LOOKUP: every payload now carries the name it needs, so this stays a
 * PURE function of one event and the page keeps its single request.
 *
 * #1077 settled the one variant that did not. `pipeline.published` carried a
 * bare `resourceId`, and the choice was between joining the name here and
 * capturing it on the payload at write time. Capture won on the FACT, not on
 * the request count: a join would need both `listPipelines` and
 * `listArchivedPipelines` (`api/pipelines.ts` — exact complements, and an audit
 * log is disproportionately about pipelines that have since been archived), but
 * worse, it would re-answer the question with today's data. `name` is
 * `RESOURCE_VOLATILE`, so a rename would silently rewrite what the log says
 * about a publish that already happened. An audit log records what was so when
 * the act occurred.
 *
 * The name is therefore OPTIONAL and this renderer falls back to the
 * `resourceId` for rows written before the field existed — see
 * `PipelinePublishedEventSchema`'s docblock for why it can never become a
 * default.
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
      /*
       * `applied` is the apply's FULL judgement, not its writes: it carries a
       * row for every resource the branch offered, including the ones that
       * turned out to need nothing (`workspace-apply.ts` pushes
       * `action: 'unchanged'` for a connection whose content and name both
       * matched). Counting or naming those would tell an operator that a
       * routine re-import touched ten resources when it wrote one — which is
       * the SECOND of the two failure modes `appliedActionWroteNothing`'s own
       * docblock says it exists to prevent ("the Git page's roll-up saying 'N
       * changed' about resources it did not touch"). So the predicate is
       * reused, not re-spelled.
       *
       * `versionMinted` is ORed in rather than folded into the predicate,
       * because it is ORTHOGONAL to `action` (#672) — a row can write a new
       * version while its action reports no change. This is the same test
       * `buildImportAppliedEvent` uses to decide the event is worth emitting at
       * all, which is what keeps the sentence and the event's own existence
       * criterion from drifting apart.
       */
      const wrote = event.applied.filter(
        (resource) => !appliedActionWroteNothing(resource.action) || resource.versionMinted,
      );
      const untouched = event.applied.length - wrote.length;

      const parts: string[] = [];
      if (wrote.length > 0) {
        parts.push(`Applied ${namedList(wrote.map((resource) => resource.path))}.`);
      }
      if (event.archived.length > 0) {
        parts.push(`Archived ${namedList(event.archived.map((pipeline) => pipeline.name))}.`);
      }
      // Stated rather than dropped: the import DID look at these, and an
      // operator wondering why a re-import reported so little is owed the
      // difference between "not considered" and "considered, nothing to do".
      if (untouched > 0) {
        parts.push(`${plural(untouched, 'resource')} already matched.`);
      }

      return {
        summary: `Imported ${plural(
          wrote.length + event.archived.length,
          'resource',
        )} from ${event.branch} at ${shortSha(event.head)}`,
        // An import is emitted only when it was EFFECTFUL — `archived` is
        // non-empty or some row wrote — so this count is never zero and
        // `parts` is never empty.
        detail: parts.join(' '),
      };
    }

    case 'pipeline.published':
      return {
        // #1077 — the captured name, falling back to the `resourceId` for a row
        // written before that field existed. The fallback is the honest reading
        // of an absent name, not a placeholder: the `resourceId` IS the
        // pipeline's identity, and it is what this line always used to say.
        summary: `Published a new active version of pipeline ${event.name ?? event.pipeline}`,
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
