import { useStore } from 'zustand';
import { uiStore, type UiStore } from '../stores/uiStore';
import {
  formatCompactTimestamp,
  formatRelative,
  formatTimestamp,
  INVALID_TIME,
  type DisplayTimeZone,
  type TimestampPrecision,
} from './displayTime';

/**
 * #1484 — the viewer's display time zone, subscribed: a component that shows a
 * time re-renders when Settings changes it. Pure helpers that build a sentence
 * around a time take the zone as an argument; this is where a component gets it.
 */
export function useDisplayTimeZone(store: UiStore = uiStore): DisplayTimeZone {
  return useStore(store, (s) => s.displayTimeZone);
}

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
 * millisecond precision plus the relative time — computed at render, so it is
 * as fresh as the page's last render rather than ticking, which is enough for
 * "roughly how long ago" and costs no timer per cell.
 */
export function When({ ms, precision = 'second', compact = false, store }: WhenProps) {
  const zone = useDisplayTimeZone(store);
  if (ms === null) return <>—</>;
  // Not an instant (a corrupt or missing field): say so, without a `<time>`
  // whose `dateTime` would throw.
  if (!Number.isFinite(ms)) return <>{INVALID_TIME}</>;
  const now = Date.now();
  const text = compact
    ? formatCompactTimestamp(ms, zone, now)
    : formatTimestamp(ms, zone, precision);
  return (
    <time
      dateTime={new Date(ms).toISOString()}
      title={`${formatTimestamp(ms, zone, 'ms')} · ${formatRelative(ms, now)}`}
    >
      {text}
    </time>
  );
}
