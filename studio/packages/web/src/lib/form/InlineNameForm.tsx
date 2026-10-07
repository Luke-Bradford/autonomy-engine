import type { ReactNode, Ref } from 'react';

interface InlineNameFormProps {
  /** The row's own class, which lays it out where it sits. */
  className: string;
  /** The input's accessible name, and its placeholder unless one is given. */
  label: string;
  placeholder?: string;
  value: string;
  busy: boolean;
  /** The submit button's text, e.g. `Rename`. */
  submitLabel: string;
  /** Allow submitting an empty value (a move's "no folder"); a name must not be empty. */
  allowEmpty?: boolean;
  /** The id of a `<datalist>` passed as `children`, for suggestions. */
  listId?: string;
  children?: ReactNode;
  /** The input, for a caller that must put focus back after a refused submit. */
  inputRef?: Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * One name typed in place: an input, a submit and Cancel, with Escape to
 * cancel. Shared by the resource tree's create / duplicate / rename / move row
 * and the version history's "Clone vN as new pipeline", and styled once
 * (`.inline-name-form`).
 *
 * A row rather than a Fluent `Dialog`: naming something in place is what a
 * resources tree does, and a `Dialog` import spends the U0 bundle budget that
 * #1397 paid only where a modal question IS the interaction.
 *
 * `autoFocus` is correct here and not the usual anti-pattern: the row only
 * exists because the user just asked for it, and its whole purpose is to be
 * typed into.
 */
export function InlineNameForm({
  className,
  label,
  placeholder,
  value,
  busy,
  submitLabel,
  allowEmpty = false,
  listId,
  children,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: InlineNameFormProps) {
  return (
    <form
      className={`inline-name-form ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        aria-label={label}
        placeholder={placeholder ?? label}
        list={listId}
        value={value}
        /* Read-only, not disabled, while busy: a disabled input drops focus,
           and a refused submit leaves the row open to be corrected. */
        readOnly={busy}
        aria-busy={busy}
        autoFocus
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          /* Escape cancels. `stopPropagation` so it does not also travel up to
             an ancestor that treats Escape as "close me" (the version history
             column sits beside such an editor). */
          if (e.key === 'Escape') {
            e.stopPropagation();
            // Not mid-submit: the read-only input still hears keys.
            if (!busy) onCancel();
          }
        }}
      />
      {children}
      <button type="submit" disabled={busy || (!allowEmpty && value.trim() === '')}>
        {submitLabel}
      </button>
      <button type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </form>
  );
}
