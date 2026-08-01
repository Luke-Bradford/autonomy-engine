import { EventConfigSchema, type EventConfig } from '@autonomy-studio/shared';

/**
 * #439 U14b remainder (#854) — the PURE half of the event-subscription editor.
 *
 * `EventConfigSchema` is one required field (`name`) plus a
 * `.catchall(z.unknown())`, so a subscription authored through the API can carry
 * keys this form has no control for. The form holds them VERBATIM and writes
 * them back: dropping them on an unrelated edit — renaming the trigger, say —
 * would be silent data loss of exactly the shape #473 was.
 *
 * Validation is delegated WHOLE to `EventConfigSchema` rather than restated, so
 * the client refuses precisely what the write boundary refuses.
 */
export interface EventFormState {
  /** The one editable field; `''` = the subscription is NOT configured. */
  name: string;
  /**
   * Every catchall key of the loaded subscription except `name`. Not editable
   * here — held only so a save cannot destroy it.
   */
  extras: Record<string, unknown>;
}

export function blankEventForm(): EventFormState {
  return { name: '', extras: {} };
}

/** Load a stored subscription into the editor, splitting the one editable field
 * from the catchall keys the editor preserves but does not show. */
export function eventToForm(event: EventConfig): EventFormState {
  const { name, ...extras } = event;
  return { name, extras };
}

export type EventConversion =
  | { ok: true; event: EventConfig | null }
  | { ok: false; reason: string };

/**
 * Build an `EventConfig` from the form, or report why it cannot be.
 *
 * A blank name is an ABSENT subscription (`null`), never `{name:''}` — the
 * schema's `.min(1)` refuses the latter, so an empty string is not a benign
 * "nothing chosen". Clearing the name therefore CLEARS the subscription, extras
 * included; that is a deliberate destructive edit, not an incidental one, and
 * the server refuses the result only if the trigger is also enabled.
 */
export function formToEvent(form: EventFormState): EventConversion {
  const name = form.name.trim();
  if (name === '') return { ok: true, event: null };
  // `name` last so the edited value always wins over a stale catchall copy.
  const parsed = EventConfigSchema.safeParse({ ...form.extras, name });
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
    };
  }
  return { ok: true, event: parsed.data };
}
