import { boundShiftWarnings, type BoundFields } from './formFields';

/**
 * #855 — the bounds a daylight-saving gap will move, said where they were
 * typed. One component so the recurrence and tumbling-window editors, which
 * share the same `datetime-local` bounds, cannot render the fact two ways.
 */
export function BoundShiftNotices({ bounds }: { bounds: BoundFields }) {
  return boundShiftWarnings(bounds).map((warning) => (
    <p key={warning} className="page-hint" data-testid="bound-shift">
      {warning}
    </p>
  ));
}
