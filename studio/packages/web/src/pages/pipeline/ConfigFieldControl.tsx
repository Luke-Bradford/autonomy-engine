import type { ConfigField } from './configForm';

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
}: {
  field: ConfigField;
  value: string | boolean;
  onChange: (next: string | boolean) => void;
}) {
  const label = field.optional ? `${field.name} (optional)` : field.name;

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

  return (
    <label>
      {hint === null ? label : `${label} — ${hint}`}
      <textarea
        value={typeof value === 'string' ? value : ''}
        rows={field.kind === 'json' || field.kind === 'stringList' ? 4 : 2}
        spellCheck={false}
        placeholder={field.defaultText}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
