import { Menu, MenuDivider, MenuItem, MenuList, MenuPopover } from '@fluentui/react-components';
import type { CanvasCommand } from './canvasCommands';

/**
 * Where a context menu was asked for, in viewport pixels, and on what: the
 * empty canvas (`pane`) or the activity selection (`selection`). A container
 * box is `pane` — its body lets clicks through to the canvas, so a right-click
 * inside one already lands there, and its ⚙/✕/ports say the same rather than
 * offering a cut its ✕ refuses.
 */
export interface CanvasMenuRequest {
  readonly x: number;
  readonly y: number;
  readonly target: 'pane' | 'selection';
  /** Focused when the menu closes, if it is still on the page. */
  readonly returnFocus: Element | null;
}

const SELECTION_ITEMS: readonly { cmd: CanvasCommand; label: string; keys: string }[] = [
  { cmd: 'copy', label: 'Copy', keys: '⌘C' },
  { cmd: 'cut', label: 'Cut', keys: '⌘X' },
  { cmd: 'duplicate', label: 'Duplicate', keys: '⌘D' },
  { cmd: 'paste', label: 'Paste', keys: '⌘V' },
];

/**
 * #1477 OR29 — the canvas's right-click menu: Paste on the empty canvas, and
 * the clipboard acts plus Delete on an activity. Every item runs the command
 * its shortcut runs (`runCanvasCommand`), so the menu is a way to find the keys
 * rather than a second set of rules.
 *
 * A Fluent menu with no trigger, anchored to the pointer through a zero-size
 * virtual element, in Fluent's default body portal (U0: never reparented into
 * the React Flow viewport). `closeOnScroll`, so a wheel-pan does not leave it
 * floating over a canvas that has moved. Delete goes last, after a divider, in
 * the danger colour, as in every `⋯` menu (#1397).
 *
 * While the canvas cannot be edited (a save or restore in flight) every item is
 * greyed and says why on its second line, as the editor's other menus do.
 */
export function CanvasContextMenu({
  request,
  onClose,
  onCommand,
  disabledReason,
}: {
  request: CanvasMenuRequest | null;
  onClose: () => void;
  onCommand: (cmd: CanvasCommand) => void;
  disabledReason: string | null;
}) {
  if (request === null) return null;
  const { x, y } = request;
  const at = {
    getBoundingClientRect: () => ({
      x,
      y,
      top: y,
      left: x,
      bottom: y,
      right: x,
      width: 0,
      height: 0,
    }),
  };
  const disabled = disabledReason !== null;
  const subText = disabledReason ?? undefined;
  const items =
    request.target === 'pane' ? SELECTION_ITEMS.filter((i) => i.cmd === 'paste') : SELECTION_ITEMS;
  return (
    <Menu
      open
      onOpenChange={(_, data) => {
        if (data.open) return;
        onClose();
        const back = request.returnFocus;
        if (back instanceof HTMLElement && back.isConnected) back.focus();
      }}
      positioning={{ target: at, position: 'below', align: 'start' }}
      closeOnScroll
    >
      <MenuPopover>
        <MenuList aria-label={request.target === 'pane' ? 'Canvas' : 'Selection'}>
          {items.map((item) => (
            <MenuItem
              key={item.cmd}
              disabled={disabled}
              subText={subText}
              secondaryContent={item.keys}
              onClick={() => onCommand(item.cmd)}
            >
              {item.label}
            </MenuItem>
          ))}
          {request.target === 'selection' && (
            <>
              <MenuDivider />
              <MenuItem
                className="row-menu__danger"
                disabled={disabled}
                subText={subText}
                secondaryContent="⌫"
                onClick={() => onCommand('delete')}
              >
                Delete
              </MenuItem>
            </>
          )}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
