import type { DisplayTimeZone } from '../../lib/displayTime';
import { boundShiftWarnings, boundZoneName, type BoundFields } from './formFields';

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

/**
 * #1524 — the zone a start/end control is written in, said beside it, so the
 * operator never has to guess which wall clock the input means. Part of the
 * control's label, and so of its accessible name.
 */
export function BoundZoneNote({ zone }: { zone: DisplayTimeZone }) {
  return <> ({boundZoneName(zone)})</>;
}
