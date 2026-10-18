/** `:focus-visible`, or `false` in an engine that cannot parse it (Safari
    before 15.4 throws), where a keyboard-only affordance then stays off. */
export function focusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}
