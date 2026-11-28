import { FLUENT_ROOT_CLASS } from '../theme/fluentTheme';

/**
 * Where a modal `<dialog>` mounts (`ExpressionEditor`, the Code view): outside
 * the field that opens it, so the field's own rules (`.config-field > …`) and the
 * dock's key handling do not reach the editor; inside the app's Fluent root,
 * where the theme's tokens resolve. Native `<dialog>` in the top layer, rather
 * than Fluent's: it is mounted by a field that can unmount while it is open,
 * and an open Fluent dialog unmounted leaves `aria-hidden` on the whole app
 * (`useConfirm`), where removing a `<dialog>` takes it out of the top layer.
 */
export function portalRoot(): Element {
  return document.querySelector(`.${FLUENT_ROOT_CLASS}:not([data-portal-node])`) ?? document.body;
}
