import { expect, test, type Locator } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1694 OR42 slice 4 — field widths in the properties pane, measured at
 * 1440×900. A unit is a suffix inside its box (`30` `s`), so a label holds its
 * title alone and never wraps, while the field's name keeps the unit. A copy
 * mapping's name columns read whole. Every control's size class across the
 * catalog is held by `property-pane-ratchet.spec.ts`.
 */
test.use({ viewport: { width: 1440, height: 900 } });

/** The box, its drawn suffix, and its label's one line. */
function unitGeometry(field: Locator) {
  return field.evaluate((input: HTMLInputElement) => {
    const box = input.getBoundingClientRect();
    const suffix = input.parentElement!.querySelector('.input-unit__suffix');
    const label = input.labels![0]!;
    return {
      width: Math.round(box.width),
      suffix: suffix?.textContent ?? null,
      suffixInside:
        suffix !== null &&
        suffix.getBoundingClientRect().right <= box.right &&
        suffix.getBoundingClientRect().left >= box.left,
      labelLines: Math.round(
        label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight),
      ),
    };
  });
}

test('a unit is a suffix inside an S box; the label is the title alone and the name keeps the unit', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 unit suffixes', {
    nodes: [
      { id: 'w', type: 'wait', position: { x: 0, y: 0 }, config: { seconds: '${30}' } },
      {
        id: 'c',
        type: 'copy',
        position: { x: 320, y: 0 },
        config: { mapping: [{ source: 'id', sink: 'id', type: 'integer' }] },
      },
    ],
  });
  await nodeById(page, 'w').click();
  const seconds = properties(page).getByRole('textbox', {
    name: 'Wait time (seconds)',
    exact: true,
  });
  await expect(seconds).toHaveValue('${30}');
  expect(await unitGeometry(seconds)).toEqual({
    width: 120,
    suffix: 's',
    suffixInside: true,
    labelLines: 1,
  });

  // A copy times out; a wait does not.
  await nodeById(page, 'c').click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  const interval = properties(page).getByRole('textbox', {
    name: 'Retry interval (seconds)',
    exact: true,
  });
  expect(await unitGeometry(interval)).toEqual({
    width: 120,
    suffix: 's',
    suffixInside: true,
    labelLines: 1,
  });
  // #1680 — a duration shows its units in its value (`12:00:00`), so no suffix.
  const timeout = properties(page).getByRole('textbox', {
    name: 'Timeout (duration)',
    exact: true,
  });
  expect(await unitGeometry(timeout)).toEqual({
    width: 120,
    suffix: null,
    suffixInside: false,
    labelLines: 1,
  });
  // The `?` keeps the field's whole name.
  await expect(
    properties(page).getByLabel('About Retry interval (seconds)', { exact: true }),
  ).toBeVisible();
  await expectQuiet(page, problems);
});

const COLUMNS = [
  'order_id',
  'customer_id',
  'order_date',
  'ship_country',
  'unit_price',
  'quantity',
  'discount',
  'freight',
  'created_at',
];

test('a copy mapping reads whole: name columns at least 160px, nine rows unclipped, no sideways scroll, a blank On error', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await openSeededCanvas(page, 'or42 mapping widths', {
    nodes: [
      {
        id: 'c',
        type: 'copy',
        position: { x: 0, y: 0 },
        config: {
          mapping: COLUMNS.map((name) => ({ source: name, sink: name, type: 'string' })),
        },
      },
    ],
  });
  await nodeById(page, 'c').click();
  await properties(page)
    .getByRole('tablist', { name: 'Activity properties' })
    .getByRole('tab', { name: 'Mapping' })
    .click();
  const table = properties(page).getByRole('table').first();
  await expect(table.locator('tbody > tr:not(.row-table__notes)')).toHaveCount(COLUMNS.length);

  const m = await table.evaluate((t) => {
    const header = (text: string) =>
      Array.from(t.querySelectorAll('thead th')).find((th) =>
        (th.textContent ?? '').startsWith(text),
      )!;
    const scroller = t.parentElement!;
    const names = Array.from(
      t.querySelectorAll<HTMLInputElement>('tbody td[data-width="name"] input'),
    );
    const onError = Array.from(t.querySelectorAll('tbody select')).filter((s) =>
      (s as HTMLSelectElement).labels?.[0]?.textContent?.includes('on error'),
    ) as HTMLSelectElement[];
    return {
      // The floor itself, which bites in a narrower dock than this one: at
      // 1440 the table has the room either way.
      floors: Array.from(
        t.querySelectorAll('thead th[data-width="name"]'),
        (th) => getComputedStyle(th).minWidth,
      ),
      source: Math.round(header('Source').getBoundingClientRect().width),
      sink: Math.round(header('Sink').getBoundingClientRect().width),
      nameCells: names.length,
      clipped: names
        .filter((input) => input.scrollWidth > input.clientWidth)
        .map((input) => input.value),
      scrolls: scroller.scrollWidth > scroller.clientWidth,
      onError: onError.map((s) => s.options[s.selectedIndex]!.text),
    };
  });
  expect(m.floors).toEqual(['160px', '160px']);
  expect(m.source).toBeGreaterThanOrEqual(160);
  expect(m.sink).toBeGreaterThanOrEqual(160);
  expect(m.nameCells).toBe(COLUMNS.length * 2);
  expect(m.clipped).toEqual([]);
  expect(m.scrolls).toBe(false);
  expect(m.onError).toEqual(COLUMNS.map(() => ''));
  await expectQuiet(page, problems);
});
