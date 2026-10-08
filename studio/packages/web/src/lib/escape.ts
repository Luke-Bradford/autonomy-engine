/** The parts of a React keydown that say whether its Escape is still unclaimed. */
export interface EscapeKeyEvent {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly nativeEvent: { readonly isComposing: boolean };
}

/**
 * An Escape nothing nearer has claimed: not one a control inside already
 * handled (it calls `preventDefault`, as `ExpressionPicker` and
 * `HelpDisclosure` do), and not the one that ends an IME composition. Every
 * surface that closes on Escape — a drawer, a prompt, the expanded dock — asks
 * this first, so the innermost open thing always gets the key.
 */
export function isUnhandledEscape(e: EscapeKeyEvent): boolean {
  return e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing;
}
