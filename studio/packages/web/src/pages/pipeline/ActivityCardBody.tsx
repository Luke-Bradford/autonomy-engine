import { getActivity } from '@autonomy-studio/shared';
import { ActivityGlyph } from './ActivityGlyph';
import type { ActivityBadge } from './activitySummary';

/**
 * #1394 OR3 — the inside of an activity card: the glyph, the name, one line
 * saying what the step does, and the policy badges.
 *
 * ONE component for both canvases. The run graph drew a bare `<strong>` name
 * until slice 2, so the same node read as a full card while authoring and as a
 * one-word box while running — the view where an operator most needs to know
 * which step a status belongs to.
 */
export function ActivityCardBody({
  type,
  title,
  summary,
  badges,
}: {
  type: string;
  title: string;
  summary: string | null;
  badges: readonly ActivityBadge[];
}) {
  return (
    <>
      {/* The glyph is DECORATIVE and says so: the name beside it is the
          accessible content, and a second reading of "copy file" would just make
          a screen reader say it twice. */}
      <span className="flow-node-icon" aria-hidden="true">
        <ActivityGlyph type={type} category={getActivity(type)?.category} />
      </span>
      {/* The name WRAPS to two lines and the whole of it is the tooltip; under
          it, one line saying what this step does, and the policy badges. The
          summary row is drawn even when empty, so filling in a field never
          resizes the box (OR2). */}
      <span className="flow-node-body">
        <strong className="flow-node-title" title={title}>
          {title}
        </strong>
        <span className="flow-node-meta">
          <span className="flow-node-summary" title={summary ?? undefined}>
            {summary}
          </span>
          {badges.map((b) => (
            <span
              key={b.key}
              className={`flow-node-badge flow-node-badge--${b.key}`}
              role="img"
              aria-label={b.label}
              title={b.label}
            >
              {b.text}
            </span>
          ))}
        </span>
      </span>
    </>
  );
}
