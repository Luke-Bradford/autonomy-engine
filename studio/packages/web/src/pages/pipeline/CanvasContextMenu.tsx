import { useMemo } from 'react';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
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
}

/**
 * #1597 — where the selection can go: every container but the one already
 * holding all of it (`into`), and the name of the one it can leave
 * (`removeFrom`: a container's name, `containers` when the selection spans
 * several, `null` when none of it is in one).
 */
export interface CanvasMenuMoves {
  readonly into: readonly { id: string; label: string }[];
  readonly removeFrom: string | null;
}

/** Shown under a greyed Move into when there is nowhere to move to. */
export const NO_CONTAINER_TO_MOVE_INTO =
  'No other container on this canvas. Add one from the Activities palette.';

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
 * the React Flow viewport). Closing hands focus back to what had it before,
 * which is Fluent's own restore. `closeOnScroll`, so a wheel-pan does not leave it
 * floating over a canvas that has moved. Delete goes last, after a divider, in
 * the danger colour, as in every `⋯` menu (#1397).
 *
 * While the canvas cannot be edited (a save or restore in flight) every item is
 * greyed and says why on its second line, as the editor's other menus do.
 *
 * #1597 — an activity's container is set here too: Move into ▸ (a submenu of
 * the canvas's containers; ArrowRight opens it from the keyboard) and Remove
 * from, the keyboard route to what dragging into a box does (WCAG 2.5.7). It
 * replaced the Container section every activity's properties used to carry.
 */
export function CanvasContextMenu({
  request,
  onClose,
  onCommand,
  disabledReason,
  moves,
  onMove,
}: {
  request: CanvasMenuRequest | null;
  onClose: () => void;
  onCommand: (cmd: CanvasCommand) => void;
  disabledReason: string | null;
  moves: CanvasMenuMoves | null;
  onMove: (target: string | null) => void;
}) {
  const x = request?.x ?? 0;
  const y = request?.y ?? 0;
  // Memoised: Fluent re-creates its position manager whenever the target's
  // identity changes, and the canvas re-renders often while the menu is open.
  const at = useMemo(
    () => ({
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
    }),
    [x, y],
  );
  if (request === null) return null;
  const disabled = disabledReason !== null;
  const subText = disabledReason ?? undefined;
  const items =
    request.target === 'pane' ? SELECTION_ITEMS.filter((i) => i.cmd === 'paste') : SELECTION_ITEMS;
  return (
    <Menu
      open
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
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
          {request.target === 'selection' && moves !== null && (
            <>
              <MenuDivider />
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <MenuItem
                    disabled={disabled || moves.into.length === 0}
                    subText={
                      subText ?? (moves.into.length === 0 ? NO_CONTAINER_TO_MOVE_INTO : undefined)
                    }
                  >
                    Move into
                  </MenuItem>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList aria-label="Move into">
                    {moves.into.map((c) => (
                      <MenuItem key={c.id} onClick={() => onMove(c.id)}>
                        {c.label}
                      </MenuItem>
                    ))}
                  </MenuList>
                </MenuPopover>
              </Menu>
              {moves.removeFrom !== null && (
                <MenuItem disabled={disabled} subText={subText} onClick={() => onMove(null)}>
                  Remove from {moves.removeFrom}
                </MenuItem>
              )}
            </>
          )}
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
