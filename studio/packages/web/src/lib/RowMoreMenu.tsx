import { useId } from 'react';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import { MoreHorizontalRegular } from '@fluentui/react-icons';

/**
 * Where a row action was chosen from: the row's `⋯` button. The menu item that
 * was pressed unmounts with its menu, so focus has to go back here instead.
 *
 * `element` is the button as it is now, for `useDrawerForm.openFrom`.
 * Confirmations should use `find`, because it looks the button up again by id
 * when focus is restored. A list that refreshes while the dialog is open may
 * replace the node, and `useConfirm` silently skips a disconnected one.
 */
export interface RowMenuOrigin {
  readonly element: HTMLElement;
  readonly find: () => HTMLElement | null;
}

export interface RowMenuAction {
  readonly label: string;
  readonly onSelect: (origin: RowMenuOrigin) => void;
  readonly disabled?: boolean;
}

interface RowMoreMenuProps {
  /** The row's object name. The button is called "Actions for <name>". */
  readonly name: string;
  /**
   * Use this instead of the default accessible name when another menu on the
   * same screen already names this object (the author hub's resource pane sits
   * beside the Pipelines table).
   */
  readonly label?: string;
  /** The `⋯` button's id, when the caller has to find it again itself. */
  readonly id?: string;
  /** Extra classes for the `⋯` button, e.g. the resource pane's hover reveal. */
  readonly className?: string;
  /** In order. The row's single most common action stays inline, outside this menu. */
  readonly actions: readonly RowMenuAction[];
  /**
   * #1397: Delete goes last, after a divider, in the danger colour. It is
   * separate from `actions` so that no caller can put it anywhere else.
   */
  readonly destructive?: RowMenuAction;
}

/**
 * #1397 OR6: a row's less common actions, in one `⋯` menu.
 *
 * It is built like the editor header's menu (`PipelineCanvas.tsx`). That menu
 * stays separate because it has no destructive item and gives a reason under
 * each disabled entry. This one uses Fluent's default body portal, because
 * the resource pane clips its own overflow and the U0 spike forbids
 * reparenting a surface into the React Flow viewport.
 */
export function RowMoreMenu({
  name,
  label,
  id,
  className,
  actions,
  destructive,
}: RowMoreMenuProps) {
  const generated = useId();
  const triggerId = id ?? `row-menu-${generated}`;
  const find = () => document.getElementById(triggerId);

  const select = (action: RowMenuAction) => () => {
    const element = find();
    if (element === null) return;
    action.onSelect({ element, find });
  };

  return (
    <Menu>
      <MenuTrigger disableButtonEnhancement>
        <button
          id={triggerId}
          type="button"
          className={`icon-button row-menu__trigger${className ? ` ${className}` : ''}`}
          aria-label={label ?? `Actions for ${name}`}
        >
          <MoreHorizontalRegular aria-hidden="true" />
        </button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {actions.map((action) => (
            <MenuItem key={action.label} disabled={action.disabled} onClick={select(action)}>
              {action.label}
            </MenuItem>
          ))}
          {destructive && (
            <>
              <MenuDivider />
              <MenuItem
                className="row-menu__danger"
                disabled={destructive.disabled}
                onClick={select(destructive)}
              >
                {destructive.label}
              </MenuItem>
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
