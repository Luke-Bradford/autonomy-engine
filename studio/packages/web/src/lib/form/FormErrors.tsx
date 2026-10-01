import type { MouseEvent } from 'react';
import { focusField, type FieldValidation } from './fieldValidation';

/**
 * #1396 — the drawer form's ONE alert: a plain message (a server or mode-toggle
 * refusal that names no field) and, after a submit, a summary of every invalid
 * field, each a button that takes focus to it.
 *
 * In the FOOTER, not at the top of the form as #1396 first sketched: the body
 * scrolls, and ui-patterns.md already puts a refused Save "in view where Save
 * was pressed". Focus goes to the first invalid field anyway. One container,
 * because the specs (and assistive tech) expect one alert per form.
 *
 * The summary is derived from what is shown now, so fixing a field takes its
 * line out, and it goes when the last one does.
 */
export function FormErrors({
  validation,
  message,
}: {
  validation: FieldValidation;
  message: string | null;
}) {
  const items = validation.attempted ? validation.shown : [];
  const { notice } = validation;
  if (message === null && notice === null && items.length === 0) return null;
  const go = (key: string) => (event: MouseEvent<HTMLButtonElement>) => {
    const form = event.currentTarget.closest('form');
    if (form !== null) focusField(form, key);
  };
  return (
    <div role="alert" className="error form-errors">
      {message !== null && <p>{message}</p>}
      {notice !== null && <p>{notice}</p>}
      {items.length > 0 && (
        <>
          <p>{items.length === 1 ? 'Fix this field:' : `Fix these ${items.length} fields:`}</p>
          <ul>
            {items.map(({ key, message: text }) => (
              <li key={key}>
                <button type="button" className="form-errors-link" onClick={go(key)}>
                  {`${validation.labelOf(key) ?? key}: ${text}`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
