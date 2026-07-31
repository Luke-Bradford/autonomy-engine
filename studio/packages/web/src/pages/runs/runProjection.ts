import {
  EngineEventSchema,
  createEngine,
  type ContainerRunStatus,
  type Engine,
  type EngineDoc,
  type NodeRunStatus,
  type RunEvent,
  type RunState,
} from '@autonomy-studio/shared';

/**
 * U11 — the run monitor's DOC-AWARE projection.
 *
 * `runSummary.ts`'s `deriveNodeActivity` folds its own doc-free approximation
 * because the page could not reach the pipeline version. R1 changed that, so
 * this module folds the ENGINE's own reducer instead — the same
 * `createEngine(doc).projectRunState(events)` the driver runs — and the monitor
 * stops having a second, lossier opinion about what a node's status is.
 *
 * What the doc buys, concretely: `seedState()` seeds EVERY node in the doc as
 * `pending`, so a node that never dispatched is visible. The event-driven table
 * structurally cannot show one — no event was ever appended for it.
 */

/**
 * A projection either succeeded, or it did not happen. There is deliberately no
 * partial third state.
 *
 * `runSummary.ts` SKIPS an event whose payload fails `EngineEventSchema`
 * (`safeParse` → `continue`), which is safe there because each row independently
 * writes one cell of a table. It is NOT safe here. The reducer is a state
 * machine: drop `run.started` and `state.nodes` stays empty, and every later
 * `withNode` spreads an `undefined` — `createEngine`'s own docblock names that
 * failure ("the reads walk off the end — a TypeError out of the PURE reducer").
 * A hole folded into a state machine is not a slightly-wrong picture, it is an
 * arbitrary one, so an unparseable event abandons the whole projection and the
 * page falls back to the doc-free table with the reason on screen.
 */
export type RunProjection =
  | { ok: true; state: RunState }
  | { ok: false; reason: string };

/**
 * The carry between renders, so a live run does not refold its whole log per
 * frame. `useRunStream` appends a NEW array per event, and both existing folds
 * (`deriveNodeActivity`, `deriveRunLifecycle`) re-run over the full log every
 * time — O(n) per frame, O(n²) over a run. That is tolerable for a switch
 * writing into a mutable accumulator; it is not for `reduce`, which re-spreads
 * `nodes`/`outputs`/`containers` AND derives commands + diagnostics per event,
 * all of which this caller discards.
 *
 * The suffix fold is sound rather than merely faster: `useRunStream` dedupes by
 * `seq` and appends in ascending order, so `events` only ever GROWS by a suffix
 * for a given run. `foldRunProjection` re-checks that assumption (a shrunken log,
 * or a different doc, refolds from the seed) instead of trusting it.
 */
export interface ProjectionCarry {
  /** The state as of `count` events, or `null` before the first fold. */
  state: RunState | null;
  /** How many of `events` are already folded into `state`. */
  count: number;
  /** The doc the carry was folded against — a change invalidates it. */
  doc: EngineDoc | null;
}

export const EMPTY_CARRY: ProjectionCarry = { state: null, count: 0, doc: null };

/**
 * Fold `events` into a run state, reusing `carry` when it is a valid prefix.
 *
 * PURE — returns the next carry rather than mutating; the caller holds it in a
 * ref. `engine` must be the one built from `carry.doc`, which is why both are
 * passed together and compared by identity.
 */
export function foldRunProjection(
  engine: Engine,
  doc: EngineDoc,
  events: RunEvent[],
  carry: ProjectionCarry,
): { projection: RunProjection; carry: ProjectionCarry } {
  const reusable =
    carry.state !== null && carry.doc === doc && carry.count <= events.length ? carry : EMPTY_CARRY;

  let state = reusable.state ?? engine.seedState();
  for (let i = reusable.count; i < events.length; i += 1) {
    const envelope = events[i]!;
    const parsed = EngineEventSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      return {
        projection: {
          ok: false,
          reason: `event ${envelope.seq} (${envelope.type}) is not a valid engine event, so the graph cannot be projected`,
        },
        // The carry is abandoned too: a later render must not resume a fold from
        // a prefix that stops short of an event we know we cannot apply.
        carry: EMPTY_CARRY,
      };
    }
    state = engine.reduce(state, parsed.data).state;
  }

  return { projection: { ok: true, state }, carry: { state, count: events.length, doc } };
}

/**
 * The hue GROUP a status is drawn in. Ten node statuses share five palette
 * variables, so the groups are stated here once and the exact status is ALSO
 * rendered as text on the node — the colour narrows it to a family, the label
 * says which member, and nothing is silently collapsed.
 *
 * Chosen so the canvas and the run table cannot come to disagree
 * (`index.css` records the same commitment for the edge hues):
 *   - `neutral`  — nothing has happened to this node (`pending`, `ready`).
 *   - `running`  — the engine has dispatched it.
 *   - `holding`  — dispatched-and-parked: a retry backoff, a timer, an external
 *     callback, or a child run in flight. Distinct from `neutral` because the
 *     run IS advancing here; the old table collapsed three of these to one word.
 *   - `success` / `failure` — terminal.
 *   - `skipped` — terminal, but by ROUTING rather than execution. Grey like
 *     `neutral` and drawn DASHED, matching the settled edge encoding for a
 *     skipped edge, so "this did not run" reads the same everywhere.
 */
export type StatusTone = 'neutral' | 'running' | 'holding' | 'success' | 'failure' | 'skipped';

/**
 * Exhaustive BY CONSTRUCTION: `Record<NodeRunStatus, StatusTone>` fails to
 * compile the day the engine adds a status, which forces a deliberate choice
 * rather than a silent fallthrough to some default hue. (A `satisfies` on an
 * array would NOT catch a forgotten member — the engine's own `TERMINAL_NODE`
 * comment records that having been probed and found false.)
 */
const NODE_TONES: Record<NodeRunStatus, StatusTone> = {
  pending: 'neutral',
  ready: 'neutral',
  dispatched: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
  waiting: 'holding',
  retry_pending: 'holding',
  wait_pending: 'holding',
  external_wait_pending: 'holding',
};

/** Same construction for containers; `active` is their `dispatched`. */
const CONTAINER_TONES: Record<ContainerRunStatus, StatusTone> = {
  pending: 'neutral',
  active: 'running',
  success: 'success',
  failure: 'failure',
  skipped: 'skipped',
};

export function nodeStatusTone(status: NodeRunStatus): StatusTone {
  return NODE_TONES[status];
}

export function containerStatusTone(status: ContainerRunStatus): StatusTone {
  return CONTAINER_TONES[status];
}

/** Builds the engine for a doc. Thin, but it keeps the import in one place. */
export function engineForDoc(doc: EngineDoc): Engine {
  return createEngine(doc);
}
