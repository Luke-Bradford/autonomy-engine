import { useId } from 'react';
import type { ReactNode } from 'react';
import { HelpDisclosure } from './HelpDisclosure';

/**
 * A `<select>` or `<textarea>` with its label, paired by `htmlFor`/`id` rather
 * than WRAPPED (#1227). Both controls render their content as child text nodes
 * — every option of a select, a controlled textarea's value — so a wrapping
 * label's text is `name + content`. Playwright's `getByLabel('x', { exact: true })`
 * then resolves while the field is empty and silently stops matching once it
 * holds anything, and the non-exact form can match on another field's VALUE.
 * The `no-restricted-syntax` rule in `eslint.config.js` refuses the wrap.
 *
 * The render-prop hands the control its id, which is what lets a site inside a
 * `.map()` pair its controls without calling `useId` in a loop. The wrapper is a
 * `div.labelled-control`, which the stylesheet lays out as each context laid out
 * the wrapping `<label>` it replaced (a stacked form row; the AI page's inline
 * picker; a config field's own `.config-field` rhythm) — `e2e/labelled-control`
 * pins all three. `<input>` needs none of this: its value is an attribute.
 */
export function LabelledControl({
  label,
  hint,
  help,
  about,
  className,
  children,
}: {
  label: ReactNode;
  /**
   * #1413 — a line under the control saying what the current choice means (a
   * Kind picker's description). Its id leads the render-prop's second
   * argument, the control's `aria-describedby`.
   */
  hint?: string;
  /**
   * #1477 OR29 — a `?` (a `HelpDisclosure`) beside the label, for a field whose
   * explanation sits behind it rather than under the control. A SIBLING of the
   * label, in a head row with it: inside the label, the `?`'s name would join
   * the control's, and a `<details>` may not sit in a label anyway.
   */
  help?: ReactNode;
  /**
   * #1594 OR40 S3c-2 — what the field is FOR, behind a `?` beside its label
   * (labels, not prose): the `help` slot built here, named "About {name}", so
   * a site needs no ids of its own. Its note joins the render-prop's second
   * argument, so the control's description is unchanged by the move. A note
   * about the field's current STATE (a preview, a refusal, an advisory) is not
   * this: it stays a visible line, because it is not there to be looked up.
   */
  about?: { name: string; note: ReactNode };
  className?: string;
  /** The second argument is the control's `aria-describedby`: the hint, then the note. */
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  const aboutId = useId();
  const describedBy =
    [hint === undefined ? undefined : hintId, about === undefined ? undefined : aboutId]
      .filter((each) => each !== undefined)
      .join(' ') || undefined;
  const helpSlot =
    about === undefined ? (
      help
    ) : (
      <HelpDisclosure label={`About ${about.name}`} noteId={aboutId} inline>
        {about.note}
      </HelpDisclosure>
    );
  return (
    <div className={className === undefined ? 'labelled-control' : `labelled-control ${className}`}>
      {helpSlot === undefined ? (
        <label htmlFor={id}>{label}</label>
      ) : (
        <div className="labelled-control__head help-row">
          <label htmlFor={id}>{label}</label>
          {helpSlot}
        </div>
      )}
      {children(id, describedBy)}
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
