import type { CSSProperties, ReactNode } from 'react';
import { unitSuffix } from './unit';

/**
 * #1694 OR42 item 5 — a field's label with its unit moved out of sight: the
 * title is drawn, " (seconds)" is not, so the accessible name is unchanged
 * ("Timeout (seconds)") and every spec and screen reader still reaches it.
 * The space is a text node of its own, OUTSIDE the hidden span: measured,
 * jsdom drops a span's leading space and names the field "Timeout(seconds)".
 */
export function UnitLabel({ title, unit }: { title: ReactNode; unit: string | undefined }) {
  return (
    <>
      {title}
      {unit !== undefined && (
        <>
          {' '}
          <span className="visually-hidden">{`(${unit})`}</span>
        </>
      )}
    </>
  );
}

/**
 * The control with its unit drawn inside its right edge (`unitSuffix`), as
 * ADF draws one. `aria-hidden`: the label already names the unit. No unit (or
 * one drawn without a suffix), no wrapper, so the field keeps its old box.
 */
export function WithUnit({ unit, children }: { unit: string | undefined; children: ReactNode }) {
  const suffix = unit === undefined ? null : unitSuffix(unit);
  if (suffix === null) return <>{children}</>;
  // The box keeps clear of the suffix by its length, so a long value never
  // runs under "bytes" (`--unit-ch`, `index.css`).
  return (
    <span className="input-unit" style={{ '--unit-ch': `${suffix.length}ch` } as CSSProperties}>
      {children}
      <span className="input-unit__suffix" aria-hidden="true">
        {suffix}
      </span>
    </span>
  );
}
