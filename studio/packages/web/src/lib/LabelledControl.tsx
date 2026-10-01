import { useId } from 'react';
import type { ReactNode } from 'react';

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
  className,
  children,
}: {
  label: ReactNode;
  /**
   * #1413 — a line under the control saying what the current choice means (a
   * Kind picker's description). Its id is the render-prop's second argument,
   * for the control's `aria-describedby`; `undefined` when there is no hint.
   */
  hint?: ReactNode;
  className?: string;
  children: (id: string, hintId: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  const shownHintId = hint === undefined ? undefined : hintId;
  return (
    <div className={className === undefined ? 'labelled-control' : `labelled-control ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children(id, shownHintId)}
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}
