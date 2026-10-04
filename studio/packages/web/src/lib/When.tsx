import { useState } from 'react';
import type { UiStore } from '../stores/uiStore';
import {
  formatCompactTimestamp,
  formatRelative,
  formatTimestamp,
  INVALID_TIME,
  type TimestampPrecision,
} from './displayTime';
import { useDisplayTimeZone } from './useDisplayTimeZone';

interface WhenProps {
  /** Epoch ms, or `null` for a time that has not happened (renders `—`). */
  ms: number | null;
  /** `ms` for a detail view; the default is to the second. */
  precision?: TimestampPrecision;
  /** The runs grid's narrow cell: `10-04 13:05:07`, the full form on hover. */
  compact?: boolean;
  /** Injectable for tests; the app uses the singleton. */
  store?: UiStore;
}

/**
 * #1484 OR35 principle 4 — one timestamp: absolute, in the viewer's display
 * zone, with the zone named, and the relative time ("3 minutes ago") on hover.
 *
 * A `<time>` element, so the machine-readable instant (`dateTime`, ISO UTC) is
 * in the DOM whatever zone is displayed. The hover title holds the full form at
 * millisecond precision plus the relative time. "Now" for that is taken at
 * mount and again whenever the pointer or focus arrives — the moment the title
 * is about to be read — so it is fresh when shown and costs no timer per cell
 * (and render stays pure).
 */
export function When({ ms, precision = 'second', compact = false, store }: WhenProps) {
  const zone = useDisplayTimeZone(store);
  const [now, setNow] = useState(Date.now);
  if (ms === null) return <>—</>;
  // Not an instant (a corrupt or missing field): say so, without a `<time>`
  // whose `dateTime` would throw.
  if (!Number.isFinite(ms)) return <>{INVALID_TIME}</>;
  const refresh = () => setNow(Date.now());
  const text = compact
    ? formatCompactTimestamp(ms, zone, now)
    : formatTimestamp(ms, zone, precision);
  return (
    <time
      dateTime={new Date(ms).toISOString()}
      title={`${formatTimestamp(ms, zone, 'ms')} · ${formatRelative(ms, now)}`}
      onPointerEnter={refresh}
      onFocus={refresh}
    >
      {text}
    </time>
  );
}
