import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';

/**
 * #1396 OR5 slice 5 — inline validation on the drawer forms. A field is checked
 * when it is left after an edit, in a reserved slot that moves nothing; a
 * refused Save lists every invalid field in the footer's one alert and takes
 * focus to the first; a summary line takes focus to its field.
 */

async function openNew(page: Page, hub: 'connections' | 'datasets'): Promise<void> {
  await page.goto(`/#/manage/${hub}`);
  await page
    .getByRole('heading', { name: hub === 'connections' ? 'Connections' : 'Datasets' })
    .waitFor();
  await fluentRootReady(page);
  await page
    .getByRole('button', { name: hub === 'connections' ? 'New connection' : 'New dataset' })
    .click();
}

const connectionForm = (page: Page) => page.getByRole('form', { name: 'Connection form' });
const datasetForm = (page: Page) => page.getByRole('form', { name: 'Dataset form' });

test.describe('#1396 inline validation', () => {
  test('connection: blur, summary, focus, and nothing below moves', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const problems = collectPageProblems(page);
    await openNew(page, 'connections');
    const form = connectionForm(page);
    const name = form.getByLabel('Name', { exact: true });
    const timeout = form.getByLabel('Timeout (ms) — number', { exact: true });
    const secret = form.getByLabel('Secret', { exact: true });

    // Tabbing past the untouched Name raises nothing.
    await expect(name).toBeFocused();
    await name.press('Tab');
    await expect(name).toHaveAttribute('aria-invalid', 'false');

    // An edited field is checked when it is left, in a slot that was already there.
    // Measured as the GAP between the field and one below it: viewport positions
    // also move when focus scrolls the page.
    const gap = async () =>
      ((await secret.boundingBox())?.y ?? NaN) - ((await timeout.boundingBox())?.y ?? NaN);
    const before = await gap();
    await timeout.fill('soon');
    await timeout.press('Tab');
    await expect(timeout).toHaveAttribute('aria-invalid', 'true');
    await expect(timeout).toHaveAccessibleDescription(/^Must be a number/);
    expect(await gap()).toBe(before);
    await expect(form.getByRole('alert')).toHaveCount(0);

    // A refused Save: one alert listing both fields, focus on the first.
    await form.getByRole('button', { name: 'Create connection' }).click();
    const alert = form.getByRole('alert');
    await expect(alert).toHaveCount(1);
    await expect(alert).toContainText('Fix these 2 fields:');
    await expect(name).toBeFocused();
    await expect(name).toHaveAccessibleDescription('Enter a name.');

    // A summary line is drawn in the alert's colour, not the buttons' text colour.
    const colours = await alert.evaluate((el) => ({
      alert: getComputedStyle(el).color,
      line: getComputedStyle(el.querySelector('.form-errors-link')!).color,
    }));
    expect(colours.line).toBe(colours.alert);

    await alert.getByRole('button', { name: 'Timeout (ms): must be a number' }).click();
    await expect(timeout).toBeFocused();

    // Fixing both empties the summary, and it goes.
    await name.fill('e2e 1396 validation');
    await expect(alert).not.toContainText('Name:');
    await timeout.fill('');
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  test('dataset: a blank Columns is marked and focused on Save', async ({ page }) => {
    const problems = collectPageProblems(page);
    const stamp = Date.now();
    await seedConnection(page, {
      name: `e2e-1396-val-store-${stamp}`,
      kind: 'sqlite',
      config: { file: `/tmp/e2e-1396-val-${stamp}.db` },
    });
    await openNew(page, 'datasets');
    const form = datasetForm(page);
    await form.getByLabel('Name', { exact: true }).fill(`e2e-1396-val-${stamp}`);
    await form
      .getByLabel('Store', { exact: true })
      .selectOption({ label: `e2e-1396-val-store-${stamp} (SQLite)` });
    await form.getByLabel('Kind', { exact: true }).selectOption('table');
    await form.getByLabel('Table', { exact: true }).fill('orders');
    await form.getByRole('button', { name: 'Create dataset' }).click();

    const columns = form.getByLabel('Columns (JSON)', { exact: true });
    await expect(columns).toBeFocused();
    await expect(columns).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByRole('alert')).toContainText('Columns (JSON): Columns is required');
    await expect(form.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'false');

    await columns.fill('[]');
    await expect(columns).toHaveAttribute('aria-invalid', 'false');
    await expect(form.getByRole('alert')).toHaveCount(0);
    await expectQuiet(page, problems);
  });
});
