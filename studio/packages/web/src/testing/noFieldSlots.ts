import { fieldAttrs } from '../lib/form/fieldValidation';
import type { RowFieldSlots } from '../pages/triggers/editorFields';

/** A trigger form with nothing raised, for a mode editor tested on its own (#1396). */
export const NO_FIELD_SLOTS: RowFieldSlots = {
  errorFor: () => undefined,
  attrsFor: (key, errorId) => fieldAttrs({ key, error: undefined, errorId }),
  rekey: () => undefined,
};
