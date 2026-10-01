import { fieldAttrs, type FieldValidation } from '../../lib/form/fieldValidation';

/** What a trigger mode editor needs of the form's validation to key its controls. */
export type FieldSlots = Pick<FieldValidation, 'errorFor' | 'attrsFor'>;

/**
 * #1396 — a mode editor's controls as fields of the trigger form. A control is
 * keyed by the payload path of what it authors (`recurrence.schedule.hours`),
 * the key a client check and a server refusal share. `base` is the editor's
 * `useId`, for the error lines' ids. With no `prefix` the path is the key
 * (`runWindows`).
 */
export function editorFields(validation: FieldSlots, base: string, prefix?: string) {
  const key = (path: string) => (prefix === undefined ? path : `${prefix}.${path}`);
  const errorId = (path: string) => `${base}-${path}`;
  return {
    /** Spread on the control. */
    attrs: (path: string) => validation.attrsFor(key(path), errorId(path)),
    /** Spread on a `<fieldset>` of controls (ARIA allows no `aria-invalid` on a group). */
    groupAttrs: (path: string) =>
      fieldAttrs({
        key: key(path),
        error: validation.errorFor(key(path)),
        errorId: errorId(path),
        group: true,
      }),
    /** Spread on the control's `FieldError` slot. */
    errorProps: (path: string) => ({ id: errorId(path), message: validation.errorFor(key(path)) }),
  };
}
