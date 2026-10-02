import { useEffect, useState, type RefObject } from 'react';

/**
 * #1475 — an element's rendered width or height in px, kept current by a
 * `ResizeObserver`; 0 until measured, and always 0 under jsdom, which has no
 * layout and no observer. The dock's and the Problems column's dividers take
 * their caps from it.
 *
 * A PASSIVE effect, not a layout effect, and that is load-bearing: the
 * dividers measure elements AROUND them (a parent), and React attaches a host
 * element's ref only after its children's layout effects have run — so a
 * layout effect would see null on mount and the divider would never appear.
 * Passive effects run after every ref is attached.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, axis: 'width' | 'height') {
  const [size, setSize] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize(el.getBoundingClientRect()[axis]);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, axis]);
  return size;
}
