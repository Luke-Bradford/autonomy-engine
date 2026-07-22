import { and, eq } from 'drizzle-orm';
import {
  NewTriggerSchema,
  RecurrenceWriteSchema,
  TriggerSchema,
  recurrenceToCron,
  type NewTrigger,
  type Recurrence,
  type Trigger,
  type TriggerMode,
} from '@autonomy-studio/shared';
import { triggers } from '../db/schema.js';
import { newId } from './ids.js';
import type { Db } from './types.js';

/**
 * #5 S5b-1 — the recurrence↔schedule derivation, the SINGLE write-path authority
 * for the two staying consistent. When a recurrence is set, `schedule` is a pure
 * DERIVED cache of `recurrenceToCron(recurrence)` (never co-authored), so the
 * firing chain's cron string (`isSchedulable`/`nextOccurrence`/`isRefFresh`)
 * can never drift from the authored recurrence. When recurrence is null,
 * `schedule` is the raw-cron escape-hatch as before. Applied by BOTH createTrigger
 * and updateTrigger — and thus import, which routes through createTrigger.
 */
function deriveSchedule(recurrence: Recurrence | null, rawSchedule: string | null): string | null {
  return recurrence !== null ? recurrenceToCron(recurrence) : rawSchedule;
}

/**
 * The effective stored `schedule` for an UPDATE, given the effective recurrence
 * and the patch. Honours PATCH semantics for the raw-cron half: `schedule` has no
 * default, so an OMITTED `patch.schedule` is `undefined` (keep existing) while an
 * explicit `null` clears it. Split on whether THIS patch touches `recurrence`:
 *   - recurrence UNTOUCHED (`patch.recurrence === undefined`): the derived cron is
 *     already correct on `existing` — do NOT recompute it; only the raw-cron half
 *     can change, and only for a trigger with no recurrence (the route rejects a
 *     raw `schedule` alongside a live recurrence).
 *   - recurrence SET/CHANGED → (re)derive the cron from it.
 *   - recurrence CLEARED (`null`) → drop the stale derived cron; follow the
 *     patch's raw `schedule` (or null) — never the old derived string.
 */
function resolveUpdateSchedule(
  existing: Trigger,
  patch: Partial<NewTrigger>,
  recurrence: Recurrence | null,
): string | null {
  if (patch.recurrence === undefined) {
    if (existing.recurrence !== null) return existing.schedule;
    return patch.schedule !== undefined ? patch.schedule : existing.schedule;
  }
  if (recurrence !== null) return recurrenceToCron(recurrence);
  return patch.schedule ?? null;
}

export function createTrigger(db: Db, input: NewTrigger): Trigger {
  const parsed = NewTriggerSchema.parse(input);
  // `recurrence` is `.nullable().optional()` on the write schema — an omitted
  // (undefined) recurrence is "none" (null), the raw-cron path.
  const recurrence = parsed.recurrence ?? null;
  const now = Date.now();
  const row: Trigger = {
    id: newId('trig'),
    ...parsed,
    recurrence,
    // #5 S8 — same 3-state write field as `recurrence`: omitted = "no
    // subscription" (null). The stored shape requires the key explicitly.
    event: parsed.event ?? null,
    // #5 S9 — same 3-state: omitted = "no window geometry" (null).
    window: parsed.window ?? null,
    schedule: deriveSchedule(recurrence, parsed.schedule),
    createdAt: now,
    updatedAt: now,
  };
  db.insert(triggers).values(row).run();
  return TriggerSchema.parse(row);
}

export function getTrigger(db: Db, id: string): Trigger | null {
  const row = db.select().from(triggers).where(eq(triggers.id, id)).get();
  return row ? TriggerSchema.parse(row) : null;
}

/** The 3-way verdict of {@link getParsedTrigger}: `missing` (no row) and
 * `unparseable` (row present, `TriggerSchema` rejects it) are DISTINCT — a
 * caller settling an alarm chain reports corruption differently from absence. */
export type ParsedTriggerRead =
  | { status: 'found'; trigger: Trigger }
  | { status: 'missing' }
  | { status: 'unparseable'; error: unknown };

/**
 * #637 — the single-row LENIENT read, symmetric with `listParsedTriggers`: a
 * corrupt/legacy/hand-edited row is a reported verdict, never a throw. The
 * scheduler's alarm handlers use this because a handler throw rolls back the
 * fire transaction, leaving the wakeup row `pending` — so one poison trigger
 * row would re-fire + error-log on EVERY clock tick, forever. (`getTrigger`
 * stays strict: a route surfacing a poison row as a 500 is right there.)
 */
export function getParsedTrigger(db: Db, id: string): ParsedTriggerRead {
  const row = db.select().from(triggers).where(eq(triggers.id, id)).get();
  if (!row) return { status: 'missing' };
  const result = TriggerSchema.safeParse(row);
  return result.success
    ? { status: 'found', trigger: result.data }
    : { status: 'unparseable', error: result.error };
}

export interface ListTriggersFilter {
  pipelineVersionId?: string;
  /** Filters in SQL, like `listConnections`/`listPipelines` — never loaded
   * then filtered in the route. */
  ownerId?: string;
  /** #5 S8 — SQL filter on the typed `mode` column (the events fan-out lists
   * `mode:'event'` rows; the per-name match happens on the parsed rows — a
   * `json_extract` on the `event` JSON buys nothing at this row count). */
  mode?: TriggerMode;
}

export function listTriggers(db: Db, filter: ListTriggersFilter = {}): Trigger[] {
  const conditions = [];
  if (filter.pipelineVersionId !== undefined) {
    conditions.push(eq(triggers.pipelineVersionId, filter.pipelineVersionId));
  }
  if (filter.ownerId !== undefined) {
    conditions.push(eq(triggers.ownerId, filter.ownerId));
  }
  if (filter.mode !== undefined) {
    conditions.push(eq(triggers.mode, filter.mode));
  }

  const rows =
    conditions.length > 0
      ? db
          .select()
          .from(triggers)
          .where(and(...conditions))
          .all()
      : db.select().from(triggers).all();
  return rows.map((row) => TriggerSchema.parse(row));
}

/**
 * Like `listTriggers()` with no filter, but RESILIENT: a row that fails schema
 * validation is skipped (and reported via `onSkip`) instead of throwing out the
 * whole list. The scheduler uses this so ONE corrupt/legacy/hand-edited trigger
 * row can't dark-out ALL scheduling — matching the per-cron isolation the
 * scheduler already gives a bad cron string. (The normal `listTriggers` stays
 * strict: a route surfacing a poison row as a 500 is the right behaviour there.)
 */
export function listParsedTriggers(
  db: Db,
  onSkip?: (id: unknown, err: unknown) => void,
): Trigger[] {
  const rows = db.select().from(triggers).all();
  const parsed: Trigger[] = [];
  for (const row of rows) {
    const result = TriggerSchema.safeParse(row);
    if (result.success) parsed.push(result.data);
    else onSkip?.((row as { id?: unknown }).id, result.error);
  }
  return parsed;
}

export function updateTrigger(db: Db, id: string, patch: Partial<NewTrigger>): Trigger | null {
  const existing = getTrigger(db, id);
  if (!existing) return null;
  // The write field's 3-state on `patch.recurrence`: `undefined` = untouched
  // (keep the already-parsed existing value), `null` = cleared, object = set.
  // A newly-SET recurrence is validated through `RecurrenceWriteSchema` — the
  // WRITE schema, NOT the lenient read one — so the repo INDEPENDENTLY enforces
  // the write-boundary invariants (interval=1, honoured/required schedule
  // fields), making it a true single write-path authority: a caller bypassing
  // the HTTP route (an admin script, a later refactor) is refused a
  // wrong-compiling recurrence (e.g. a `week` with no `weekDays` → daily) rather
  // than silently deriving a bad cron. It also normalizes the `z.input` shape
  // (interval optional) to the resolved `Recurrence` `recurrenceToCron` needs.
  // An untouched recurrence is already resolved+valid on `existing` (from
  // `getTrigger` → `TriggerSchema`), so it needs no reparse.
  const recurrence: Recurrence | null =
    patch.recurrence === undefined
      ? existing.recurrence
      : patch.recurrence === null
        ? null
        : RecurrenceWriteSchema.parse(patch.recurrence);
  const updated = TriggerSchema.parse({
    ...existing,
    ...patch,
    recurrence,
    schedule: resolveUpdateSchedule(existing, patch, recurrence),
    updatedAt: Date.now(),
  });
  db.update(triggers).set(updated).where(eq(triggers.id, id)).run();
  return updated;
}

export function deleteTrigger(db: Db, id: string): boolean {
  const result = db.delete(triggers).where(eq(triggers.id, id)).run();
  return result.changes > 0;
}
