import { expect, type Locator, type Page } from '@playwright/test';

/**
 * #1695 OR43 — an open overlay (menu, popover, listbox, tooltip, dialog) is
 * fully visible: nothing paints over it, the viewport holds it, and no
 * clipping ancestor cuts it.
 *
 * Three readings, one `evaluate`, all failures returned at once:
 *
 * - **Hit-testing.** `elementFromPoint` at the four corners and the centre
 *   must land inside the overlay. A corner is probed 2px in, or further on a
 *   rounded corner, which does not hit-test outside its curve. A surface that paints over it, such as
 *   the dock's sticky tab strip over the node `⋯` menu, takes the point.
 * - **Viewport.** The rect lies inside `innerWidth` × `innerHeight`.
 * - **Clipping.** No ancestor whose `overflow` is not `visible` has a box that
 *   fails to contain the rect. Hit-testing alone misses this case when the
 *   clipped part is off-screen.

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
    // Half a pixel's grace, as for clipping below: a list sized to the room
    // below its control ends ON the viewport's edge, at a fractional offset.
    if (
      r.left < -0.5 ||
      r.top < -0.5 ||
      r.right > innerWidth + 0.5 ||
      r.bottom > innerHeight + 0.5
    ) {
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
    // Nothing outside the top layer clips what is in it (a popover, a modal).
    const inTopLayer = (n: Element) => n.matches(':popover-open, :modal');
    for (
      let a = inTopLayer(el) ? null : el.parentElement;
      a !== null && a !== document.documentElement;
      a = inTopLayer(a) ? null : a.parentElement
    ) {
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
  return page.locator(OVERLAYS).last();
}

const OVERLAYS = '.fui-MenuPopover:visible, [role="listbox"]:visible';

/**
 * Run `open` with no overlay showing, and return the one it opened. Checked
 * first, so a list that stays on the page cannot stand in for the new one.
 */
export async function openFrom(
  page: Page,
  open: () => Promise<unknown>,
  what = 'overlay',
): Promise<Locator> {
  await expect(page.locator(OVERLAYS), `${what}: one was already open`).toHaveCount(0);
  await open();
  await expect(page.locator(OVERLAYS), `${what}: opened nothing`).not.toHaveCount(0);
  return openOverlay(page);
}

/**
 * Every control in `scope` that opens a menu or a list, found by role rather
 * than listed by hand, so a new one is covered the day it ships. A native
 * `<select>` is left out: its list is drawn by the browser, above the page.
 * In a table, only the first row's: every row's `⋯` is the same menu, and a
 * list page in the shared e2e database can hold hundreds of rows.
 */
export function popupTriggers(scope: Locator): Locator {
  return scope.locator(
    [
      ':is([aria-haspopup="menu"], [aria-haspopup="true"], [aria-haspopup="listbox"], [role="combobox"])',
      ':not(select):not(:disabled):not([aria-disabled="true"])',
      ':not(:is(tbody > tr, [role="rowgroup"] > [role="row"]):not(:first-child) *)',
      ':visible',
    ].join(''),
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
  /** Run after each one closes: puts back a layout Escape may have changed. */
  between: () => Promise<unknown> = async () => {},
): Promise<number> {
  const triggers = popupTriggers(scope);
  const count = await triggers.count();
  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    const name = (await trigger.getAttribute('aria-label')) ?? (await trigger.innerText()).trim();
    await trigger.scrollIntoViewIfNeeded();
    const overlay = await openFrom(page, () => trigger.click(), `${what}: ${name}`);
    await expectOverlayUnobstructed(overlay, `${what}: ${name}`);
    await page.keyboard.press('Escape');
    await expect(page.locator(OVERLAYS)).toHaveCount(0);
    await between();
  }
  return count;
}

/**
 * #1695 OR43 — open every `?` help note in `scope` and assert each is
 * unobstructed. The note is the disclosure's `role="note"` span.
 */
export async function expectEveryHelpNoteUnobstructed(
  scope: Locator,
  what: string,
): Promise<number> {
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
