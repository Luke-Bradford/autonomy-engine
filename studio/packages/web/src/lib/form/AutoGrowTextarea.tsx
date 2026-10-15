import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';

/**
 * #1569 OR37 — a textarea one line tall that grows with what is typed, up to
 * `maxRows` lines, and scrolls past that. A description is usually a line, so
 * a fixed three-row box spent two empty rows on every pipeline; capping the
 * growth keeps a long one from pushing the rest of its pane away.
 *
 * Sized in a layout effect on every value, before paint, so it never draws at
 * the wrong height. `height: auto` first, or `scrollHeight` could only grow.
 * The cap is in lines of the control's own computed `line-height`, plus its
 * padding and (under `border-box`) its border, so it follows the stylesheet.
 *
 * Measured again whenever its WIDTH changes: a narrower box wraps to more
 * lines, and a box mounted hidden (a dock tab not yet chosen) has no layout to
 * measure at all — it would size itself to nothing — until it is shown, which
 * is also a change of width, from 0.
 *
 * CONTROLLED only: it measures when `value` changes, so a `defaultValue` use
 * would never grow. Measuring collapses the box for an instant, which can clamp
 * a scrolled ancestor near its end — so every ancestor's scroll is put back.
 *
 * #1694 OR42 F10 — EXPAND ON EDIT, given `restRows`: at rest the box caps at
 * `restRows` lines (one, for a config field), and while it has focus at
 * `maxRows`, so nothing in a pane is permanently tall yet a long value is all
 * in view while it is being edited. Collapsed, it shows its first line.
 *
 * The collapse waits for a pointer that is still down. A press on a control
 * below blurs the box on pointerdown; shrinking then would move that control
 * up from under the pointer before pointerup, and the click would land on
 * whatever slid there instead. So a blur during a press collapses just after
 * the press ends, once its click has been dispatched. Any other blur collapses
 * a task later, not at once: a tap sends its pointer events BEFORE the
 * mousedown that moves focus, and its click follows in the same task. Only a
 * primary press counts, because a context-menu press may never send its
 * pointerup; `contextmenu` ends a press too, so the box never stays open.
 *
 * An UNWRAPPED box (`wrap="off"`, JSON) can draw a horizontal scrollbar under a
 * long line, inside the height set here; its thickness is added so the last
 * line is not hidden behind it. Collapsed, overflow across is hidden as well,
 * so a one-line box never carries a scrollbar under its one line.
 */
export function AutoGrowTextarea({
  maxRows = 4,
  restRows,
  ref: outerRef,
  onFocus,
  onBlur,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'style'> & {
  maxRows?: number;
  restRows?: number;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      ref.current = el;
      if (typeof outerRef === 'function') outerRef(el);
      else if (outerRef) outerRef.current = el;
    },
    [outerRef],
  );
  const [width, setWidth] = useState(0);
  const [focused, setFocused] = useState(false);
  const expandsOnEdit = restRows !== undefined;
  const rows = expandsOnEdit && !focused ? Math.min(restRows, maxRows) : maxRows;
  const collapsed = rows < maxRows;
  // Whether a press is in progress, and whether a blur is waiting for its end.
  const pressed = useRef(false);
  const collapseOnRelease = useRef(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const collapseSoon = useCallback(() => {
    clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setFocused(false), 0);
  }, []);
  useEffect(() => {
    if (!expandsOnEdit || !focused) return;
    // Capture, so the press is seen before the blur it causes.
    const down = (e: PointerEvent) => {
      pressed.current = e.button === 0 && !e.ctrlKey;
    };
    const up = () => {
      pressed.current = false;
      if (!collapseOnRelease.current) return;
      collapseOnRelease.current = false;
      // After the click this press dispatches, which follows pointerup.
      collapseSoon();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('contextmenu', up, true);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('contextmenu', up, true);
      pressed.current = false;
      collapseOnRelease.current = false;
    };
  }, [expandsOnEdit, focused, collapseSoon]);
  useEffect(() => () => clearTimeout(collapseTimer.current), []);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    // Width only: the height this sets is a resize too, and must not loop.
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const scrolled: [Element, number][] = [];
    for (let p = el.parentElement; p !== null; p = p.parentElement)
      if (p.scrollTop !== 0) scrolled.push([p, p.scrollTop]);
    el.style.height = 'auto';
    // Hidden, there is nothing to measure: left at its one natural row rather
    // than sized to nothing, and measured when shown.
    if (el.scrollHeight === 0) return;
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const line = px(cs.lineHeight) || px(cs.fontSize) * 1.2;
    const padding = px(cs.paddingTop) + px(cs.paddingBottom);
    const border =
      cs.boxSizing === 'border-box' ? px(cs.borderTopWidth) + px(cs.borderBottomWidth) : 0;
    // `scrollHeight` counts padding but never the border.
    const content = el.scrollHeight + border - (cs.boxSizing === 'border-box' ? 0 : padding);
    const cap = line * rows + border + (cs.boxSizing === 'border-box' ? padding : 0);
    const height = Math.min(content, cap);
    el.style.height = `${String(height)}px`;
    // Collapsed, the rest of the value is out of sight without a scrollbar,
    // across as well as down: an unwrapped box (JSON) would draw a horizontal
    // one under its single line. Otherwise across is the stylesheet's.
    el.style.overflowY = content > cap && !collapsed ? 'auto' : 'hidden';
    el.style.overflowX = collapsed ? 'hidden' : '';
    // An unwrapped line wider than the box draws a horizontal scrollbar INSIDE
    // that height, hiding the last line: `scrollHeight` never counts it. Read
    // after the overflow is set, since a vertical scrollbar narrows the box.
    // Zero where scrollbars overlay, and below zero where there is no layout.
    // Rounded: the two heights are whole pixels and a border at a fractional
    // zoom is not, which would otherwise read as a sliver of a bar.
    const bar = Math.round(
      el.offsetHeight - el.clientHeight - px(cs.borderTopWidth) - px(cs.borderBottomWidth),
    );
    if (bar >= 1) el.style.height = `${String(height + bar)}px`;
    for (const [p, top] of scrolled) p.scrollTop = top;
    // Collapsed, it shows its FIRST line from its first character, not
    // wherever the caret left it scrolled.
    if (collapsed) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
  }, [props.value, rows, collapsed, maxRows, width]);
  return (
    <textarea
      {...props}
      ref={setRef}
      rows={1}
      data-grow={expandsOnEdit ? 'edit' : undefined}
      onFocus={(e) => {
        clearTimeout(collapseTimer.current);
        collapseOnRelease.current = false;
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        if (pressed.current) collapseOnRelease.current = true;
        else collapseSoon();
        onBlur?.(e);
      }}
    />
  );
}
