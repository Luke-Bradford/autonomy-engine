import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';

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
 */
export function AutoGrowTextarea({
  maxRows = 4,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'style'> & { maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(0);
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
    const cap = line * maxRows + border + (cs.boxSizing === 'border-box' ? padding : 0);
    el.style.height = `${String(Math.min(content, cap))}px`;
    el.style.overflowY = content > cap ? 'auto' : 'hidden';
  }, [props.value, maxRows, width]);
  return <textarea ref={ref} rows={1} {...props} />;
}
