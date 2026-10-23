import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LabelledControl } from '../../lib/LabelledControl';
import { UnitLabel, WithUnit } from '../../lib/form/UnitInput';
import { titleWithUnit } from '../../lib/form/unit';
import { FieldError } from '../../lib/form/FieldError';
import { joinIds } from '../../lib/form/fieldValidation';

export type DraftNumberParse<V extends number | undefined> =
  { ok: true; value: V } | { ok: false; reason: string };

/**
 * #1315 — one whole-number field that holds a DRAFT and commits on blur: the
 * back-edge bounce cap and the node run policy's numbers. Each caller supplies
 * only its PARSE rule (the bounce cap requires a value; a policy field reads
 * blank as unset). A further draft/commit number field belongs here too, not
 * in a third copy.
 *
 * A numeric field cannot commit per keystroke: clearing it to retype gives
 * `''`, which `Number('')` reads as `0` — a legal, silently different value.
 * It is a TEXT input for `ConfigFieldControl`'s reason: a `type="number"`
 * input reports text it rejects as `''`, which a blank-means-unset field would
 * read as "delete the setting". A refused value KEEPS the operator's text on
 * screen and says why, rather than reverting and losing what they typed.
 *
 * `parse` must round-trip the stored value — `parse(format(stored))` yields
 * `stored` — because a blur on the untouched text is not parsed at all.
 * `format` is `String` unless the field shows its value another way (#1680: a
 * timeout as `D.HH:MM:SS`).
 */
export function DraftNumberField<V extends number | undefined>({
  label,
  stored,
  parse,
  onCommit,
  about,
  placeholder,
  unit,
  errorLine,
  format = String,
  inputMode = 'numeric',
}: {
  /** The title alone; `unit` is drawn as the box's suffix (#1694 OR42 item 5). */
  label: string;
  stored: number | undefined;
  parse: (raw: string) => DraftNumberParse<V>;
  onCommit: (value: V) => void;
  /** What the field means, behind a `?` beside its label (#1594 OR40 S3c-2). */
  about: ReactNode;
  placeholder?: string;
  /** "seconds": out of the label's sight, in its name and the `?`'s ("Timeout (seconds)"). */
  unit?: string;
  /**
   * #1694 OR42 item 5 — a SHARED reserved error line for a group of fields
   * (`FieldErrorLine`). Given, the field reserves no line of its own and writes
   * its error there, after its name; `null` while that line has not mounted.
   * Left out, the field keeps its own slot under it (a field on its own).
   */
  errorLine?: HTMLElement | null;
  /** The stored value as shown; `parse` must read it back unchanged. */
  format?: (stored: number) => string;
  /** `text` for a value typed with `:` and `.`, which a numeric keypad lacks. */
  inputMode?: 'numeric' | 'text';
}) {
  const text = stored === undefined ? '' : format(stored);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  /* Re-seed when the STORED value changes underneath the draft. Callers key the
     panel by element id, so switching elements remounts; an undo changes the
     value of the SAME element, which remounts nothing, and without this the
     field would go on showing the value the operator had just undone.
     Render-phase derived state, not an effect — `NodePanel`'s precedent, which
     this repo's React 19 lint permits where `useEffect` + setState would not. */
  const [synced, setSynced] = useState(text);
  if (synced !== text) {
    setSynced(text);
    setDraft(text);
    setError(null);
  }

  function commit(raw: string) {
    // A blur that changed nothing must not write — tabbing THROUGH the field
    // would otherwise dirty an untouched doc — and must not be parsed either:
    // a required field that is stored ABSENT (a back-edge with no cap) would
    // otherwise shout at an operator who only tabbed past it.
    //
    // It must still CLEAR a standing error, and that ordering is the point:
    // type `1.5`, blur (error shown), retype the original, blur — skipping this
    // would leave the banner asserting "not a whole number" over a field showing
    // a valid, unchanged value. The write is what a no-op blur skips, not the
    // acknowledgement that the value on screen is now fine.
    if (raw === text) {
      setError(null);
      return;
    }
    const parsed = parse(raw);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(null);
    // Different text, same value (` 6 ` over a stored 6): still no write.
    if (parsed.value === stored) return;
    onCommit(parsed.value);
  }

  return (
    <>
      <LabelledControl
        label={<UnitLabel title={label} unit={unit} />}
        about={{ name: titleWithUnit(label, unit), note: about }}
      >
        {(id, describedBy) => (
          <WithUnit unit={unit}>
            <input
              id={id}
              type="text"
              className="number-input"
              inputMode={inputMode}
              spellCheck={false}
              placeholder={placeholder}
              value={draft}
              aria-invalid={error !== null}
              aria-describedby={joinIds(error !== null ? errorId : undefined, describedBy)}
              onChange={(e) => {
                const raw = e.target.value;
                setDraft(raw);
                // #1393 — a standing error clears the moment the text is fine
                // again, not on the next blur: an operator who has already fixed
                // the value should not go on reading that it is wrong. Only ever
                // CLEARS here; a new error is still raised by blur alone, so
                // typing through an intermediate value does not shout.
                if (error !== null && (raw === text || parse(raw).ok)) setError(null);
              }}
              onBlur={(e) => commit(e.target.value)}
            />
          </WithUnit>
        )}
      </LabelledControl>
      {errorLine === undefined ? (
        /* #1393 — a RESERVED slot, always mounted and a line tall, so an error
           arriving does not push every field below it down. It used to REPLACE
           the hint, which moved them by the difference in height. The alert is
           only the populated line inside: an empty `role="alert"` would still
           be found by every page-wide alert query. */
        <FieldError id={errorId} message={error} role="alert" />
      ) : (
        error !== null &&
        errorLine !== null &&
        createPortal(
          // Named, since it no longer sits under its field: "name: message",
          // as a drawer form's summary reads (`FormErrors`).
          <p id={errorId} className="error" role="alert">
            {`${label}: ${error}`}
          </p>,
          errorLine,
        )
      )}
    </>
  );
}
