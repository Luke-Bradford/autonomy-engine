import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { seedConnection } from './support/seedResources';
import { fluentRootReady } from './support/theme';
import { openNewConnection } from './support/newConnection';

/**
 * #1396 OR5 slice 5 — inline validation on the drawer forms. A field is checked
 * when it is left after an edit, in a reserved slot that moves nothing; a
 * refused Save lists every invalid field in the footer's one alert and takes
 * focus to the first; a summary line takes focus to its field.
 *
 * Slice 6 put Secrets, Global parameters and the trigger form's own fields on
 * the same pattern. Under `noValidate` the browser no longer refuses a
 * half-typed number, so the trigger form refuses it itself.
 *
 * Slice 13 keyed the trigger mode editors' controls as fields too: a refusal
 * sits beside the control it is about, not only in the footer.
 */

async function openNew(page: Page, hub: 'connections' | 'datasets'): Promise<void> {
  await page.goto(`/#/manage/${hub}`);
  await page
    .getByRole('heading', { name: hub === 'connections' ? 'Connections' : 'Datasets' })
    .waitFor();
  await fluentRootReady(page);
  // #1477 — a new connection starts in the kind gallery; these cases were
  // written against the form's old default kind.
  if (hub === 'connections') await openNewConnection(page, 'anthropic_api');
  else await page.getByRole('button', { name: 'New dataset' }).click();
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
    const timeout = form.getByLabel('Timeout (ms)', { exact: true });
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

  test('secret: the summary lists Name and Value, and a fix clears its line', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    const problems = collectPageProblems(page);
    await page.goto('/#/manage/secrets');
    await page.getByRole('heading', { name: 'Secrets' }).waitFor();
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New secret' }).click();
    const form = page.getByRole('form', { name: 'Secret form' });
    const name = form.getByLabel('Name', { exact: true });
    const value = form.getByLabel('Value', { exact: true });

    await form.getByRole('button', { name: 'Create secret' }).click();
    const alert = form.getByRole('alert');
    await expect(alert).toContainText('Fix these 2 fields:');
    await expect(name).toBeFocused();
    await alert.getByRole('button', { name: 'Value: Enter a value.' }).click();
    await expect(value).toBeFocused();
    await expect(value).toHaveAccessibleDescription('Enter a value.');

    await value.fill('sk_e2e_1396');
    await expect(value).toHaveAttribute('aria-invalid', 'false');
    await expect(alert).toContainText('Fix this field:');
    await name.fill('bad name ');
    await name.press('Tab');
    await expect(name).toHaveAccessibleDescription(/leading\/trailing whitespace/);
    await expectQuiet(page, problems);
  });

  test('trigger: own fields are marked, and a half-typed number is refused, not read as blank', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/manage/triggers');
    await page.getByRole('heading', { name: 'Triggers' }).waitFor();
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New trigger' }).click();
    const form = page.getByRole('form', { name: 'Trigger form' });
    const name = form.getByLabel('Name', { exact: true });

    await form.getByLabel('Concurrency', { exact: true }).selectOption('parallel');
    await form.getByLabel('Params (JSON)', { exact: true }).fill('[1]');
    await form.getByRole('button', { name: 'Create trigger' }).click();
    const alert = form.getByRole('alert');
    await expect(alert).toContainText('Fix these 3 fields:');
    await expect(name).toBeFocused();
    await expect(form.getByLabel('Max parallel runs')).toHaveAttribute('aria-invalid', 'true');

    await name.fill(`e2e-1396-trigger-${Date.now()}`);
    await form.getByLabel('Max parallel runs').fill('2');
    await form.getByLabel('Params (JSON)', { exact: true }).fill('{}');
    await expect(form.getByRole('alert')).toHaveCount(0);

    // A real bad input: Chromium keeps `1e` in a number box but reports ''.
    await form.getByLabel('Mode', { exact: true }).selectOption('schedule');
    const interval = form.getByLabel(/Repeat every/);
    await interval.fill('');
    await interval.pressSequentially('1e');
    expect(await interval.evaluate((el) => (el as HTMLInputElement).validity.badInput)).toBe(true);
    await form.getByRole('button', { name: 'Create trigger' }).click();
    await expect(form.getByRole('alert')).toContainText('is not a complete number');
    await expect(interval).toBeFocused();
    // Nothing was created: the list still has no row by that name.
    await expect(page.getByRole('row', { name: /e2e-1396-trigger-/ })).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  test('trigger: a mode editor refusal sits beside its control, and nothing below moves', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/manage/triggers');
    await page.getByRole('heading', { name: 'Triggers' }).waitFor();
    await fluentRootReady(page);
    await page.getByRole('button', { name: 'New trigger' }).click();
    const form = page.getByRole('form', { name: 'Trigger form' });
    await form.getByLabel('Name', { exact: true }).fill(`e2e-1396-mode-${Date.now()}`);
    await form.getByLabel('Mode', { exact: true }).selectOption('schedule');

    // A weekly with no day ticked: Save marks the days and takes focus there.
    await form.getByLabel('Frequency', { exact: true }).selectOption('week');
    await form.getByRole('button', { name: 'Create trigger' }).click();
    const days = form.getByRole('group', { name: /Days of week/ });
    await expect(days).toHaveAttribute('data-invalid', 'true');
    await expect(form.getByRole('alert')).toContainText('Days of week:');
    await expect(form.getByRole('checkbox', { name: 'Sun' })).toBeFocused();
    await form.getByRole('checkbox', { name: 'Mon' }).check();
    await expect(days).not.toHaveAttribute('data-invalid');

    // A bad Hours entry shows on leaving the field, in a slot that moves nothing.
    const hours = form.getByLabel(/^Hours/);
    const below = form.getByLabel(/^End time/);
    const before = await below.boundingBox();
    await hours.fill('9, x');
    await expect(hours).toHaveAttribute('aria-invalid', 'false');
    await hours.press('Tab');
    await expect(hours).toHaveAttribute('aria-invalid', 'true');
    await expect(hours).toHaveAccessibleDescription(/'x' is not a whole number/);
    expect((await below.boundingBox())?.y).toBe(before?.y);

    await hours.fill('9');
    await hours.press('Tab');
    await expect(hours).toHaveAttribute('aria-invalid', 'false');
    await expectQuiet(page, problems);
  });
});
