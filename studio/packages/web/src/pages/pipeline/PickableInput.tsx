import { useId, type ReactNode } from 'react';
import { AboutHelp } from '../../lib/HelpDisclosure';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import { ExpressionPicker } from './ExpressionPicker';
import { fieldPickerProps, useCaretInsert } from './useCaretInsert';

/**
 * One text input that can take the U8a flyout. A component rather than inline
 * markup because the caret state is a hook, and the argument rows are a list.
 *
 * The flyout is a SIBLING of the `<label>`, not a child: a button inside the
 * label would join the input's accessible name (see `ConfigFieldControl`).
 *
 * Shared by the call editor's argument rows and the node's parameter-override
 * rows (#1304). It is one of the two text+flyout wrappers #1286 records. The
 * override editor reuses it rather than adding a third.
 */
export function PickableInput({
  value,
  onChange,
  placeholder,
  picker,
  pickerName,
  target,
  after,
  about,
  required = false,
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  picker: FieldPicker | undefined;
  /** Completes the toggle's name, "Insert reference into …". */
  pickerName: string;
  /** Where a picked reference goes; required for the flyout to show. */
  target?: PickerTarget | undefined;
  /** Content after the input, still inside the label (a hint that names it). */
  after?: ReactNode;
  /**
   * #1694 OR42 — what the field means, behind a `?` beside it (labels, not
   * prose). A sibling of the label, as the flyout is, and the input's
   * description.
   */
  about?: { name: string; note: ReactNode };
  /** The value must be given: `aria-required`, beside the label's `RequiredMark`. */
  required?: boolean;
  children: ReactNode;
}) {
  const { ref, onSelect, insert, functionOptions } = useCaretInsert<HTMLInputElement>();
  const aboutId = useId();
  return (
    <div className="config-field">
      <label>
        {children}
        <input
          ref={ref}
          value={value}
          onSelect={onSelect}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-required={required || undefined}
          aria-describedby={about === undefined ? undefined : aboutId}
        />
        {after}
      </label>
      {about !== undefined && (
        <AboutHelp name={about.name} noteId={aboutId}>
          {about.note}
        </AboutHelp>
      )}
      {picker && target && (
        <ExpressionPicker
          fieldName={pickerName}
          {...fieldPickerProps({ insert, functionOptions }, picker, target, value, onChange)}
        />
      )}
    </div>
  );
}
