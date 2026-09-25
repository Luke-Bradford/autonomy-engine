import type { ReactNode } from 'react';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import { ExpressionPicker } from './ExpressionPicker';
import { useCaretInsert } from './useCaretInsert';

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
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  picker: FieldPicker | undefined;
  /** Completes the toggle's name, "Insert reference into …". */
  pickerName: string;
  target: PickerTarget;
  /** Content after the input, still inside the label (a hint that names it). */
  after?: ReactNode;
  children: ReactNode;
}) {
  const {
    ref: inputRef,
    onSelect,
    insert: insertAtCaret,
    wrapOptions,
  } = useCaretInsert<HTMLInputElement>();
  return (
    <div className="config-field">
      <label>
        {children}
        <input
          ref={inputRef}
          value={value}
          onSelect={onSelect}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {after}
      </label>
      {picker && (
        <ExpressionPicker
          fieldName={pickerName}
          describe={picker.describe}
          resolve={() => picker.resolve(target)}
          onSelect={(insert, mode) => onChange(insertAtCaret(value, insert, mode))}
          wrap={{
            value,
            resolve: () =>
              wrapOptions(value, (span) => picker.wraps(target, value, span), onChange),
          }}
        />
      )}
    </div>
  );
}
