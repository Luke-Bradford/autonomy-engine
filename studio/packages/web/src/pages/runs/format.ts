import {
  DatasetAddressSchema,
  describeDatasetAddress,
  surrogateSafeCut,
} from '@autonomy-studio/shared';
import type { Run, RunEvent } from '@autonomy-studio/shared';
import { formatTimestamp, type DisplayTimeZone } from '../../lib/displayTime';
import type { NodeActivity } from './runSummary';

/**
 * Epoch-ms → a date and time in the viewer's display zone (#1484), or an
 * em-dash for a null (not-yet) timestamp. For a time inside a SENTENCE; a time
 * that stands alone in the page renders as `<When>`, which adds the relative
 * time on hover. The zone is required so no caller can quietly show the
 * browser's zone instead of the one the viewer chose.
 */
export function formatWhen(ms: number | null, zone: DisplayTimeZone): string {
  return ms === null ? '—' : formatTimestamp(ms, zone);
}

/** #1394 OR3 — a count, thousands-grouped in one fixed locale so a card reads
 * the same on every machine. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * A span in ms, in the ONE duration format (#1484 principle 4): under a minute
 * it is seconds to the millisecond with trailing zeros dropped (`1.234s`,
 * `0.82s`, `30s`, `0s`); then the two most significant units (`2m 03s`,
 * `1h 04m`). One unit below a minute, rather than switching to `820ms`, so a
 * column of durations compares by eye.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const whole = Math.round(ms);
  if (whole < 60_000) return `${(whole / 1_000).toFixed(3).replace(/\.?0+$/, '')}s`;
  const totalSeconds = Math.floor(whole / 1_000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
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
  return formatLiveElapsed(run.startedAt, now);
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
 *    measured a span for them — they hold NEITHER stamp, since `closeSpan`
 *    declines to write an end for a span that never opened. `0ms` here would
 *    state a measurement nobody took: the difference between "instant" and
 *    "not measured", and only one of them is true.
 * 2. **No end stamp.** The attempt has not settled (or the run died mid-flight
 *    and never will). This function has no clock, so it cannot say how long
 *    so far — and a figure recomputed only when a FRAME lands would sit at
 *    ~0ms for the node an operator actually watches (dispatched, grinding,
 *    emitting nothing), because its dispatch IS the last frame. A wrong number
 *    is worse than an absent one, which is the whole premise of #867. The live
 *    counter is #890's `NodeDuration`, which owns a clock and decides when
 *    ticking is honest; this stays the settled answer it falls back to.
 *
 * The number is WALL CLOCK for the latest attempt, from start to settle. That
 * INCLUDES a `wait`/`webhook` park (for those nodes waiting is the work) and
 * excludes time held between retries (the hold sits between two spans). It is
 * deliberately not called execution time, and it is not
 * `activity.captured.latencyMs` — that is one provider call's wall time, a
 * different number on a different scope.
 */
export function formatNodeDuration(node: Pick<NodeActivity, 'startedAtMs' | 'endedAtMs'>): string {
  return isMeasurableSpan(node) ? formatElapsed(node.endedAtMs - node.startedAtMs) : '—';
}

/**
 * Whether a start/end pair states a duration at all — the predicate behind the
 * em-dash above, exported because U12a (#1007) needs the same question answered
 * as a BOOLEAN (a bar's width, and whether an instant belongs on the axis) and a
 * second copy of the rule is how the two surfaces would come to disagree about
 * what a corrupt log looks like.
 *
 * A NEGATIVE span is a corrupt log, not a fast node: both stamps are
 * `Date.now()` taken by one single-writer append path, so an end before its
 * start means the wall clock stepped backwards. Clamping it to `0ms` would
 * print exactly the measurement-nobody-took `formatNodeDuration` refuses two
 * paragraphs above, and would hide the corruption behind a plausible number.
 * (`formatRunDuration` clamps because its inputs are two DB columns written by
 * different paths — a different question, deliberately left alone.)
 *
 * A TYPE PREDICATE rather than a `boolean`, and generic so it narrows whatever
 * it was handed rather than widening it to the bare pair. Every caller subtracts
 * the two fields immediately after asking, and while it returned `boolean` each
 * one needed a `!` — an assertion that was only sound because the reader had
 * gone and read this body. Now the checker proves it, and a future edit that
 * stopped guaranteeing non-nullness here would fail at those call sites instead
 * of silently licensing `undefined - undefined`, i.e. `NaN`.
 */
export function isMeasurableSpan<
  T extends { startedAtMs: number | undefined; endedAtMs: number | undefined },
>(span: T): span is T & { startedAtMs: number; endedAtMs: number } {
  if (span.startedAtMs === undefined || span.endedAtMs === undefined) return false;
  return span.endedAtMs >= span.startedAtMs;
}

/**
 * #890 — the start a LIVE counter may count from, or `undefined` when there is
 * no span it could honestly count.
 *
 * An open span on the canvas node itself qualifies: a start stamp, no end. A
 * span opened by a foreach ITEM (`w@2`) does not, even though its scalars look
 * the same. Every item's dispatch overwrites the row's one start
 * (`deriveNodeActivity`'s `openSpan`), so a count from it would drop back to
 * zero on each new item while earlier items were still running — a number that
 * is neither item's runtime nor the node's. That row keeps the em-dash, as its
 * settled form already does when a terminal lands from a different item.
 *
 * Whether the PAGE can hear a settle at all (socket open, replay complete, run
 * not terminal) is the caller's question, not this one's — this reads one row.
 */
export function liveSpanStart(
  node: Pick<NodeActivity, 'startedAtMs' | 'endedAtMs' | 'spans'>,
): number | undefined {
  if (node.startedAtMs === undefined || node.endedAtMs !== undefined) return undefined;
  if (node.spans[node.spans.length - 1]?.instanceId !== undefined) return undefined;
  return node.startedAtMs;
}

/**
 * #890 — how long an unsettled attempt has been running, against the caller's
 * clock, marked "so far" in the same words `formatRunDuration` uses for a run.
 *
 * Under a second it says `<1s` rather than `437ms`: the counter ticks once a
 * second, so a millisecond figure would be stale the moment it rendered and
 * would change UNIT on the next tick.
 *
 * It CLAMPS, which `isMeasurableSpan` above refuses to do for a settled span,
 * and the two causes differ. A settled span's two stamps come from one
 * single-writer append path, so an end before its start is a corrupt log and is
 * reported as one. Here the start is the server's stamp and `now` is the
 * browser's, so a negative difference is clock SKEW between two machines (or a
 * tick up to a second old meeting a just-dispatched attempt) — not a finding
 * about the log. The residual cost is accepted exactly as the runs list accepts
 * it, in both directions: a client clock running AHEAD inflates the figure by
 * the skew, and one running BEHIND holds it at `<1s` for the length of the skew
 * before it starts counting (short by the skew thereafter). For the local-first
 * install the two clocks are the same machine's.
 */
export function formatLiveElapsed(startedAtMs: number, now: number): string {
  const ms = Math.max(0, now - startedAtMs);
  return `${ms < 1_000 ? '<1s' : formatAge(ms)} so far`;
}

/**
 * A span measured against a CLOCK — an age, a countdown, a live counter — in
 * the duration format but to the whole second. Its other end is `Date.now()`
 * at the last render, so milliseconds would be precision the figure does not
 * have, and would change on every render.
 */
export function formatAge(ms: number): string {
  return formatElapsed(Math.floor(Math.max(0, ms) / 1_000) * 1_000);
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
  /* #996 M6 (#1162, data-movement spec §2.1) — WHERE a dataset-bound dispatch
     resolved to. §2.1's compensating control is that "the run log says where it
     actually wrote", and this feed is the run log; it is also the only surface
     that keeps the address PER ATTEMPT, since the node drill-in folds to the
     last dispatch by design.

     Read through the event's OWN schema rather than duck-typed. Every other
     field here is a string that `push` can check inline, and this one is an
     object — so the alternative is a hand-rolled shape check that would be a
     second, drifting authority on an address. `safeParse` keeps the stated
     contract exactly: an odd payload glosses to nothing instead of throwing. */
  const address = (v: unknown): string | undefined => {
    const parsed = DatasetAddressSchema.safeParse(v);
    return parsed.success ? describeDatasetAddress(parsed.data) : undefined;
  };
  const addresses = p.datasetAddresses;
  if (typeof addresses === 'object' && addresses !== null) {
    const ends = addresses as { source?: unknown; sink?: unknown };
    push('source', address(ends.source));
    push('sink', address(ends.sink));
  }
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

/**
 * A logged value as compact JSON, total over `unknown`: a string comes back
 * QUOTED, and a value JSON cannot express falls back to `String`. The whole
 * text, uncapped; a caller bounds it (`formatOutputValue`, `CappedValue`).
 */
export function jsonText(value: unknown): string {
  try {
    // `undefined` (and a function) stringify to `undefined`, not a string.
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A `bigint`, or a cycle — neither reaches here through a parsed event,
    // but a formatter must not be the thing that crashes the run page.
    return String(value);
  }
}

/** The cap on a streamed output value's inline rendering, in UTF-16 units. */
export const MAX_INLINE_OUTPUT_CHARS = 80;

/**
 * #1299 — a streamed `node.output` value as ONE bounded line, for the run
 * table's live cell and the drill-in's "latest" reading.
 *
 * Bounded because `node.output.value` is `z.unknown()`: a copy's progress tick
 * is a small object, but nothing stops an adapter streaming a large one, and
 * this renders inline in a table row. A string renders bare (JSON would wrap it
 * in quotes); anything else as compact JSON. The cut never splits a surrogate
 * pair (`surrogateSafeCut`, from shared since #605 — the server's capture
 * budget cuts with it too) and says it was cut.
 */
export function formatOutputValue(value: unknown): string {
  const text = typeof value === 'string' ? value : jsonText(value);
  if (text.length <= MAX_INLINE_OUTPUT_CHARS) return text;
  return `${text.slice(0, surrogateSafeCut(text, MAX_INLINE_OUTPUT_CHARS))}…`;
}
