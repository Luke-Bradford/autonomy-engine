import type { ReactNode } from 'react';
import { DismissRegular } from '@fluentui/react-icons';

/**
 * #1594 OR40 S3 — one filter on a filter row, drawn as a pill like the ADF
 * Monitor's ("Status: Failed ✕ · Pipeline: Demo 2 ✕ · + Add filter").
 *
 * Only the frame is new. The control inside is the axis's own (a native
 * select, a checkbox menu, date inputs), which keeps its keyboard, typeahead
 * and accessible name; the pill draws it borderless. `active` marks a filter
 * that narrows the list, so an applied filter reads apart from one at "All".
 * `onRemove` adds the ✕, which takes the filter off the row.
 *
 * The axis name is the control's own `<label>`, drawn visible. The colon of
 * "Status: All" is the stylesheet's, with empty alternative text, so the
 * control's name stays "Status".
 */
export function FilterPill({
  name,
  active,
  onRemove,
  children,
}: {
  /** The axis, as its control is named: "Remove {name} filter". */
  name: string;
  active: boolean;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <span className="filter-pill" data-active={active || undefined}>
      {children}
      {onRemove && (
        <button
          type="button"
          className="icon-button filter-pill__remove"
          aria-label={`Remove ${name} filter`}
          title={`Remove ${name} filter`}
          onClick={onRemove}
        >
          <DismissRegular aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

