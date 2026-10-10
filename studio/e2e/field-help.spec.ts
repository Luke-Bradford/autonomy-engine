import { expect, test, type Locator, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openNewConnection } from './support/newConnection';
import { fluentRootReady } from './support/theme';

/**
 * #1594 OR40 S3c-2 — labels, not prose: what a drawer field is FOR sits behind
 * a `?` beside its label, not in a paragraph under the control. For each moved
 * field, measured at 1440x900:
 * - the `?` is named "About {field}" and sits in the label column, right of
 *   the label and left of the control;
 * - the note is not shown until the `?` is opened, and Escape closes it;
 * - the note is still the control's description, so a screen reader hears it.
 * A section that holds the one field takes its note behind the SECTION's `?`
 * instead: a field `?` there would repeat the section's name ("About Value").
 */
test.use({ viewport: { width: 1440, height: 900 } });

async function expectBehindHelp(page: Page, scope: Locator, field: string, note: RegExp) {
  // Within the field's row: a section can share the field's name.
  const control = scope.locator('.labelled-control').getByLabel(field, { exact: true });
  await expect(control, `${field}: the note describes the control`).toHaveAccessibleDescription(
    note,
  );
  const text = scope.getByText(note);
  await expect(text, `${field}: the note is not a paragraph on the form`).toBeHidden();

  const help = scope.getByLabel(`About ${field}`, { exact: true });
  const at = await help.evaluate((summary) => {
    const row = summary.closest('.labelled-control')!;
    // The label beside the `?`, in their head row.
    const label = summary.closest('.labelled-control__head')!.querySelector('label')!;
    const control = (label as HTMLLabelElement).control!;
    const cell = [...row.children].find((c) => c.contains(control))!;
    return {
      helpLeft: summary.getBoundingClientRect().left,
      helpRight: summary.getBoundingClientRect().right,
      labelRight: label.getBoundingClientRect().right,
      cellLeft: cell.getBoundingClientRect().left,
    };
  });
  expect(at.helpLeft, `${field}: the ? follows its label`).toBeGreaterThanOrEqual(at.labelRight);
  expect(at.helpRight, `${field}: the ? is in the label column`).toBeLessThanOrEqual(at.cellLeft);

  await help.click();
  await expect(text, `${field}: the ? opens the note`).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(text, `${field}: Escape closes it`).toBeHidden();
}

async function expectInSectionHelp(page: Page, scope: Locator, section: string, note: RegExp) {
  const group = scope.getByRole('group', { name: section, exact: true });
  const text = group.getByText(note);
  await expect(text, `${section}: the note is not a paragraph on the form`).toBeHidden();
  await expect(group.getByLabel(`About ${section}`, { exact: true })).toHaveCount(1);
  await group.getByLabel(`About ${section}`, { exact: true }).click();
  await expect(text, `${section}: the section's ? opens the note`).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(text, `${section}: Escape closes it`).toBeHidden();
}

test('#1594 OR40 S3c-2 — a drawer field says what it is behind a ? beside its label', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const problems = collectPageProblems(page);
  const drawer = page.locator('.form-drawer-body');

  await page.goto('/#/manage/secrets');
  await fluentRootReady(page);
  await page.getByRole('button', { name: 'New secret' }).click();
  await expectInSectionHelp(page, drawer, 'Value', /once saved it can be replaced but never read/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  await page.goto('/#/manage/global-params');
  await fluentRootReady(page);
  await page.getByRole('button', { name: 'New global parameter' }).click();
  await expectInSectionHelp(page, drawer, 'Value', /is cleartext and so never a credential/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  await page.goto('/#/manage/datasets');
  await fluentRootReady(page);
  await page.getByRole('button', { name: 'New dataset' }).click();
  await expectBehindHelp(
    page,
    drawer,
    'Columns (JSON)',
    /^An authoring aid that auto-map matches against/,
  );
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  await page.goto('/#/manage/connections');
  await fluentRootReady(page);
  await openNewConnection(page, 'postgres');
  await expectBehindHelp(page, drawer, 'Secret', /cannot dispatch without a secret/);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // Last: choosing a Mode edits the form, which would hold a navigation away.
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await page.getByRole('button', { name: /New trigger/i }).click();
  await drawer.getByRole('combobox', { name: 'Mode', exact: true }).selectOption('event');
  await expectBehindHelp(page, drawer, 'Event', /^Fires when POST \/api\/events is called/);

  await expectQuiet(page, problems);
});
