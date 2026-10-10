import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas, rectOf, type SeedDoc } from './support/seedDoc';
import { properties } from './support/panels';

/**
 * #1475 OR27 slice 4 — the Problems column beside the properties is the
 * operator's to size, and the dock remembers its tab. Before this Problems was
 * a fixed 20rem column and both tab choices reset on every reload.
 *
 * Boxes, not computed styles, and every persistence claim is checked across a
 * real reload.
 */

const seed: SeedDoc = {
  nodes: [
    {
      id: 'a',
      type: 'http_request',
      position: { x: 0, y: 0 },
      config: { url: 'https://a.example.test' },
    },
  ],
};

/** Not the nav pane's, the dock's or the toolbox's separator, which are on this page too. */
function divider(page: Page) {
  return page.getByRole('separator', { name: 'Resize problems' });
}

function problemsList(page: Page) {
  return page.getByRole('region', { name: 'Problems', exact: true });
}

/** Problems, the properties beside it (no run drawer is showing), and the body both share. */
async function widths(page: Page) {
  const [list, panel, body] = await Promise.all([
    rectOf(page, '.problems-panel'),
    rectOf(page, '.property-dock__body > .property-panel'),
    rectOf(page, '.property-dock__body'),
  ]);
  return {
    problems: Math.round(list.width),
    panel: Math.round(panel.width),
    body: body.width,
  };
}

test('#1475 dragging the Problems divider left widens it, the properties give up the same, and it stays after a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 problems drag ${Date.now()}`, seed);
  const before = await widths(page);
  expect(before.problems).toBe(320);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '320');

  const box = (await divider(page).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 30, y, { steps: 4 });
  await page.mouse.move(x - 60, y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(async () => (await widths(page)).problems).toBe(380);
  const after = await widths(page);
  expect(before.panel - after.panel).toBe(60);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '380');

  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect.poll(async () => (await widths(page)).problems).toBe(380);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '380');
  await expectQuiet(page, problems);
});

test('#1475 the Problems divider steps from the keyboard, stops at half the dock, and goes with Problems', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 problems keys ${Date.now()}`, seed);

  await divider(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '336');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '304');
  await page.keyboard.press('Home');
  await expect(divider(page)).toHaveAttribute('aria-valuenow', '200');
  expect((await widths(page)).problems).toBe(200);

  // The cap is half the body, and what the divider reports is what is drawn.
  // `capOf` restates `problemsMaxWidth` on purpose: the spec checks the rule
  // from outside rather than importing the code under test.
  const capOf = (body: number) => Math.max(200, Math.floor(Math.min(480, body / 2)));
  await page.keyboard.press('End');
  const wide = capOf((await widths(page)).body);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(wide));
  await expect(divider(page)).toHaveAttribute('aria-valuemax', String(wide));
  expect((await widths(page)).problems).toBe(wide);

  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(wide));

  // On a smaller window the width chosen on the larger one is cut to THIS
  // body's half, drawn and reported alike, and not overwritten.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect
    .poll(async () => {
      const now = await widths(page);
      return now.problems === capOf(now.body);
    })
    .toBe(true);
  const narrow = (await widths(page)).problems;
  expect(narrow).toBeLessThan(wide);
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(narrow));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(wide));

  // Folding Problems takes its divider with it, and the properties get the
  // whole body; unfolding puts both back as they were.
  const open = await widths(page);
  await page.getByRole('button', { name: /^Problems/ }).click();
  await expect(problemsList(page)).toBeHidden();
  await expect(divider(page)).toHaveCount(0);
  const folded = Math.round((await rectOf(page, '.property-dock__body > .property-panel')).width);
  expect(folded).toBe(Math.round(open.body));
  await page.getByRole('button', { name: /^Problems/ }).click();
  await expect(divider(page)).toHaveAttribute('aria-valuenow', String(wide));
  expect((await widths(page)).panel).toBe(open.panel);
  // So does folding the dock.
  await page.getByRole('button', { name: 'Hide properties' }).click();
  await expect(divider(page)).toBeHidden();
  await expectQuiet(page, problems);
});

test('#1475 the dock remembers its pipeline tab and its activity tab across a reload', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSeededCanvas(page, `e2e 1475 dock tabs ${Date.now()}`, seed);

  // Nothing selected: the pipeline's own tabs.
  await properties(page).getByRole('tab', { name: 'Variables' }).click();
  await page.getByTestId('rf__node-a').click();
  await properties(page).getByRole('tab', { name: 'General' }).click();
  await expect(properties(page).getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  await page.reload();
  await expect(page.locator('.react-flow')).toBeVisible();
  await expect(properties(page).getByRole('tab', { name: 'Variables' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByTestId('rf__node-a').click();
  await expect(properties(page).getByRole('tab', { name: 'General' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectQuiet(page, problems);
});
