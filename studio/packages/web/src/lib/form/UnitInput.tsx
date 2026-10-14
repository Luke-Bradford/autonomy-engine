import type { ReactNode } from 'react';
import { unitSuffix } from './unit';

/**
 * #1694 OR42 item 5 — a field's label with its unit moved out of sight: the
 * title is drawn, " (seconds)" is not, so the accessible name is unchanged
 * ("Timeout (seconds)") and every spec and screen reader still reaches it.
 * The leading space sits INSIDE the hidden span, or jsdom names the field
 * "Timeout(seconds)" while a browser normalises it.
 */
export function UnitLabel({ title, unit }: { title: ReactNode; unit: string | undefined }) {
  return (
    <>
      {title}
      {unit !== undefined && <span className="visually-hidden">{` (${unit})`}</span>}
    </>
  );
}

/**
 * The control with its unit drawn inside its right edge (`unitSuffix`), as
 * ADF draws one. `aria-hidden`: the label already names the unit. No unit, no
 * wrapper, so a field without one keeps its old box.
 */
export function WithUnit({ unit, children }: { unit: string | undefined; children: ReactNode }) {
  if (unit === undefined) return <>{children}</>;
  return (
    <span className="input-unit">
      {children}
      <span className="input-unit__suffix" aria-hidden="true">
        {unitSuffix(unit)}
      </span>
    </span>
  );
}
