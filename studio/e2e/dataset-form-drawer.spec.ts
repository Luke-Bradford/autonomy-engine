import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection, seedDataset } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1396 OR5 slice 2 — the Datasets page on the shared form pattern: the form
 * opens in a drawer BESIDE the list, in sections, with the kind's display name
 * and titled fields (the stored key kept in the hint), a footer that stays in
 * view, and the unsaved-changes guard on Escape and on a route change.
 */

async function gotoDatasets(page: Page): Promise<void> {
  await page.goto('/#/manage/datasets');
  await page.getByRole('heading', { name: 'Datasets' }).waitFor();
  await fluentRootReady(page);
}

const drawer = (page: Page) => page.getByRole('dialog', { name: /dataset$/ });
const form = (page: Page) => page.getByRole('form', { name: 'Dataset form' });
const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Unsaved changes' });

test.describe('#1396 the dataset form drawer', () => {
  test('opens beside the list, with titled fields and the row actions reachable', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const store = await seedConnection(page, {
      name: `e2e-1396-ds-store-${stamp}`,
      kind: 'sqlite',
      config: { file: `/tmp/e2e-1396-${stamp}.db` },
    });
    const seeded = `e2e-1396-ds-${stamp}`;
    await seedDataset(page, {
      name: seeded,
      kind: 'table',
      connectionId: store,
      config: { table: 'orders' },
      columns: [],
    });
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await expect(drawer(page)).toBeVisible();

    // A column to the right of the list, not an overlay on top of it, and the
    // list keeps a usable width beside it. Earlier specs leave rows here, so the
    // row is brought into view first.
    await page.getByRole('button', { name: `Edit ${seeded}` }).scrollIntoViewIfNeeded();
    const geometry = await page.evaluate((name) => {
      const list = document.querySelector('.drawer-layout-open > :first-child')!;
      const column = list.getBoundingClientRect();
      const aside = document.querySelector('.form-drawer')!.getBoundingClientRect();
      const edit = document.querySelector(`[aria-label="Edit ${name}"]`)!;
      const box = edit.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        drawerRightOfList: aside.left >= column.right,
        // Not squeezed into what is left of the 900px reading width.
        listWidthKept: column.width >= 700,
        editReachable: hit === edit,
        listKind: [...document.querySelectorAll('tbody tr')]
          .find((row) => row.textContent?.includes(name))
          ?.querySelectorAll('td')[1]?.textContent,
      };
    }, seeded);
    expect(geometry).toEqual({
      drawerRightOfList: true,
      listWidthKept: true,
      editReachable: true,
      listKind: 'Database table',
    });

    // The kind's display name, a titled field, and its key kept in the hint.
    await form(page).getByLabel('Store').selectOption(store);
    await form(page).getByLabel('Kind').selectOption('table');
    await expect(form(page).getByLabel('Kind').locator('option:checked')).toHaveText(
      'Database table',
    );
    // #1413 — and what that kind is, under the picker.
    await expect(form(page).getByLabel('Kind')).toHaveAccessibleDescription(
      'One table in a database, read in full, or on SQLite also written to by a copy.',
    );
    await expect(
      form(page).locator('.field-hint', { hasText: /^One table in a database/ }),
    ).toBeVisible();
    const table = form(page).getByLabel('Table', { exact: true });
    await expect(table).toHaveAttribute('aria-required', 'true');
    await expect(table).toHaveAccessibleDescription(/bare identifier.*table/);
    await expect(form(page).getByLabel('Columns (JSON)')).toHaveAttribute('aria-required', 'true');

    // Sections, with Advanced closed on a new dataset.
    for (const section of ['Basics', 'Dataset', 'Columns']) {
      await expect(form(page).getByRole('group', { name: section })).toBeVisible();
    }
    await expect(form(page).getByRole('group', { name: 'Overridable per node' })).toBeHidden();
    await expectQuiet(page, problems);
  });

  test('on a narrower window the list scrolls in its own column, never under the drawer', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const store = await seedConnection(page, {
      name: `e2e-1396-ds-narrow-store-with-a-long-name-${stamp}`,
      kind: 'sqlite',
      config: { file: `/tmp/e2e-1396-narrow-${stamp}.db` },
    });
    const seeded = `e2e-1396-ds-narrow-dataset-with-a-long-name-${stamp}`;
    await seedDataset(page, {
      name: seeded,
      kind: 'table',
      connectionId: store,
      config: { table: 'orders' },
      columns: [],
    });
    await page.setViewportSize({ width: 1100, height: 800 });
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    // The row's Edit button can be brought into view and clicked: it is never
    // left painted under the drawer.
    const edit = page.getByRole('button', { name: `Edit ${seeded}` });
    await edit.scrollIntoViewIfNeeded();
    const reachable = await edit.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const aside = document.querySelector('.form-drawer')!.getBoundingClientRect();
      return {
        hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el,
        leftOfDrawer: box.right <= aside.left,
      };
    });
    expect(reachable).toEqual({ hit: true, leftOfDrawer: true });
    await expectQuiet(page, problems);
  });

  test('the footer stays in view, primary last', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1280, height: 560 });
    await gotoDatasets(page);
    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Kind').selectOption('delimited');

    const drawerBottom = await drawer(page).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(drawerBottom).toBeGreaterThan(560);
    await expect(form(page).getByRole('button', { name: 'Create dataset' })).toBeInViewport();
    const order = await page.evaluate(() => {
      const footer = document.querySelector('.form-drawer-footer')!;
      const buttons = [...footer.querySelectorAll('button')];
      const last = buttons.at(-1)!.getBoundingClientRect();
      return {
        labels: buttons.map((b) => b.textContent),
        flushRight: footer.getBoundingClientRect().right - last.right < 40,
      };
    });
    expect(order).toEqual({ labels: ['Cancel', 'Create dataset'], flushRight: true });
    await expectQuiet(page, problems);
  });

  test('a dirty form is held on Escape and on a route change; a saved one closes', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    const store = await seedConnection(page, {
      name: `e2e-1396-ds-guard-${stamp}`,
      kind: 'sqlite',
      config: { file: `/tmp/e2e-1396-guard-${stamp}.db` },
    });
    await gotoDatasets(page);

    // Clean: Escape just closes.
    await page.getByRole('button', { name: 'New dataset' }).click();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();

    await page.getByRole('button', { name: 'New dataset' }).click();
    await form(page).getByLabel('Name').fill('half-typed');
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(form(page).getByLabel('Name')).toHaveValue('half-typed');

    await page
      .getByRole('navigation', { name: 'Manage sections' })
      .getByRole('link', { name: 'Connections' })
      .click();
    await expect(prompt(page)).toBeVisible();
    expect(page.url()).toContain('#/manage/datasets');
    await page.getByRole('button', { name: 'Keep editing' }).click();

    // Saving closes the drawer without asking.
    const name = `e2e-1396-ds-saved-${stamp}`;
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Store').selectOption(store);
    await form(page).getByLabel('Kind').selectOption('table');
    await form(page).getByLabel('Table', { exact: true }).fill('orders');
    await form(page).getByLabel('Columns (JSON)').fill('[]');
    await form(page).getByRole('button', { name: 'Create dataset' }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
    await expectQuiet(page, problems);
  });
});
