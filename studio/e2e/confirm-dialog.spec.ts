import { expect, test, type Page } from '@playwright/test';
import { answerConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { tree } from './support/authorPane';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady, resolvedPaletteColor } from './support/theme';
import { arrowToItem } from './support/rowMenu';

/**
 * #1397 — the list pages' confirmations are an in-app alert dialog, not
 * `window.confirm`. The unit suites render it in jsdom, which has no focus
 * model worth the name and resolves no CSS, so the three things that make it
 * safe to put a destructive button on a dialog are only observable here: focus
 * lands on Cancel (never the action), Escape answers Cancel AND hands focus back
 * to the opener, and the action reads as the dangerous one.
 *
 * Driven entirely from the keyboard on purpose: a mouse-driven delete would pass
 * with focus wired to nothing.
 */

const KEYBOARD = 'e2e 1397 keyboard delete';
const DEPENDANT = 'e2e-1397-typed';

async function createPipeline(page: Page, name: string): Promise<void> {
  const res = await page.request.post('/api/pipelines', { data: { name } });
  expect(res.status(), `creating '${name}': ${await res.text()}`).toBe(201);
}

/** Open a row's menu and choose Delete without touching the mouse. */
async function chooseDeleteByKeyboard(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: `More actions for ${name}` }).focus();
  await page.keyboard.press('Enter');
  const del = page.getByRole('menuitem', { name: 'Delete' });
  await expect(del).toBeVisible();
  await arrowToItem(page, del);
  await page.keyboard.press('Enter');
}

test.describe('#1397 the confirmation dialog, by keyboard', () => {
  test('Escape cancels and returns focus to the row button; Tab+Enter deletes', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await createPipeline(page, KEYBOARD);
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);
    const link = tree(page).getByRole('link', { name: KEYBOARD, exact: true });
    await expect(link).toBeVisible();
    const opener = page.getByRole('button', { name: `More actions for ${KEYBOARD}` });

    // First ask: a safe default, then Escape.
    await chooseDeleteByKeyboard(page, KEYBOARD);
    const dialog = page.getByRole('alertdialog', { name: new RegExp(KEYBOARD) });
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
    await expect(cancel).toBeFocused();

    // The action reads as the dangerous one: the `danger` class, painting the
    // theme's error colour. Compared against what `--error` RESOLVES to, never a
    // hardcoded rgb (the palette differs per theme).
    const action = dialog.getByRole('button', { name: 'Delete', exact: true });
    await expect(action).toHaveClass(/\bdanger\b/);
    const painted = await action.evaluate((el) => getComputedStyle(el).color);
    expect(painted).toBe(await resolvedPaletteColor(page, '--error'));

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(link).toBeVisible();

    // Second ask: Tab off Cancel onto the action, Enter confirms.
    await chooseDeleteByKeyboard(page, KEYBOARD);
    await expect(cancel).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(action).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(link).toHaveCount(0);
    // Focus is not dropped on <body> by the closing dialog: the pane hands it
    // to the New pipeline button once the row has gone.
    await expect(page.locator('#factory-new-pipeline')).toBeFocused();

    // Gone from the server, not just this render.
    await page.reload();
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await expect(tree(page).getByRole('link', { name: KEYBOARD, exact: true })).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('a typed-name dialog keeps the action disabled until the name matches', async ({ page }) => {
    const problems = collectPageProblems(page);
    const connectionId = await seedConnection(page, {
      name: DEPENDANT,
      kind: 'sqlite',
      config: { file: '/tmp/e2e-1397.db' },
    });
    await seedDataset(page, {
      name: `${DEPENDANT}-orders`,
      kind: 'table',
      connectionId,
      config: { table: 'orders' },
      columns: [{ name: 'id', type: 'integer', nullable: false }],
    });
    await page.goto('/#/manage/connections');
    await page.getByRole('heading', { name: 'Connections' }).waitFor();
    await fluentRootReady(page);

    const row = page.getByRole('row', { name: new RegExp(DEPENDANT) });
    await row.getByRole('button', { name: /^Delete / }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const action = dialog.getByRole('button', { name: 'Delete', exact: true });
    const box = dialog.getByRole('textbox', { name: `Type ${DEPENDANT} to confirm` });
    // Focus lands on the name box, and the action cannot be reached by a stray Enter.
    await expect(box).toBeFocused();
    await expect(action).toBeDisabled();

    await box.fill(DEPENDANT.slice(0, -1));
    await expect(action).toBeDisabled();
    await box.fill(DEPENDANT);
    await expect(action).toBeEnabled();

    // Declined: a typed name unlocks the button, it does not press it.
    await answerConfirm(page, 'cancel');
    await expect(row).toBeVisible();

    await expectQuiet(page, problems);
  });

  /**
   * The Fluent modal hides everything BEHIND it from assistive tech
   * (`aria-hidden` on `#root`, applied by tabster on a 250ms debounce) and must
   * lift that when it closes. Measured while writing this spec: it did not — a
   * dialog open for longer than the debounce left `#root[aria-hidden=true]`
   * behind after Cancel AND after Escape, so every `getByRole` over the page (and
   * a screen reader) saw an empty app. A dialog answered inside the debounce
   * never gets hidden-then-stuck, which is why quick specs did not notice.
   *
   * The dwell below is the point: it makes the hidden state apply BEFORE the
   * answer, which is what a person reading a confirmation does.
   */
  for (const answer of ['accept', 'cancel'] as const) {
    test(`closing it (${answer}) leaves the app visible to assistive tech`, async ({ page }) => {
      const problems = collectPageProblems(page);
      const name = `e2e_1397_aria_${answer}`;
      const res = await page.request.post('/api/global-params', {
        data: { name, type: 'string', value: 'v' },
      });
      expect(res.status(), await res.text()).toBe(201);
      await page.goto('/#/manage/global-params');
      await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
      await fluentRootReady(page);

      await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      // While open, the page behind IS hidden — the premise of the check below.
      await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
      await answerConfirm(page, answer);

      await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden', 'true');
      // ...and the page is addressable by role again, as a user of AT would need.
      await expect(page.getByRole('heading', { name: 'Global parameters' })).toBeVisible();

      await expectQuiet(page, problems);
    });
  }

  // The page under the dialog can unmount with it OPEN: Back is not blocked by
  // an in-app modal the way it was by `window.confirm`.
  test('navigating Back with it open leaves the app visible to assistive tech', async ({
    page,
  }) => {
    const name = 'e2e_1397_aria_back';
    const res = await page.request.post('/api/global-params', {
      data: { name, type: 'string', value: 'v' },
    });
    expect(res.status(), await res.text()).toBe(201);
    await page.goto('/#/');
    await page.goto('/#/manage/global-params');
    await page.getByRole('heading', { name: 'Global parameters' }).waitFor();
    await fluentRootReady(page);

    await page.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
    await page.goBack();

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('#root')).not.toHaveAttribute('aria-hidden', 'true');
  });
});
