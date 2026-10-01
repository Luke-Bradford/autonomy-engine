import { fieldAttrs } from '../lib/form/fieldValidation';
import type { FieldSlots } from '../pages/triggers/editorFields';

/** A trigger form with nothing raised, for a mode editor tested on its own (#1396). */
export const NO_FIELD_SLOTS: FieldSlots = {
  errorFor: () => undefined,
  attrsFor: (key, errorId) => fieldAttrs({ key, error: undefined, errorId }),
};
