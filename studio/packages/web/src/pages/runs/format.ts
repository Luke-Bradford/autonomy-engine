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
  /* #1 F0 / U24 — the failure CLASS. F0 correctly moved it out of the message
     string and into `kind`/`code` fields, and nothing here was taught to read
     them, so the feed rendered a throttle and a dead credential identically.
     `kind` appears on no other event variant in `EngineEventSchema`, so there is
     nothing else this can pick up. */
  push('kind', p.kind);
  push('code', p.code);
  return parts.join(' ');
}

/**
 * The failure class as one compact display string — `"transient · rate_limit"`.
 *
 * EMPTY is a real answer and callers must render it as nothing: a node can fail
 * with no class at all (`externalWait.expired` fails it from the expiry alarm,
 * with no `node.failed` behind it). Substituting a default here would make this
 * a second, drifting authority on what an unclassified failure means.
 */
export function failureClass(kind: string | undefined, code: string | undefined): string {
  return [kind, code].filter((v): v is string => typeof v === 'string' && v.length > 0).join(' · ');
}
