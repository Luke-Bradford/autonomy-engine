import { useTickingNow } from '../../hooks/useTickingNow';
import { DURATION_TICK_MS, formatLiveElapsed, formatNodeDuration, liveSpanStart } from './format';
import type { NodeActivity } from './runSummary';

/**
 * #890 — a node's Duration, counting up while its attempt is still running.
 *
 * `live` is the PAGE's answer to "would I hear this node settle?" — the stream
 * is open with its replay complete, and the run is not terminal. Without that,
 * a count could keep rising past a settle this page never received, so the
 * settled answer (`formatNodeDuration`, an em-dash for an open span) stands.
 * `liveSpanStart` then asks the ROW's half: is there an open span a count
 * could honestly start from.
 *
 * The clock lives in `LiveElapsed`, mounted only for a row that is counting, so
 * an idle table holds no timer and a tick re-renders one cell, not the page.
 */
export function NodeDuration({
  node,
  live,
}: {
  node: Pick<NodeActivity, 'startedAtMs' | 'endedAtMs' | 'spans'>;
  live: boolean;
}) {
  const start = live ? liveSpanStart(node) : undefined;
  return start === undefined ? formatNodeDuration(node) : <LiveElapsed startedAtMs={start} />;
}

/** A count up from `startedAtMs`, ticking once a second while mounted. */
export function LiveElapsed({ startedAtMs }: { startedAtMs: number }) {
  const now = useTickingNow(DURATION_TICK_MS);
  return formatLiveElapsed(startedAtMs, now);
}
