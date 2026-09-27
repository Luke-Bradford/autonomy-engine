import { useState } from 'react';
import { useBusyAction } from '../../hooks/useBusyAction';
import { surrogateSafeCut } from '@autonomy-studio/shared';
import { jsonText, MAX_INLINE_OUTPUT_CHARS } from './format';

/**
 * #869 — the cap on serialized output characters kept in the DOM.
 *
 * `index.css` bounds `.node-detail-outputs` by HEIGHT, which stops the payload
 * taking over the panel but does nothing about the document: the whole string
 * was still serialized and still present. An agent node's `text` output is
 * realistically tens of KB and a `foreach` fan-in has no bound at all, so the
 * two bounds are not redundant — exactly the pairing `MAX_TOOL_ROWS` below
 * already makes with `.node-tool-calls`.
 *
 * Truncating on its own would be the WRONG fix, and that is why this is a
 * disclosure rather than a `slice`: the panel exists so an operator can read
 * what a node produced, and the tail is precisely what someone debugging a bad
 * output came for. So the remainder stays out of the DOM until it is ASKED
 * for, and the withholding is stated rather than trailed off — a payload that
 * merely stopped would read as the whole value, which is the silent-subset lie
 * `ToolCallSection` refuses for the same reason.
 */
const MAX_OUTPUT_CHARS = 4000;
/** The lone act `CappedValue` guards — see the `useBusyAction` note below. */
const COPY_KEY = 'copy';

/**
 * #869 — a serialized value, bounded by `MAX_OUTPUT_CHARS` with its tail behind
 * a disclosure and a copy of the WHOLE value. Lifted out of `OutputsSection` by
 * #844 V7 so a variable write's value, and a long value in the run's Variables
 * table, get the same bound rather than second copies of it (the class name and
 * the #869 notes above still say "output", which is where it began). The caller keys it by node identity, so its disclosure state never
 * carries from one node to the next.
 */
export function CappedValue({ id, text }: { id: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  /* `null` until a copy is attempted; then the OUTCOME, because a copy that
     silently did nothing is the same class of lie the cap exists to prevent —
     the operator would believe they hold the full value. */
  const [copyFailed, setCopyFailed] = useState<boolean | null>(null);
  /* Single-flight, because `copyFailed` is ONE slot and two overlapping writes
     would race to fill it — the winner being whichever settled last rather than
     whichever the operator asked for last. The reachable misreport is a stale
     "Could not copy" over a write that succeeded; fail-safe in direction, since
     it points at the disclosure that needs no clipboard, but still a lie about
     what happened, from the one control whose reason for existing is that a
     copy which silently did nothing must not read as one that worked.

     Guarding beats ordering here: with one attempt in flight there is only one
     outcome, so there is no ordering question left to get wrong. `useBusyAction`
     is the shared guard (#960) rather than a sixth hand-rolled one, and its ref
     is what makes it correct — two clicks in one tick both read the same stale
     `disabled` prop, because React has not re-rendered in between.

     Keyed by a constant: each caller keys its section by node identity, so an
     instance owns exactly one copy button and there is nothing to tell apart. */
  const copy = useBusyAction();
  const truncated = text.length > MAX_OUTPUT_CHARS;
  /* The cap counts UTF-16 CODE UNITS, which is what `.slice` and `.length`
     both count — but an astral character (an emoji in an agent's completion,
     CJK Extension B) is TWO of them, and `JSON.stringify` emits the pair raw
     rather than escaping it. A cap landing between the halves would mount a
     lone high surrogate, so the payload would end in a replacement glyph
     instead of ending where it was cut. Stepping back one unit is the whole
     fix: the withheld half is shown by the toggle like everything else after
     the cut, and the hint below reports the number actually mounted rather
     than the nominal cap, so the two never disagree. */
  const cut = truncated ? surrogateSafeCut(text, MAX_OUTPUT_CHARS) : MAX_OUTPUT_CHARS;
  const shown = truncated && !expanded ? text.slice(0, cut) : text;
  /* Read at render, not cached: `navigator.clipboard` is undefined outside a
     secure context, and offering a control that cannot work is worse than not
     offering one. */
  const canCopy = typeof navigator !== 'undefined' && navigator.clipboard !== undefined;
  return (
    <>
      <code className="node-detail-outputs" id={id}>
        {shown}
      </code>
      {truncated && (
        <>
          <p className="page-hint">
            {expanded
              ? `Showing all ${text.length} characters.`
              : `… showing the first ${cut} of ${text.length} characters.`}
          </p>
          {/* A real button, so the reveal is reachable by keyboard and not
              by pointer alone. It is local VIEW state — U28 keeps this
              monitor read-only and a disclosure dispatches nothing. */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? `Show first ${cut} characters` : `Show all ${text.length} characters`}
          </button>
          {/* Copies the WHOLE value, and deliberately does not depend on
              `expanded`.

              The disclosure alone is not enough, and the argument that it
              is has a hole worth recording so it is not re-made: selecting
              the block by hand while it is COLLAPSED copies the cut string,
              which is exactly the silent tail-loss #869 is about — the cap
              would have turned a display bound into a data one. So the
              reachable-by-selection path is only true after a click that
              changes what is displayed, and this offers the full value
              without that precondition.

              Feature-detected rather than assumed: `navigator.clipboard` is
              absent outside a secure context, and `writeText` can still
              reject under a permissions policy. Neither is treated as
              success — the button is not offered at all in the first case,
              and says so in the second, with the disclosure still there as
              the path that needs no API. */}
          {canCopy && (
            <button
              type="button"
              disabled={copy.active.has(COPY_KEY)}
              onClick={() => {
                void copy.run(COPY_KEY, () =>
                  /* Resolves either way: `run` re-throws whatever `act`
                     rejects with, and a refusal is already REPORTED here
                     rather than thrown. */
                  navigator.clipboard.writeText(text).then(
                    () => setCopyFailed(false),
                    () => setCopyFailed(true),
                  ),
                );
              }}
            >
              Copy all {text.length} characters
            </button>
          )}
          {copyFailed !== null && (
            <p className="page-hint" role="status">
              {copyFailed
                ? 'Could not copy — show all, then select and copy.'
                : 'Copied the full value.'}
            </p>
          )}
        </>
      )}
    </>
  );
}

/**
 * One value as JSON, so a string is shown QUOTED: an empty string would
 * otherwise be a blank cell, and a string could pass for a "no value" marker.
 * A short value stays inline; a longer one (an array an `append` has grown,
 * typically) gets the bounded block above, whose disclosure and copy reach the
 * whole value. Shared by the run page's Variables (#844 V7) and Global
 * parameters (GL5) tables, where the table is the only place the value is shown.
 */
export function InlineJsonValue({ id, value }: { id: string; value: unknown }) {
  const text = jsonText(value);
  return text.length <= MAX_INLINE_OUTPUT_CHARS ? (
    <code>{text}</code>
  ) : (
    <CappedValue id={id} text={text} />
  );
}
