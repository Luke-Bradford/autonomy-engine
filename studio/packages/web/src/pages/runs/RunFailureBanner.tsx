import { Link } from 'react-router';
import { failureClass } from './format';
import { failedNodeId, type RunFailure } from './runFailure';

/**
 * #1484 OR35 M2 — directly under a FAILED run's header: what failed, its error,
 * its kind and which attempt, with a way to the row and to the version that
 * ran. One line; a multi-line error opens with its first line as the summary.
 *
 * What it names is `runFailure`'s, which follows the engine's own blame, so the
 * banner never points at a failure the run handled.
 */
export function RunFailureBanner({
  failure,
  nameOf,
  versionHref,
  onShowActivity,
}: {
  failure: RunFailure;
  nameOf: (activityId: string) => string | null;
  /** The version that ran, with what failed selected in it (`failedNodeId`), or
   * `null` when its doc did not resolve. */
  versionHref: string | null;
  onShowActivity: (rowKey: string) => void;
}) {
  const openVersion = versionHref !== null && (
    <Link to={versionHref} title="The version this run ran">
      Open in editor
    </Link>
  );
  if (failure.kind === 'run') {
    return (
      <div className="run-failure" role="group" aria-label="Failure">
        <strong>Run failed</strong>
        {failure.reason !== null && (
          <>
            {' · '}
            <code>{failure.reason}</code>
          </>
        )}
        <span className="run-failure__actions">{openVersion}</span>
      </div>
    );
  }

  const id = failedNodeId(failure);
  const name = nameOf(id) ?? id;
  const row = failure.kind === 'activity' ? failure.row : null;
  const message = row?.error?.message ?? null;
  const [firstLine, ...rest] = message?.split('\n') ?? [];
  const cls =
    row?.error == null
      ? ''
      : failureClass(row.error.kind ?? undefined, row.error.code ?? undefined);
  return (
    <div className="run-failure" role="group" aria-label="Failure">
      <strong>Failed: {name}</strong>
      {failure.kind === 'container' && (
        <>
          {' · '}
          <code>{failure.reason}</code>
        </>
      )}
      {cls !== '' && <span className="run-failure__kind">{cls}</span>}
      {row?.attempt != null && <span>attempt {row.attempt}</span>}
      {firstLine !== undefined &&
        (rest.length === 0 ? (
          <span className="run-failure__message">{firstLine}</span>
        ) : (
          <details className="run-failure__message">
            <summary>{firstLine}</summary>
            <pre>{message}</pre>
          </details>
        ))}
      <span className="run-failure__actions">
        {row !== null && (
          <button type="button" onClick={() => onShowActivity(row.key)}>
            Show activity
          </button>
        )}
        {openVersion}
      </span>
    </div>
  );
}
