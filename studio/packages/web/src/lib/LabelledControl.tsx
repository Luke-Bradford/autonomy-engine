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
 * `div.labelled-control`, which the stylesheet lays out exactly as each context
 * laid out the bare `<label>` it replaces, so the conversion moves no pixels.
 * `<input>` needs none of this — its value is an attribute, not text.
 */
export function LabelledControl({
  label,
  className,
  children,
}: {
  label: ReactNode;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={className === undefined ? 'labelled-control' : `labelled-control ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
    </div>
  );
}
