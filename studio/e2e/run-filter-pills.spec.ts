import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H } from './support/appearance';

/**
 * #1594 OR40 S3 — the Monitor's filter row as pills, like the ADF Monitor's
 * ("Status: Failed ✕ · Pipeline: Demo 2 ✕ · + Add filter"), measured in both
 * densities at 1440×900.
 *
 * Every pill is `--control-h` tall and fully rounded, with its controls drawn
 * borderless inside it and its ✕ inside its border. Pills sit on one row,
 * centres within 1px and at least 8px apart. An applied filter has the accent
 * edge and one at "All" does not. The axis name is drawn with its colon, and
 * the control's name stays the bare axis.
 */
test.use({ viewport: { width: 1440, height: 900 } });

type Density = 'compact' | 'comfortable';
const BODY: Record<Density, number> = { compact: 13, comfortable: 14 };

async function setDensity(page: Page, density: Density) {
  await page.goto('/#/settings');
  await fluentRootReady(page);
  await page.getByRole('combobox', { name: 'Density', exact: true }).selectOption(density);
  await expect(page.locator('html')).toHaveAttribute('data-density', density);
}

/** Everything this spec asserts about the row, read in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.run-filters')!;
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    bar.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const items = [...bar.children].map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, centre: r.top + r.height / 2 };
    });
    const pills = [...bar.querySelectorAll<HTMLElement>('.filter-pill')].map((pill) => {
      const s = getComputedStyle(pill);
      const r = pill.getBoundingClientRect();
      const label = pill.querySelector('label');
      const remove = pill.querySelector('.filter-pill__remove')?.getBoundingClientRect();
      // Inside the border, not over it.
      const bw = parseFloat(s.borderTopWidth);
      return {
        // The axis: its label, or the menu button's text before the colon.
        // (Not `innerText`, which carries every option of a select.)
        text:
          pill.querySelector('label')?.textContent ??
          pill.querySelector('button')?.textContent?.split(':')[0] ??
          '',
        height: r.height,
        radius: parseFloat(s.borderTopLeftRadius),
        accentEdge: s.borderTopColor === accent,
        labelFont: label ? getComputedStyle(label).fontSize : null,
        colon: label ? getComputedStyle(label, '::after').content : null,
        innerBorders: [
          ...pill.querySelectorAll<HTMLElement>('select, input, button.run-filters__menu'),
        ].map((c) => getComputedStyle(c).borderTopColor),
        // Every control inside the border, so its focus ring is too.
        controlsInside: [
          ...pill.querySelectorAll<HTMLElement>('select, input, button.run-filters__menu'),
        ].every((c) => {
          const cr = c.getBoundingClientRect();
          return cr.top >= r.top + bw && cr.bottom <= r.bottom - bw;
        }),
        removeInside: remove
          ? remove.top >= r.top + bw &&
            remove.bottom <= r.bottom - bw &&
            remove.right <= r.right - bw
          : null,
      };
    });
    const content = document.querySelector('.content')!;
    return { items, pills, sideways: content.scrollWidth - content.clientWidth };
  });
}

for (const density of ['compact', 'comfortable'] as const) {
  test(`#1594 OR40 S3 — the runs filter row as pills (${density})`, async ({ page }) => {
    const problems = collectPageProblems(page);
    await setDensity(page, density);
    // An applied status, a window and an annotation set by the URL (so its
    // optional pill shows). The range of days is the widest state of the
    // always-shown pills, and `run-list.spec.ts` holds that to one row.
    await page.goto('/#/monitor/runs?status=failure&since=24h&annotation=e2e-pill');
    await fluentRootReady(page);
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue(
      'failure',
    );

    const m = await measure(page);
    const dump = JSON.stringify(m.pills);
    // Status, Pipeline, Triggered by, Started, Annotation; then Add filter, Clear.
    expect(
      m.pills.map((p) => p.text.split(':')[0]),
      dump,
    ).toEqual(['Status', 'Pipeline', 'Triggered by', 'Started', 'Annotation']);
    expect(m.items).toHaveLength(7);
    for (const pill of m.pills) {
      expect(pill.controlsInside, `${pill.text}: controls inside the border`).toBe(true);
      expect(pill.height, `${pill.text}: --control-h tall`).toBeCloseTo(CONTROL_H[density], 0);
      expect(pill.radius, `${pill.text}: fully rounded`).toBeGreaterThanOrEqual(pill.height / 2);
      for (const border of pill.innerBorders)
        expect(border, `${pill.text}: a control inside draws no box`).toBe('rgba(0, 0, 0, 0)');
      if (pill.labelFont !== null) {
        expect(pill.labelFont, `${pill.text}: the axis name in body type`).toBe(
          `${BODY[density]}px`,
        );
        // A drawn colon with empty alternative text: shown, not read.
        expect(pill.colon, `${pill.text}: drawn with its colon`).toBe('":" / ""');
      }
    }
    // Applied: Status, Started, Annotation. At All: Pipeline, Triggered by.
    expect(
      m.pills.map((p) => p.accentEdge),
      dump,
    ).toEqual([true, false, false, true, true]);
    // A ✕ on each applied pill, inside its border; none on a pill at All.
    expect(
      m.pills.map((p) => p.removeInside),
      dump,
    ).toEqual([true, null, null, true, true]);

    const centres = m.items.map((i) => i.centre);
    expect(
      Math.max(...centres) - Math.min(...centres),
      `one row: ${centres.join(',')}`,
    ).toBeLessThanOrEqual(1);
    for (let i = 1; i < m.items.length; i++)
      expect(
        m.items[i]!.left - m.items[i - 1]!.right,
        `gap before item ${i}`,
      ).toBeGreaterThanOrEqual(8);
    expect(m.sideways).toBeLessThanOrEqual(0);

    // The name a control is found by is the bare axis, not "Status:".
    await expect(page.getByRole('combobox', { name: 'Annotation', exact: true })).toHaveValue(
      'e2e-pill',
    );
    await expectQuiet(page, problems);
  });
}

test('#1594 OR40 S3 — Add filter puts an axis on the row, focused; its ✕ takes it off', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const trigger = page.getByRole('combobox', { name: 'Trigger', exact: true });
  await expect(trigger).toHaveCount(0);

  await page.getByRole('button', { name: 'Add filter' }).click();
  await page.getByRole('menuitem', { name: 'Trigger' }).click();
  // After the menu has handed focus back to its own button.
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveValue('');

  await page.getByRole('button', { name: 'Remove Trigger filter' }).click();
  await expect(trigger).toHaveCount(0);

  // The Status pill's ✕ clears the URL as well as the control.
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('failure');
  await expect.poll(() => page.url()).toContain('status=failure');
  await page.getByRole('button', { name: 'Remove Status filter' }).click();
  await expect.poll(() => page.url()).not.toContain('status=');
  await expect(page.getByRole('button', { name: 'Remove Status filter' })).toHaveCount(0);

  // A range of days: the colon is the axis name's alone, not drawn before
  // each date input (whose labels are visually hidden).
  await page.goto('/#/monitor/runs?from=2000-01-01&to=2100-01-01');
  await fluentRootReady(page);
  await expect(page.getByLabel('From day')).toHaveValue('2000-01-01');
  const colons = await page.evaluate(() =>
    [...document.querySelectorAll('.filter-pill label')]
      .filter((l) => getComputedStyle(l, '::after').content !== 'none')
      .map((l) => l.textContent),
  );
  expect(colons).toEqual(['Status', 'Pipeline', 'Started']);

  await expectQuiet(page, problems);
});
