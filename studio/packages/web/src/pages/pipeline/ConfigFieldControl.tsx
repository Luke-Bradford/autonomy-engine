import { useEffect, useRef } from 'react';
import type { RefSuggestion } from '@autonomy-studio/shared';
import type { ConfigField } from './configForm';
import { ExpressionPicker } from './ExpressionPicker';
import { applyInsert, type InsertMode } from './expressionInsert';

/**
 * Everything the U8a flyout needs that only the OWNING panel can supply: the
 * references legal at this node, how to name them, and how to probe a field's
 * shape. Passed as one optional object so a panel with no expression context
 * (`ContainerPanel`, whose container fields are #864) simply omits it.
 */
export type FieldPicker = {
  suggestions: RefSuggestion[];
  describe: (suggestion: RefSuggestion) => string;
  resolveMode: (fieldName: string) => InsertMode;
};

/**
 * One derived config control (U7).
 *
 * Every string field renders as a `<textarea>` rather than an `<input>`, and that
 * is a TRADEOFF taken knowingly rather than the only option. Any string setting
 * here may hold a multi-line `${}` expression or prose (`prompt`, `body`,
 * `content`, `task`), and nothing in a Zod `z.string()` distinguishes those from
 * a short one like `url` or `method` — so the uniform choice serves the fields
 * that need it and costs the short ones some vertical space. The alternatives
 * both have a real price: a per-field-name list of which strings are "long" is
 * the magic-string table that deriving the form from the schema exists to avoid,
 * and switching element on the CURRENT value's length would move focus as the
 * author types. A presentation hint on the schema is the principled fix if the
 * space ever bothers anyone (#852).
 *
 * The label carries the field NAME, not a prettified one: the name is what the
 * author writes in a `${nodes.x.config…}` reference and what the server's
 * validation errors cite, so renaming it for display would break the one thread
 * connecting the form, the doc and the error message.
 */
export function ConfigFieldControl({
  field,
  value,
  onChange,
  picker,
}: {
  field: ConfigField;
  value: string | boolean;
  onChange: (next: string | boolean) => void;
  picker?: FieldPicker;
}) {
  const label = field.optional ? `${field.name} (optional)` : field.name;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret must land after an insert. The textarea is CONTROLLED, so
  // the new value has to round-trip through the owner's state before the DOM
  // selection can be moved — setting it inline would be overwritten by the
  // re-render. Held in a ref rather than state so restoring it does not itself
  // cause one.
  const caret = useRef<number | null>(null);
  useEffect(() => {
    const at = caret.current;
    if (at === null || textareaRef.current === null) return;
    caret.current = null;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(at, at);
  });

  if (field.kind === 'boolean') {
    return (
      <label className="contract-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (field.kind === 'enum') {
    return (
      <label>
        {label}
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">— none —</option>
          {(field.enumOptions ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === 'number') {
    // A TEXT input, not `type="number"`: a number input reports an unparseable
    // entry as the empty string, which this form reads as "not set" — so a typo
    // would silently DELETE the setting instead of reporting "must be a number".
    return (
      <label>
        {`${label} — number`}
        <input
          type="text"
          inputMode="decimal"
          value={typeof value === 'string' ? value : ''}
          spellCheck={false}
          placeholder={field.defaultText}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  const hint = field.kind === 'json' ? 'JSON' : field.kind === 'stringList' ? 'one per line' : null;
  const text = typeof value === 'string' ? value : '';

  return (
    <div className="config-field">
      <label>
        {hint === null ? label : `${label} — ${hint}`}
        <textarea
          ref={textareaRef}
          value={text}
          rows={field.kind === 'json' || field.kind === 'stringList' ? 4 : 2}
          spellCheck={false}
          placeholder={field.defaultText}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
      {/* A SIBLING of the label, not a child: a button inside a `<label>` still
          triggers the label's focus behaviour, which would fight the picker.

          NOT offered on a `json` field, and that is a refusal rather than an
          oversight. A `json` control parses its text with `JSON.parse` on apply
          (`configForm.parseFieldInput`), so a bare `${...}` — which is what the
          engine wants stored, and what every other field takes — is not valid
          JSON and the apply would simply fail. Inserting the QUOTED form instead
          would be right at a value slot and wrong inside an existing string
          literal, a distinction only a JSON-aware caret could make. So the
          control is withheld rather than made to offer a dead end; the four
          `llm_call` fields this most affects are getting richer editors under
          #852, and the expression half is noted in #864. */}
      {picker && field.kind !== 'json' && (
        <ExpressionPicker
          fieldName={field.name}
          suggestions={picker.suggestions}
          describe={picker.describe}
          resolveMode={() => picker.resolveMode(field.name)}
          onSelect={(insert, mode) => {
            // The selection survives the toggle click (focus moves, the caret
            // does not), so a mid-string insert lands where the author left it.
            const el = textareaRef.current;
            const next = applyInsert(
              text,
              el?.selectionStart ?? text.length,
              el?.selectionEnd ?? text.length,
              insert,
              mode,
            );
            caret.current = next.caret;
            onChange(next.value);
          }}
        />
      )}
    </div>
  );
}
