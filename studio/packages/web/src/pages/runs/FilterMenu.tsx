import {
  Menu,
  MenuItemCheckbox,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';

/**
 * A filter bar's multi-select: Fluent's checkbox menu, which brings the
 * `menuitemcheckbox` roles and arrow-key movement a multi-select needs (a
 * native `<select multiple>` draws as a tall list box). The button says the
 * selection — "All", the one value, or a count — so the label is the button's
 * own text.
 *
 * The runs bar's "Triggered by" and the pipelines bar's "Last run" (#1569).
 */
export function FilterMenu<V extends string>({
  label,
  name,
  values,
  checked,
  labelOf,
  countNoun,
  onChange,
}: {
  label: string;
  /** The menu's checkbox group. */
  name: string;
  values: readonly V[];
  /** `[]` is every value. */
  checked: readonly V[];
  labelOf: (value: V) => string;
  /** "kinds" in "3 kinds". */
  countNoun: string;
  /** The values now checked, in no particular order. */
  onChange: (checked: string[]) => void;
}) {
  const summary =
    checked.length === 0
      ? 'All'
      : checked.length === 1
        ? labelOf(checked[0]!)
        : `${String(checked.length)} ${countNoun}`;
  return (
    <Menu
      checkedValues={{ [name]: [...checked] }}
      onCheckedValueChange={(_, data) => onChange(data.checkedItems)}
    >
      <MenuTrigger disableButtonEnhancement>
        <button type="button" className="run-filters__menu">
          {label}: {summary} <span aria-hidden="true">▾</span>
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {values.map((v) => (
            <MenuItemCheckbox key={v} name={name} value={v}>
              {labelOf(v)}
            </MenuItemCheckbox>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
