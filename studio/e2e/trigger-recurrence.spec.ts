import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #439 U14b — authoring a schedule as a structured RECURRENCE.
 *
 * What only a real round trip can prove: that a recurrence authored through the
 * form is accepted by the write boundary (the shared `RecurrenceWriteSchema`
 * runs on both sides, so a client-only test would validate against the same
 * object it just built), that the server DERIVES the cron from it, and that
 * re-opening the trigger rebuilds the same form from what was persisted. The
 * unit tests assert the conversion; only this asserts the contract.
 *
 * It also pins the defect U14b closed: `formForEdit` used to load the DERIVED
 * cron into the raw-cron field, so every save of a recurrence-backed trigger
 * authored both a recurrence and a cron — which the server refuses with a 400.
 * That trigger is SEEDED THROUGH THE API below, not through the new form, so
 * the spec exercises a pre-existing row rather than only the path it just built.
 */

function triggerForm(page: Page) {
  return page.getByRole('form', { name: 'Trigger form' });
}

/** Open the Manage → Triggers hub with the console under watch. */
async function openTriggers(page: Page): Promise<string[]> {
  const problems = collectPageProblems(page);
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await expect(page.getByRole('heading', { name: 'Triggers' })).toBeVisible();
  return problems;
}

test.describe('U14b recurrence builder', () => {
  test('authors a weekly recurrence, and the server derives its cron', async ({ page }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel('Name').fill('Mon and Wed at 09:00 London');
    await form.getByLabel(/^Mode/).selectOption('schedule');

    // The builder — not a cron string — is what a new schedule trigger opens on.
    // EXACT label match, deliberately: these two selects are labelled by
    // `htmlFor`/`id`, so their accessible name is the label text ALONE. Wrapping
    // a select in its label instead folds every option's text into that name
    // (#857), and this assertion is what stops the new controls regressing to it.
    await expect(form.getByLabel('Schedule authored as', { exact: true })).toHaveValue(
      'recurrence',
    );
    await form.getByLabel('Frequency', { exact: true }).selectOption('week');
    await form.getByRole('checkbox', { name: 'Mon' }).check();
    await form.getByRole('checkbox', { name: 'Wed' }).check();
    await form.getByLabel(/^Hours/).fill('9');
    await form.getByLabel(/Time zone/).fill('Europe/London');

    // A zoned recurrence is NOT faithfully representable as a cron string, so
    // the preview must say so in prose rather than print a cron that implies UTC.
    const preview = form.getByTestId('recurrence-preview');
    await expect(preview).toContainText('Europe/London');
    await expect(preview).not.toContainText('cron');

    await form.getByRole('button', { name: /Create trigger/i }).click();
    await expect(triggerForm(page)).toBeHidden();

    // The row exists, and the SERVER derived the cron from the recurrence.
    const row = page.getByRole('row', { name: /Mon and Wed at 09:00 London/ });
    await expect(row).toBeVisible();
    const stored = await page.request.get('/api/triggers');
    const list = (await stored.json()) as Array<{
      name: string;
      schedule: string | null;
      recurrence: unknown;
    }>;
    const created = list.find((t) => t.name === 'Mon and Wed at 09:00 London');
    expect(created).toBeDefined();
    expect(created?.recurrence).toEqual({
      frequency: 'week',
      interval: 1,
      schedule: { hours: [9], weekDays: [1, 3] },
      timeZone: 'Europe/London',
    });
    // `recurrenceToCron` sorts and comma-joins: minute 0, hour 9, days 1 and 3.
    expect(created?.schedule).toBe('0 9 * * 1,3');

    // Re-opening rebuilds the SAME form from what was persisted.
    await row.getByRole('button', { name: /^Edit$/ }).click();
    const reopened = triggerForm(page);
    await expect(reopened.getByLabel('Frequency')).toHaveValue('week');
    await expect(reopened.getByRole('checkbox', { name: 'Mon' })).toBeChecked();
    await expect(reopened.getByRole('checkbox', { name: 'Wed' })).toBeChecked();
    await expect(reopened.getByRole('checkbox', { name: 'Tue' })).not.toBeChecked();
    await expect(reopened.getByLabel(/^Hours/)).toHaveValue('9');
    await expect(reopened.getByLabel(/Time zone/)).toHaveValue('Europe/London');
    // The derived cron is NOT loaded into the raw-cron field — that field is
    // not even on screen while the recurrence owns the schedule.
    await expect(reopened.getByLabel(/Schedule \(cron\)/)).toBeHidden();

    await expectQuiet(page, problems);
  });

  test('re-saves a pre-existing recurrence trigger that used to be un-editable', async ({
    page,
  }) => {
    // Seeded through the API, so this is a row the new form did not create —
    // exactly the case the old `formForEdit` could not save.
    const seeded = await page.request.post('/api/triggers', {
      data: {
        name: 'Seeded weekly',
        pipelineVersionId: null,
        params: {},
        mode: 'schedule',
        schedule: null,
        recurrence: { frequency: 'week', interval: 1, schedule: { weekDays: [1], hours: [9] } },
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: false,
      },
    });
    expect(seeded.status()).toBe(201);

    const problems = await openTriggers(page);
    const row = page.getByRole('row', { name: /Seeded weekly/ });
    await row.getByRole('button', { name: /^Edit$/ }).click();

    const form = triggerForm(page);
    await expect(form.getByLabel('Frequency')).toHaveValue('week');
    await form.getByLabel('Name').fill('Seeded weekly (renamed)');
    await form.getByRole('button', { name: /Save changes/i }).click();

    // The save SUCCEEDS: no 400, the form closes, the new name is on the row.
    await expect(form).toBeHidden();
    await expect(page.getByRole('row', { name: /Seeded weekly \(renamed\)/ })).toBeVisible();

    // And the recurrence survived the edit rather than being cleared by it.
    const after = await page.request.get('/api/triggers');
    const list = (await after.json()) as Array<{ name: string; recurrence: unknown }>;
    expect(list.find((t) => t.name === 'Seeded weekly (renamed)')?.recurrence).toEqual({
      frequency: 'week',
      interval: 1,
      schedule: { weekDays: [1], hours: [9] },
    });

    await expectQuiet(page, problems);
  });

  test('renaming a schedule trigger that has NO schedule does not grant it one', async ({
    page,
  }) => {
    // A schedule-mode trigger with neither a cron nor a recurrence is a legal
    // stored row. The recurrence builder has no "nothing selected" state — its
    // blank form is a valid DAILY recurrence — so opening such a row on the
    // builder would silently author `0 0 * * *` on the next save.
    const seeded = await page.request.post('/api/triggers', {
      data: {
        name: 'Inert schedule',
        pipelineVersionId: null,
        params: {},
        mode: 'schedule',
        schedule: null,
        recurrence: null,
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: false,
      },
    });
    expect(seeded.status()).toBe(201);

    const problems = await openTriggers(page);
    await page
      .getByRole('row', { name: /Inert schedule/ })
      .getByRole('button', { name: /^Edit$/ })
      .click();

    const form = triggerForm(page);
    await form.getByLabel('Name').fill('Inert schedule (renamed)');
    await form.getByRole('button', { name: /Save changes/i }).click();
    await expect(form).toBeHidden();

    const after = await page.request.get('/api/triggers');
    const list = (await after.json()) as Array<{
      name: string;
      schedule: string | null;
      recurrence: unknown;
    }>;
    const renamed = list.find((t) => t.name === 'Inert schedule (renamed)');
    expect(renamed).toBeDefined();
    expect(renamed?.schedule).toBeNull();
    expect(renamed?.recurrence).toBeNull();

    await expectQuiet(page, problems);
  });

  test('switching to the cron escape hatch clears the recurrence', async ({ page }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel('Name').fill('Switched to cron');
    await form.getByLabel(/^Mode/).selectOption('schedule');
    await form.getByLabel('Frequency').selectOption('week');
    await form.getByRole('checkbox', { name: 'Mon' }).check();

    // Now take the escape hatch. The recurrence must be sent as an explicit
    // null, or the server refuses a body authoring both.
    await form.getByLabel('Schedule authored as').selectOption('cron');
    await expect(form.getByRole('checkbox', { name: 'Mon' })).toBeHidden();
    await form.getByLabel(/Schedule \(cron\)/).fill('0 2 * * *');
    await form.getByRole('button', { name: /Create trigger/i }).click();
    await expect(triggerForm(page)).toBeHidden();

    const stored = await page.request.get('/api/triggers');
    const list = (await stored.json()) as Array<{
      name: string;
      schedule: string | null;
      recurrence: unknown;
    }>;
    const created = list.find((t) => t.name === 'Switched to cron');
    expect(created?.schedule).toBe('0 2 * * *');
    expect(created?.recurrence).toBeNull();

    await expectQuiet(page, problems);
  });

  test('an exponent interval is refused, not silently coerced', async ({ page }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel('Name').fill('Exponent interval');
    await form.getByLabel(/^Mode/).selectOption('schedule');

    // `<input type="number">` accepts any "valid floating-point number", which
    // INCLUDES exponent notation — so this reaches the conversion from the real
    // control, not just from a unit test. Assert the control actually holds it
    // before asserting what the conversion does with it; if a browser ever
    // sanitised it away, this test would otherwise pass for the wrong reason.
    const interval = form.getByLabel(/^Repeat every N/);
    await interval.fill('2e1');
    await expect(interval).toHaveValue('2e1');

    // `Number('2e1')` is 20, so coercing would have authored a 20-day recurrence
    // the operator never asked for.
    await expect(form.getByTestId('recurrence-problem')).toContainText('is not a whole number');
    await expect(form.getByTestId('recurrence-preview')).toBeHidden();

    await expectQuiet(page, problems);
  });
});
