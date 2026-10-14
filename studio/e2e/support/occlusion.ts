import { expect, type Locator, type Page } from '@playwright/test';

/**
 * #1695 OR43 — an open overlay (menu, popover, listbox, tooltip, dialog) is
 * fully visible: nothing paints over it, the viewport holds it, and no
 * clipping ancestor cuts it.
 *
 * Three readings, one `evaluate`, all failures returned at once:
 *
 * - **Hit-testing.** `elementFromPoint` at the four corners (inset 2px, or past
 *   a rounded corner's curve) and the
 *   centre must land inside the overlay. A surface that paints over it, such as
 *   the dock's sticky tab strip over the node `⋯` menu, takes the point.
 * - **Viewport.** The rect lies inside `innerWidth` × `innerHeight`.
 * - **Clipping.** No ancestor whose `overflow` is not `visible` has a box that
 *   fails to contain the rect. Hit-testing alone misses this case when the
 *   clipped part is off-screen.
 *
 * Returns the overlay's rect, so a caller can report where it was.
 */
export async function expectOverlayUnobstructed(overlay: Locator, what = 'overlay'): Promise<void> {
  await expect(overlay).toBeVisible();
  const problems = await overlay.evaluate((el) => {
    const out: string[] = [];
    const r = el.getBoundingClientRect();
    const describe = (n: Element | null) =>
      n === null
        ? 'nothing'
        : `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ''}${
            typeof n.className === 'string' && n.className
              ? `.${n.className.trim().split(/\s+/).slice(0, 3).join('.')}`
              : ''
          }`;
    const at = `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    if (r.width === 0 || r.height === 0) out.push(`empty rect at ${at}`);
    if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) {
      out.push(`outside the ${innerWidth}x${innerHeight} viewport at ${at}`);
    }
    // A rounded corner does not hit-test outside its curve, so a probe 2px in
    // from a corner of radius R lands on whatever is behind. The curve passes
    // the diagonal at R(1 - 1/sqrt 2), about 0.3R, from the corner.
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    const inset = Math.max(2, Math.ceil(radius * 0.3) + 1);
    const probes: [string, number, number][] = [
      ['top-left', r.left + inset, r.top + inset],
      ['top-right', r.right - inset, r.top + inset],
      ['bottom-left', r.left + inset, r.bottom - inset],
      ['bottom-right', r.right - inset, r.bottom - inset],
      ['centre', r.left + r.width / 2, r.top + r.height / 2],
    ];
    for (const [name, x, y] of probes) {
      const hit = document.elementFromPoint(x, y);
      if (hit === null || !el.contains(hit)) {
        out.push(`${name} (${Math.round(x)},${Math.round(y)}) hits ${describe(hit)}`);
      }
    }
    for (let a = el.parentElement; a !== null && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = a.getBoundingClientRect();
      const cut =
        (s.overflowX !== 'visible' && (r.left < c.left - 0.5 || r.right > c.right + 0.5)) ||
        (s.overflowY !== 'visible' && (r.top < c.top - 0.5 || r.bottom > c.bottom + 0.5));
      if (cut) out.push(`clipped by ${describe(a)} (overflow ${s.overflowX}/${s.overflowY})`);
    }
    return out;
  });
  expect(problems, `${what} is obstructed`).toEqual([]);
}

/**
 * The overlay a trigger just opened: a Fluent menu, or any listbox (Combobox,
 * Dropdown). The last one, because a submenu opens over its parent.
 */
export function openOverlay(page: Page): Locator {
  return page.locator('.fui-MenuPopover:visible, [role="listbox"]:visible').last();
}

/**
 * Every control in `scope` that opens a menu or a list, found by role rather
 * than listed by hand, so a new one is covered the day it ships. A native
 * `<select>` is left out: its list is drawn by the browser, above the page.
 */
export function popupTriggers(scope: Locator): Locator {
  return scope.locator(
    ':is([aria-haspopup="menu"], [aria-haspopup="true"], [role="combobox"]):not(select):visible:not(:disabled):not([aria-disabled="true"])',
  );
}

/**
 * #1695 OR43 — open every menu and list `scope` offers, one at a time, and
 * assert each is unobstructed. Each is closed with Escape before the next.
 * Returns how many were checked, so a caller can assert the sweep saw some.
 */
export async function expectEveryPopupUnobstructed(
  page: Page,
  scope: Locator,
  what: string,
): Promise<number> {
  const triggers = popupTriggers(scope);
  const count = await triggers.count();
  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    const name = (await trigger.getAttribute('aria-label')) ?? (await trigger.innerText()).trim();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const overlay = openOverlay(page);
    await expectOverlayUnobstructed(overlay, `${what}: ${name}`);
    await page.keyboard.press('Escape');
    await expect(page.locator('.fui-MenuPopover:visible, [role="listbox"]:visible')).toHaveCount(0);
  }
  return count;
}

/**
 * #1695 OR43 — open every `?` help note in `scope` and assert each is
 * unobstructed. The note is the disclosure's `role="note"` span.
 */
export async function expectEveryHelpNoteUnobstructed(scope: Locator, what: string): Promise<number> {
  const summaries = scope.locator('details.help-disclosure > summary:visible');
  const count = await summaries.count();
  for (let i = 0; i < count; i += 1) {
    const summary = summaries.nth(i);
    const name = (await summary.getAttribute('aria-label')) ?? '?';
    await summary.scrollIntoViewIfNeeded();
    await summary.click();
    const note = summary.locator('xpath=..').locator(':scope > [role="note"]');
    await expectOverlayUnobstructed(note, `${what}: ${name}`);
    await summary.click();
    await expect(note).toBeHidden();
  }
  return count;
}

/**
 * #1695 OR43 — hover each of `triggers` and assert the tooltip it raises is
 * unobstructed. A trigger that raises none fails: a tooltip that never shows
 * cannot be checked, and the list is meant to hold only tooltip triggers.
 */
export async function expectEveryTooltipUnobstructed(
  page: Page,
  triggers: Locator,
  what: string,
): Promise<number> {
  const count = await triggers.count();
  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    await trigger.hover();
    const tip = page.getByRole('tooltip').filter({ visible: true }).last();
    await expectOverlayUnobstructed(tip, `${what}: tooltip ${i + 1}`);
    await page.mouse.move(0, 0);
    await expect(page.getByRole('tooltip').filter({ visible: true })).toHaveCount(0);
  }
  return count;
}
