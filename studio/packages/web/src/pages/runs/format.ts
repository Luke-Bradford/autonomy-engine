import type { RunEvent } from '@autonomy-studio/shared';

/** Epoch-ms → a human date+time, or an em-dash for a null (not-yet) timestamp. */
export function formatWhen(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString();
}

/** Epoch-ms → a compact time-of-day, for the dense event feed. */
export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/**
 * A one-line, human-readable gloss of a run event for the live feed. Reads only
 * the well-known display fields off the (unknown-typed) envelope payload
 * defensively — this is presentation, not the source of truth (the engine
 * derivations validate through `EngineEventSchema`), so an odd payload degrades
 * to an empty gloss rather than throwing.
 */
export function eventGloss(event: RunEvent): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const push = (label: string, v: unknown) => {
    if (typeof v === 'string' && v.length > 0) parts.push(`${label}=${v}`);
  };
  push('node', p.nodeId ?? p.callNodeId);
  push('name', p.name);
  push('outcome', p.outcome ?? p.childOutcome);
  push('reason', p.reason);
  push('error', p.error);
  return parts.join(' ');
}
