import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

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
 */
export function AutoGrowTextarea({
  maxRows = 4,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'style'> & { maxRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const line = px(cs.lineHeight) || px(cs.fontSize) * 1.2;
    const padding = px(cs.paddingTop) + px(cs.paddingBottom);
    const border = cs.boxSizing === 'border-box' ? px(cs.borderTopWidth) + px(cs.borderBottomWidth) : 0;
    // `scrollHeight` counts padding but never the border.
    const content = el.scrollHeight + border - (cs.boxSizing === 'border-box' ? 0 : padding);
    const cap = line * maxRows + border + (cs.boxSizing === 'border-box' ? padding : 0);
    el.style.height = `${String(Math.min(content, cap))}px`;
    el.style.overflowY = content > cap ? 'auto' : 'hidden';
  }, [props.value, maxRows]);
  return <textarea ref={ref} rows={1} {...props} />;
}
