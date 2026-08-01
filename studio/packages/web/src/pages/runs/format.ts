import type { Run, RunEvent } from '@autonomy-studio/shared';
import type { NodeActivity } from './runSummary';

/** Epoch-ms → a human date+time, or an em-dash for a null (not-yet) timestamp. */
export function formatWhen(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString();
}

/** A span in ms → the two most significant units, e.g. `1h 04m`, `3m 07s`, `820ms`. */
export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

/**
 * R2/U10 — how long a run took, for the Monitor's Duration column.
 *
 * A `queued` run renders an em-dash rather than a number, and that is the whole
 * reason this takes the run instead of two timestamps. A queued run's
 * `started_at` is an ENQUEUE-time placeholder that admission later re-stamps
 * (`repo/runs.ts::admitQueuedRun`, and `queuedTriggerCandidatesForPipeline`
 * relies on the same fact: "a queued row's started_at is an enqueue-time
 * placeholder, not a service"). Subtracting it would render queue age in a
 * column labelled Duration — a wrong number, not a missing one.
 *
 * An unfinished run is measured against `now` and marked "so far". `now` is the
 * CALLER's, captured once per load: this list is a documented point-in-time
 * snapshot refreshed on demand, not a ticking clock, and taking the clock as an
 * argument is also what keeps this pure and testable.
 */
export function formatRunDuration(
  run: Pick<Run, 'status' | 'startedAt' | 'finishedAt'>,
  now: number,
): string {
  if (run.status === 'queued') return '—';
  if (run.finishedAt !== null) {
    return formatElapsed(Math.max(0, run.finishedAt - run.startedAt));
  }
  return `${formatElapsed(Math.max(0, now - run.startedAt))} so far`;
}

/**
 * #867 — how long a NODE took, for the Monitor's per-node Duration column.
 *
 * A span exists only when the log holds BOTH stamps for the latest attempt.
 * Two different absences render the same em-dash, and neither is a gap in this
 * function:
 *
 * 1. **No start stamp.** An `if`/`switch`, a `fail`/`filter` and a
 *    `call_pipeline` node are started and settled by ONE event, so nothing ever
 *    measured a span for them. `0ms` there would state a measurement nobody
 *    took — the difference between "instant" and "not measured", and only one
 *    of them is true.
 * 2. **No end stamp.** The attempt has not settled (or the run died mid-flight
 *    and never will). Deliberately NOT rendered as a live "3s so far": this
 *    page has no ticking clock by design, so such a counter could only be
 *    re-read when a FRAME lands — and for the node an operator actually watches
 *    (dispatched, grinding, emitting nothing) the dispatch IS the last frame,
 *    so it would sit at ~0ms while the node ran for minutes. A wrong number is
 *    worse than an absent one, which is the whole premise of this ticket. #890
 *    tracks the live counter, which needs a clock, not a format change.
 *
 * The number is WALL CLOCK for the latest attempt, from start to settle. That
 * INCLUDES a `wait`/`webhook` park (for those nodes waiting is the work) and
 * excludes time held between retries (the hold sits between two spans). It is
 * deliberately not called execution time, and it is not
 * `activity.captured.latencyMs` — that is one provider call's wall time, a
 * different number on a different scope.
 */
export function formatNodeDuration(node: Pick<NodeActivity, 'startedAtMs' | 'endedAtMs'>): string {
  if (node.startedAtMs === undefined || node.endedAtMs === undefined) return '—';
  return formatElapsed(Math.max(0, node.endedAtMs - node.startedAtMs));
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

     `kind` appears on no other event variant in `EngineEventSchema`. `code`
     DOES: `activity.warned` declares one (`WARNING_CODES`), so warning rows gain
     a `code=` gloss too. Deliberate, and an improvement — the warning's machine
     code was previously invisible while its prose `reason` was not — but stated
     here because it is a rendering change to an event this ticket is not about,
     and it is pinned by a test. */
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
