import { useState } from 'react';
import type { ReactNode } from 'react';
import { LabelledControl } from '../../lib/LabelledControl';

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
 */
export function DraftNumberField<V extends number | undefined>({
  label,
  stored,
  parse,
  onCommit,
  hint,
  placeholder,
}: {
  label: string;
  stored: number | undefined;
  parse: (raw: string) => DraftNumberParse<V>;
  onCommit: (value: V) => void;
  hint: ReactNode;
  placeholder?: string;
}) {
  const text = stored === undefined ? '' : String(stored);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
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
      <LabelledControl label={label}>
        {(id) => (
          <input
            id={id}
            type="text"
            inputMode="numeric"
            spellCheck={false}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
          />
        )}
      </LabelledControl>
      {error !== null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <p className="page-hint">{hint}</p>
      )}
    </>
  );
}
