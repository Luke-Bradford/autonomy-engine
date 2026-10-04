import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { PipelineVersion, Run, RunStatus, RunTriggeredByKind } from '@autonomy-studio/shared';
import { CopyableId } from '../../lib/CopyableId';
import { RunTriggeredByName } from '../../lib/KindName';
import { shortId } from '../../lib/ids';
import { useTickingNow } from '../../hooks/useTickingNow';
import { formatTimestamp } from '../../lib/displayTime';
import { useDisplayTimeZone } from '../../lib/useDisplayTimeZone';
import { versionLabel } from '../../lib/versionLabel';
import { When } from '../../lib/When';
import { runVersionPath } from '../author/pipelinePath';
import { formatRunDuration } from './format';
import { triggerRunsPath } from './runFilters';
import { runDetailPath, runLinkLabel } from './runPath';

/** What `/detail` names; `null` on the doc-less fallback, which names nothing. */
export interface RunHeaderNames {
  pipeline: string | null;
  trigger: string | null;
  debug: boolean;
  triggeredByKind: RunTriggeredByKind;
  parentPipelineName: string | null;
}

/** The ticking half, in a leaf so the page's folds do not re-run every second
 * (`useTickingNow`'s docblock). The clock runs only while the run is counting. */
function RunDuration({
  run,
  status,
  endedAt,
  counting,
}: {
  run: Run;
  status: RunStatus;
  endedAt: number | null;
  counting: boolean;
}) {
  const now = useTickingNow(1000, counting);
  return <>{formatRunDuration({ status, startedAt: run.startedAt, finishedAt: endedAt }, now)}</>;
}

/** An ISO occurrence time from the trigger context; the raw text if it will not parse. */
function Scheduled({ iso }: { iso: string }) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? <code>{iso}</code> : <When ms={ms} precision="ms" />;
}

/**
 * #1484 OR35 M2 — the run's header as ONE dense band: what ran, its status,
 * what started it, when, how long, its id, where it came from, and the actions.
 * It replaces a heading, a status line and a tall two-column list, so the
 * activity runs start near the top of the page.
 *
 * Each fact is a `dt`/`dd` pair in one `dl`, so it is labelled for a screen
 * reader exactly as the list was. A fact the run does not have (no trigger, no
 * parent, no git provenance) is absent rather than a dash, except Triggered by,
 * which every run has.
 */
export function RunHeader({
  runId,
  run,
  doc,
  names,
  status,
  statusPill,
  endedAt,
  counting,
  actions,
}: {
  runId: string;
  run: Run | null;
  doc: PipelineVersion | null;
  names: RunHeaderNames | null;
  status: RunStatus;
  /** The page's status pill and stream phase, which it already words. */
  statusPill: ReactNode;
  /** When the run ended: the row's stamp, or its `run.finished` event's. */
  endedAt: number | null;
  /** Whether an unfinished run's duration should count up (`streamStillLive`). */
  counting: boolean;
  actions: ReactNode;
}) {
  const zone = useDisplayTimeZone();
  const named = names?.pipeline != null && doc !== null;
  // Ended reads as a time of day when it is on Started's date in the display
  // zone: the date is beside it already. The full form is the hover, as always.
  const endedSameDay =
    run !== null &&
    endedAt !== null &&
    formatTimestamp(run.startedAt, zone).slice(0, 10) === formatTimestamp(endedAt, zone).slice(0, 10);
  const scheduledTime = run?.triggerContext?.scheduledTime ?? null;
  return (
    <header className="run-header">
      {/* #1392 — the heading names the pipeline and the version this run is
          bound to; until the names load (or on the doc-less fallback) it is the
          run's short id, as the breadcrumb is. The name opens that exact
          version: a read-only preview, or the editor when it is the latest. */}
      <h2 id="run-heading">
        {named ? (
          <>
            <Link to={runVersionPath(doc.pipelineId, doc.version, names.debug)}>
              {names.pipeline}
            </Link>{' '}
            <span className="run-heading__version">{versionLabel(doc.version, names.debug)}</span>
          </>
        ) : (
          <>
            Run <code>{shortId(runId)}</code>
          </>
        )}
      </h2>
      <div className="run-header__actions">
        {actions}
        {/* #1239 — an anchor: going somewhere is what an anchor is for. */}
        <Link className="page-back" to="/monitor/runs">
          ← All runs
        </Link>
      </div>
      <dl className="run-header__facts">
        <div>
          <dt>Status</dt>
          <dd>{statusPill}</dd>
        </div>
        {run && (
          <>
            {/* No name to give (none this viewer may see, or the doc-less
                fallback): the version the run is bound to, by id. */}
            {!named && (
              <div>
                <dt>Pipeline</dt>
                <dd>
                  <code>{run.pipelineVersionId}</code>
                </dd>
              </div>
            )}
            <div>
              <dt>Triggered by</dt>
              <dd>
                {names !== null && <RunTriggeredByName kind={names.triggeredByKind} />}
                {/* The trigger's own runs, filtered (#1484). A trigger deleted
                    since the run leaves `triggerId` null and nothing to link. */}
                {run.triggerId !== null && (
                  <>
                    {names !== null && ' · '}
                    <Link to={triggerRunsPath(run.triggerId)}>
                      {names?.trigger ?? <code>{run.triggerId}</code>}
                    </Link>
                  </>
                )}
                {names === null && run.triggerId === null && '—'}
              </dd>
            </div>
            {scheduledTime !== null && (
              <div>
                <dt>Scheduled</dt>
                <dd>
                  <Scheduled iso={scheduledTime} />
                </dd>
              </div>
            )}
            <div>
              <dt>Started</dt>
              <dd>
                <When ms={run.startedAt} precision="ms" />
              </dd>
            </div>
            <div>
              <dt>Ended</dt>
              <dd>
                <When ms={endedAt} precision="ms" timeOfDay={endedSameDay} />
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd className="num">
                <RunDuration run={run} status={status} endedAt={endedAt} counting={counting} />
              </dd>
            </div>
            <div>
              <dt>Run ID</dt>
              <dd>
                <CopyableId id={run.id} noun="run" />
              </dd>
            </div>
            {/* #1231 / U20 — the drill UP, present only on a run something
                called, and on the doc-less fallback too, which is when a failed
                child most needs a way back. Named by the parent's pipeline when
                this viewer owns it. */}
            {run.parentRunId !== null && (
              <div>
                <dt>Parent</dt>
                <dd>
                  {/* Named, the visible name IS the accessible name (a label
                      that omits it fails WCAG 2.5.3); the id is the hover. */}
                  {names?.parentPipelineName != null ? (
                    <Link to={runDetailPath(run.parentRunId)} title={run.parentRunId}>
                      {names.parentPipelineName}
                    </Link>
                  ) : (
                    <Link
                      to={runDetailPath(run.parentRunId)}
                      aria-label={runLinkLabel('Parent', run.parentRunId)}
                    >
                      <code>{run.parentRunId}</code>
                    </Link>
                  )}
                </dd>
              </div>
            )}
            {/* RS6 lineage — only when there IS a source run (`rerunOf` is the
                row projection of `run.started.rerunOf`). */}
            {run.rerunOf !== null && (
              <div>
                <dt>Rerun of</dt>
                <dd>
                  <Link
                    to={runDetailPath(run.rerunOf)}
                    aria-label={runLinkLabel('Source', run.rerunOf)}
                  >
                    <code>{shortId(run.rerunOf)}</code>
                  </Link>
                </dd>
              </div>
            )}
            {/* #3 G6b — where the version that ran came from, when it came from git. */}
            {doc?.sourceCommit != null && (
              <div>
                <dt>Source</dt>
                <dd title={doc.sourceCommit}>
                  {doc.sourceBranch !== null && `${doc.sourceBranch} @ `}
                  <code>{doc.sourceCommit.slice(0, 7)}</code>
                </dd>
              </div>
            )}
          </>
        )}
      </dl>
    </header>
  );
}
