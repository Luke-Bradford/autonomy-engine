import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1396 OR5 slice 1 — the shared form pattern on the Connections page: the
 * form opens in a drawer BESIDE the list, in sections, with human labels and
 * required marks, a footer that stays in view, and an unsaved-changes guard on
 * every way out (Escape, Cancel, another row's Edit, a route change).
 */

async function gotoConnections(page: Page): Promise<void> {
  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
}

const drawer = (page: Page) => page.getByRole('dialog', { name: /connection$/ });
const form = (page: Page) => page.getByRole('form', { name: 'Connection form' });
const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Unsaved changes' });

test.describe('#1396 the connection form drawer', () => {
  test('opens beside the list, with human labels and the row actions still reachable', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const seeded = `e2e 1396 seeded ${Date.now()}`;
    await seedConnection(page, { name: seeded, kind: 'ollama', config: {} });
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();
    await expect(drawer(page)).toBeVisible();

    // A column to the right of the list, not an overlay on top of it.
    const geometry = await page.evaluate((name) => {
      const table = document.querySelector('table')!.getBoundingClientRect();
      const aside = document.querySelector('.form-drawer')!.getBoundingClientRect();
      const edit = document.querySelector(`[aria-label="Edit ${name}"]`)!;
      const box = edit.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return {
        drawerRightOfTable: aside.left >= table.right,
        editReachable: hit === edit,
        listKind: [...document.querySelectorAll('tbody tr')]
          .find((row) => row.textContent?.includes(name))
          ?.querySelectorAll('td')[1]?.textContent,
      };
    }, seeded);
    expect(geometry).toEqual({ drawerRightOfTable: true, editReachable: true, listKind: 'Ollama' });

    // Human labels, the stored key kept beside them, and the kind's display name.
    await expect(form(page).getByLabel('Kind')).toHaveValue('anthropic_api');
    await expect(form(page).getByLabel('Kind').locator('option:checked')).toHaveText(
      'Anthropic API',
    );
    const timeout = form(page).getByLabel('Timeout (ms)', { exact: true });
    await expect(timeout).toBeVisible();
    await expect(timeout).toHaveAccessibleDescription(/How long one request may take\..*timeoutMs/);
    await expect(form(page).getByLabel('Base URL', { exact: true })).toBeVisible();

    // Required: the asterisk is drawn (and kept out of the name), the control says so.
    await form(page).getByLabel('Kind').selectOption('fs');
    const roots = form(page).getByLabel(/^Allowed folders/);
    await expect(roots).toHaveAttribute('aria-required', 'true');
    const marks = await page.evaluate(() => {
      const nameLabel = [...document.querySelectorAll('.form-drawer label')].find((label) =>
        label.textContent?.startsWith('Name'),
      )!;
      const mark = nameLabel.querySelector('.required-mark')!;
      return {
        content: getComputedStyle(mark, '::after').content,
        hidden: mark.getAttribute('aria-hidden'),
        labelText: nameLabel.textContent,
      };
    });
    expect(marks).toEqual({ content: '"*"', hidden: 'true', labelText: 'Name' });

    // Advanced starts closed on a new connection.
    await expect(form(page).getByRole('group', { name: 'Overridable per node' })).toBeHidden();
    await expectQuiet(page, problems);
  });

  test('the footer stays in view while a long form scrolls', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1280, height: 560 });
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Kind').selectOption('agent_cli');

    // The form runs past the bottom of the window…
    const drawerBottom = await drawer(page).evaluate((el) => el.getBoundingClientRect().bottom);
    expect(drawerBottom).toBeGreaterThan(560);
    const create = form(page).getByRole('button', { name: 'Create connection' });
    // …and Save is still on screen, at the bottom edge of it.
    await expect(create).toBeInViewport();
    // Primary last, right-aligned.
    const order = await page.evaluate(() => {
      const footer = document.querySelector('.form-drawer-footer')!;
      const buttons = [...footer.querySelectorAll('button')];
      const last = buttons.at(-1)!.getBoundingClientRect();
      return {
        labels: buttons.map((b) => b.textContent),
        flushRight: footer.getBoundingClientRect().right - last.right < 40,
      };
    });
    expect(order).toEqual({
      labels: ['Cancel', 'Test connection', 'Create connection'],
      flushRight: true,
    });
    await expectQuiet(page, problems);
  });

  test('a dirty form is held at a prompt on Escape and on a route change', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();

    // Clean: Escape just closes.
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toBeHidden();

    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Name').fill('half-typed');
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep editing' })).toBeFocused();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(form(page).getByLabel('Name')).toHaveValue('half-typed');

    // Leaving for another page is held too.
    await page
      .getByRole('navigation', { name: 'Manage sections' })
      .getByRole('link', { name: 'Datasets' })
      .click();
    await expect(prompt(page)).toBeVisible();
    expect(page.url()).toContain('#/manage/connections');
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('heading', { name: 'Datasets' }).waitFor();
    await expectQuiet(page, problems);
  });

  test('a saved form closes without asking', async ({ page }) => {
    const problems = collectPageProblems(page);
    const name = `e2e 1396 create ${Date.now()}`;
    await gotoConnections(page);
    await page.getByRole('button', { name: 'New connection' }).click();
    await form(page).getByLabel('Name').fill(name);
    await form(page).getByLabel('Kind').selectOption('ollama');
    await form(page).getByRole('button', { name: 'Create connection' }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(prompt(page)).toBeHidden();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
    await expectQuiet(page, problems);
  });
});
