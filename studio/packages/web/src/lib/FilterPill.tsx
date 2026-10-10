import { useRef, type ReactNode } from 'react';
import { DismissRegular } from '@fluentui/react-icons';

/**
 * #1594 OR40 S3 — one filter on a filter row, drawn as a pill like the ADF
 * Monitor's ("Status: Failed ✕ · Pipeline: Demo 2 ✕ · + Add filter").
 *
 * Only the frame is new. The control inside is the axis's own (a native
 * select, a checkbox menu, date inputs), which keeps its keyboard, typeahead
 * and accessible name; the pill draws it borderless. `active` marks a filter
 * that narrows the list, so an applied filter reads apart from one at "All".
 *
 * `onRemove` adds the ✕. The caller decides when there is one: an axis always
 * on the row has it only while it narrows the list, while an optional axis
 * added to the row has it always, since the ✕ is also how it leaves the row.
 * After a ✕, focus goes to the pill's own control if the pill is still there,
 * or to the row's `[data-filter-add]` button if it has gone, so the keyboard
 * is never dropped onto the page.
 *
 * A pill's axis name is its first control's `<label>`, drawn visible, and the
 * colon of "Status: All" is the stylesheet's, with empty alternative text, so
 * the control's name stays "Status". A checkbox menu ("Triggered by: All ▾")
 * has no label and says its axis in its own button text.
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
  const pill = useRef<HTMLSpanElement>(null);
  function remove() {
    const row = pill.current?.parentElement ?? null;
    onRemove?.();
    requestAnimationFrame(() => {
      const target = pill.current?.isConnected
        ? pill.current.querySelector<HTMLElement>('select, input, button:not(.filter-pill__remove)')
        : row?.querySelector<HTMLElement>('[data-filter-add]');
      target?.focus();
    });
  }
  return (
    <span className="filter-pill" ref={pill} data-active={active || undefined}>
      {children}
      {onRemove && (
        <button
          type="button"
          className="icon-button filter-pill__remove"
          aria-label={`Remove ${name} filter`}
          title={`Remove ${name} filter`}
          onClick={remove}
        >
          <DismissRegular aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
