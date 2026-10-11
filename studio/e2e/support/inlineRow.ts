import { expect } from '@playwright/test';

/** One control in a row, as a spec measured it in the page. */
export interface InlineItem {
  name: string;
  left: number;
  right: number;
  centre: number;
}

/**
 * #1594 OR40 — the epic's Acceptance, "Toolbars": adjacent controls in a row
 * are 8px or more apart, and their vertical centres agree within 1px. Each
 * failure names the pair. `minGap` is for a row whose 8px gap lands on a
 * subpixel boundary.
 */
export function expectInlineRow(label: string, items: readonly InlineItem[], minGap = 8): void {
  for (let i = 1; i < items.length; i += 1) {
    const [a, b] = [items[i - 1]!, items[i]!];
    expect(b.left - a.right, `${label}: gap '${a.name}' → '${b.name}'`).toBeGreaterThanOrEqual(
      minGap,
    );
    expect(
      Math.abs(b.centre - a.centre),
      `${label}: centres '${a.name}'/'${b.name}'`,
    ).toBeLessThanOrEqual(1);
  }
}
