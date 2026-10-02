import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { triggerForm } from './support/panels';
import { fluentRootReady } from './support/theme';
import { rowMenuButton } from './support/rowMenu';

/**
 * #1396 OR5 slice 4 — the Triggers page on the shared form pattern: the form
 * opens in a drawer BESIDE the list, in sections, with display names for the
 * mode and the concurrency policy, a footer that stays in view with the primary
 * action last, and the unsaved-changes guard on Escape and on a route change.
 */

async function gotoTriggers(page: Page): Promise<void> {
  await page.goto('/#/manage/triggers');
  await page.getByRole('heading', { name: 'Triggers' }).waitFor();
  await fluentRootReady(page);
}

const drawer = (page: Page) => page.getByRole('dialog', { name: /trigger$/ });
const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Unsaved changes' });

async function seedTrigger(page: Page, name: string): Promise<void> {
  const res = await page.request.post('/api/triggers', {
    data: {
      name,
      pipelineVersionId: null,
      params: {},
      mode: 'schedule',
      schedule: null,
      webhook: null,
      runWindows: null,
      concurrency: { policy: 'skip_if_running' },
      enabled: false,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test.describe('#1396 the trigger form drawer', () => {
  test('opens beside the list, in sections, with display names', async ({ page }) => {
    const problems = collectPageProblems(page);
    const seeded = `e2e-1396-trg-${Date.now()}`;
    await seedTrigger(page, seeded);
    await gotoTriggers(page);
    await page.getByRole('button', { name: 'New trigger' }).click();
    await expect(drawer(page)).toBeVisible();

    // #1397 — Edit is in the row's ⋯ menu, so the menu button is what must stay
    // reachable beside the open drawer.
    await rowMenuButton(page, seeded).scrollIntoViewIfNeeded();
    const geometry = await page.evaluate((name) => {
      const list = document.querySelector('.drawer-layout-open > :first-child')!;
      const column = list.getBoundingClientRect();
      const aside = document.querySelector('.form-drawer')!.getBoundingClientRect();
      const menu = document.querySelector(`[aria-label="Actions for ${name}"]`)!;
      const box = menu.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        drawerRightOfList: aside.left >= column.right,
        // The ⋯ button's hit point lands on its icon, which is inside it.
        menuReachable: hit !== null && menu.contains(hit),
        listMode: [...document.querySelectorAll('tbody tr')]
          .find((row) => row.textContent?.includes(name))
          ?.querySelectorAll('td')[1]?.textContent,
        focused: document.activeElement?.getAttribute('type'),
      };
    }, seeded);
    expect(geometry).toEqual({
      drawerRightOfList: true,
      menuReachable: true,
      listMode: 'Schedule',
      // The drawer puts focus on its first field, the Name.
      focused: 'text',
    });

    const form = triggerForm(page);
    for (const section of ['Basics', 'Pipeline', 'Firing', 'Concurrency', 'Parameters']) {
      await expect(form.getByRole('group', { name: section })).toBeVisible();
    }
    await expect(form.getByLabel('Name')).toHaveAttribute('required', '');
    await form.getByLabel('Mode', { exact: true }).selectOption('tumbling');
    await expect(form.getByLabel('Mode', { exact: true }).locator('option:checked')).toHaveText(
      'Tumbling window',
    );
    // #1413 — the picker says what the chosen mode does.
    await expect(form.getByLabel('Mode', { exact: true })).toHaveAccessibleDescription(
      'Runs once for each fixed-size time window, when that window closes.',
    );
    await expect(
      form.getByLabel('Concurrency', { exact: true }).locator('option:checked'),
    ).toHaveText('Queue');
    await expectQuiet(page, problems);
  });

  test('the footer stays in view, primary last', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1280, height: 560 });
    await gotoTriggers(page);
    await page.getByRole('button', { name: 'New trigger' }).click();
    await triggerForm(page).getByLabel('Mode', { exact: true }).selectOption('schedule');

    const drawerBottom = await drawer(page).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(drawerBottom).toBeGreaterThan(560);
    await expect(
      triggerForm(page).getByRole('button', { name: 'Create trigger' }),
    ).toBeInViewport();
    const order = await page.evaluate(() => {
      const footer = document.querySelector('.form-drawer-footer')!;
      const buttons = [...footer.querySelectorAll('button')];
      const last = buttons.at(-1)!.getBoundingClientRect();
      return {
        labels: buttons.map((b) => b.textContent),
        flushRight: footer.getBoundingClientRect().right - last.right < 40,
      };
    });
    expect(order).toEqual({ labels: ['Cancel', 'Create trigger'], flushRight: true });
    await expectQuiet(page, problems);
  });

  test('a dirty form is held on Escape and on a route change; a saved one closes', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await gotoTriggers(page);

    // Clean: Escape just closes.
    await page.getByRole('button', { name: 'New trigger' }).click();
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();

    await page.getByRole('button', { name: 'New trigger' }).click();
    await triggerForm(page).getByLabel('Name').fill('half-typed');
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(triggerForm(page).getByLabel('Name')).toHaveValue('half-typed');

    await page
      .getByRole('navigation', { name: 'Manage sections' })
      .getByRole('link', { name: 'Connections' })
      .click();
    await expect(prompt(page)).toBeVisible();
    expect(page.url()).toContain('#/manage/triggers');
    await page.getByRole('button', { name: 'Keep editing' }).click();

    // Saving closes the drawer without asking.
    const name = `e2e-1396-trg-saved-${Date.now()}`;
    await triggerForm(page).getByLabel('Name').fill(name);
    await triggerForm(page).getByRole('button', { name: 'Create trigger' }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
    await expectQuiet(page, problems);
  });
});
