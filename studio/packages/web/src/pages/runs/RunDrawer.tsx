import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { PaneSplitter } from '../../shell/PaneSplitter';
import { DOCK_MIN_WIDTH, uiStore } from '../../stores/uiStore';

/** The drawer element, which the rows that open it name in `aria-controls`. */
export const RUN_DRAWER_ID = 'run-detail-drawer';
const WIDTH_VAR = '--run-drawer-width';
/** The widest the drawer may be: most of the window, never all of it. */
const MAX_SHARE = 0.8;
const RESIZE_STEP = 16;

/**
 * #1484 OR35 M2 — the run page's detail drawer: what one activity run did, on
 * the right, OVER the page rather than in it. The inline drill-in it replaced
 * pushed everything below it down; this leaves the activity runs where they
 * are, so the operator can step from row to row and read each one.
 *
 * Not a modal: the table behind stays live and clickable, so opening another
 * row just swaps the record. Escape closes it while focus is inside it, as the
 * form drawer does (`FormDrawer`), and focus goes back to the row that opened
 * it. Only while focus is inside: the page behind has its own Escapes (a search
 * box, a confirm), and a page-wide one would close the drawer under them. The
 * owner keys the drawer by each open, so every open, even of the row already
 * shown, is a fresh mount and hands focus in again.
 *
 * Its width is the operator's (`uiStore.runDrawerWidth`), dragged or set with
 * the arrow keys on its left edge.
 */
export function RunDrawer({
  onClose,
  returnFocusTo,
  children,
}: {
  onClose: () => void;
  /** The button that opened it. Passed in rather than read from focus at mount:
   * swapping rows unmounts the last drawer first, whose cleanup hands focus to
   * ITS row, so at mount focus is on the wrong one. */
  returnFocusTo: HTMLElement | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useStore(uiStore, (s) => s.runDrawerWidth);
  const setWidth = useStore(uiStore, (s) => s.setRunDrawerWidth);
  const [rendered, setRendered] = useState(0);

  // Re-measured on a window resize too: the default width and the cap are
  // both shares of the window.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useLayoutEffect(() => {
    if (ref.current) setRendered(Math.round(ref.current.getBoundingClientRect().width));
  }, [width, windowWidth]);

  // Focus in on open; back to the opener on close, if it is still there (a
  // filter or a live re-read can have taken its row away) and focus was in the
  // drawer. A close that came from elsewhere leaves focus where the operator
  // put it.
  useEffect(() => {
    const opener = returnFocusTo;
    const drawer = ref.current;
    drawer?.querySelector<HTMLElement>('[data-drawer-focus]')?.focus();
    return () => {
      const at = document.activeElement;
      const focusWasHere = at === null || at === document.body || drawer?.contains(at) === true;
      if (focusWasHere && opener?.isConnected) opener.focus();
    };
    // Mount-only: the owner keys the drawer by each open, so each mounts anew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = useCallback(
    (next: number) => ref.current?.style.setProperty(WIDTH_VAR, `${next}px`),
    [],
  );

  const max = Math.max(DOCK_MIN_WIDTH, Math.floor(windowWidth * MAX_SHARE));
  return (
    <div
      ref={ref}
      id={RUN_DRAWER_ID}
      className="run-drawer"
      style={width === null ? undefined : ({ [WIDTH_VAR]: `${width}px` } as CSSProperties)}
      onKeyDown={(event) => {
        // An Escape a control inside already handled is not a request to close.
        if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) {
          return;
        }
        event.preventDefault();
        onClose();
      }}
    >
      {rendered > 0 && (
        <PaneSplitter
          className="run-drawer__splitter"
          axis="x"
          grow={-1}
          value={Math.min(width ?? rendered, max)}
          min={DOCK_MIN_WIDTH}
          max={max}
          step={RESIZE_STEP}
          label="Resize activity details"
          controls={RUN_DRAWER_ID}
          onPreview={preview}
          onCommit={setWidth}
        />
      )}
      <div className="run-drawer__body">{children}</div>
    </div>
  );
}
