import { LabelledControl } from '../../lib/LabelledControl';

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * U26 — one Monitor filter picker over an OPEN set of values (a pipeline, a
 * trigger, an annotation): "All …", the loaded options, and the orphan guard.
 * The closed vocabularies (status, window) stay plain selects: the URL reader
 * already drops a value outside them, so they can never be orphaned.
 *
 * The orphan guard. A `<select>` whose value matches no option renders the
 * FIRST one — so a link to a deleted pipeline, a retired annotation, or a render
 * before the options have loaded would say "All …" while the list stayed
 * filtered: the control lying about what is applied. A disabled option makes the
 * mismatch visible instead.
 */
export function FilterPicker({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | undefined;
  options: readonly FilterOption[];
  onChange: (next: string) => void;
}) {
  return (
    <LabelledControl label={label}>
      {(id) => (
        <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{allLabel}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          {value !== undefined && !options.some((o) => o.value === value) && (
            <option value={value} disabled>
              {value} (unavailable)
            </option>
          )}
        </select>
      )}
    </LabelledControl>
  );
}
