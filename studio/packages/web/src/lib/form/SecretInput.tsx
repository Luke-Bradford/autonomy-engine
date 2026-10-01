import { useState, type ReactNode } from 'react';
import type { fieldAttrs } from './fieldValidation';

/**
 * #1396 — a secret's input, with the Show/Hide toggle every secret field has
 * (`studio/docs/ui-patterns.md`). The toggle is named for what it does next,
 * and sits BESIDE the label, never inside it, so it never joins the input's
 * accessible name. Hidden again whenever the form remounts.
 *
 * `field` makes the input a field of the form's inline validation (`fieldAttrs`);
 * the page renders its `FieldError` after this. Leaving the input for the toggle
 * is leaving the field, so it is checked then.
 */
export function SecretInput({
  label,
  value,
  onChange,
  placeholder,
  required = false,
  field,
}: {
  label: ReactNode;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  required?: boolean;
  field?: ReturnType<typeof fieldAttrs>;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="secret-field">
      <label>
        {label}
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          required={required}
          {...field}
        />
      </label>
      <button
        type="button"
        aria-label={shown ? 'Hide secret' : 'Show secret'}
        onClick={() => setShown((was) => !was)}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
