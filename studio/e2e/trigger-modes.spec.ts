import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #854 — the trigger modes that were selectable but not configurable.
 *
 * `TriggerModeSchema` has six modes and the form's Mode select iterates the
 * whole enum, so all six could be CHOSEN — but only `manual`, `schedule` and
 * `webhook` could be configured. Choosing `event` or `tumbling` and enabling the
 * trigger produced a 400 from `assertEventConsistent` / `assertWindowConsistent`
 * with no control anywhere on the page that could satisfy them.
 *
 * What only a real round trip can prove: that the config this form builds is
 * ACCEPTED by the write boundary (the shared write schemas run on both sides, so
 * a client-only test validates against the object it just built), and that a
 * trigger already configured in one of these modes can be switched OUT of it —
 * the second half of the defect. On a PATCH an omitted key means "untouched", so
 * before this the stale `event`/`window` came back with every save and the
 * trigger was stuck in a mode the UI could not leave.
 */

function triggerForm(page: Page) {
  return page.getByRole('form', { name: 'Trigger form' });
}

async function openTriggers(page: Page): Promise<string[]> {
  const problems = collectPageProblems(page);
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await expect(page.getByRole('heading', { name: 'Triggers' })).toBeVisible();
  return problems;
}

/** Read a trigger back from the API by name — what was actually PERSISTED. */
async function storedTrigger(page: Page, name: string) {
  const res = await page.request.get('/api/triggers');
  expect(res.status()).toBe(200);
  const list = (await res.json()) as Array<Record<string, unknown> & { name: string }>;
  const found = list.find((t) => t.name === name);
  expect(found, `no trigger named ${name}`).toBeDefined();
  return found!;
}

test.describe('#854 event mode', () => {
  test('authors an event subscription the write boundary accepts', async ({ page }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel('Name').fill('On order placed');
    await form.getByLabel(/^Mode/).selectOption('event');
    await form.getByLabel('Event name').fill('order.placed');
    await form.getByRole('button', { name: /Create trigger/i }).click();
    await expect(form).toBeHidden();

    const created = await storedTrigger(page, 'On order placed');
    expect(created.mode).toBe('event');
    expect(created.event).toEqual({ name: 'order.placed' });

    // Re-opening rebuilds the same form from what was persisted.
    await page
      .getByRole('row', { name: /On order placed/ })
      .getByRole('button', { name: /^Edit$/ })
      .click();
    await expect(triggerForm(page).getByLabel('Event name')).toHaveValue('order.placed');

    await expectQuiet(page, problems);
  });

  test('lets a configured event trigger leave the mode', async ({ page }) => {
    // Seeded through the API, so this is a row the new form did not create.
    const seeded = await page.request.post('/api/triggers', {
      data: {
        name: 'Seeded subscription',
        pipelineVersionId: null,
        params: {},
        mode: 'event',
        schedule: null,
        event: { name: 'order.placed' },
        webhook: null,
        concurrency: { policy: 'skip_if_running' },
        runWindows: null,
        enabled: false,
      },
    });
    expect(seeded.status()).toBe(201);

    const problems = await openTriggers(page);
    const row = page.getByRole('row', { name: /Seeded subscription/ });
    await row.getByRole('button', { name: /^Edit$/ }).click();
    const form = triggerForm(page);
    await expect(form.getByLabel('Event name')).toHaveValue('order.placed');

    await form.getByLabel(/^Mode/).selectOption('manual');
    await form.getByRole('button', { name: /Save changes/i }).click();

    // The save SUCCEEDS — no 400 — and the stale subscription is gone.
    await expect(form).toBeHidden();
    const saved = await storedTrigger(page, 'Seeded subscription');
    expect(saved.mode).toBe('manual');
    expect(saved.event).toBeNull();

    await expectQuiet(page, problems);
  });
});

test.describe('#854 tumbling mode', () => {
  test('authors a window, on the only concurrency policy the server allows', async ({ page }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel('Name').fill('Two-hourly windows');
    await form.getByLabel(/^Mode/).selectOption('tumbling');

    // EXACT label match, deliberately: this select is labelled by `htmlFor`/`id`,
    // so its accessible name is the label text ALONE. Wrapping a select in its
    // label folds every option's text into that name (#857) — this assertion is
    // what stops the new control regressing to it.
    //
    // THIS spec is the only guard for that. Playwright's text extraction
    // recurses into <option>, so a re-wrapped select fails here; the vitest
    // counterpart does NOT catch it, because RTL strips nested labelled controls
    // when computing a label's text. Do not read the unit assertion as cover.
    await form.getByLabel('Window frequency', { exact: true }).selectOption('hour');
    await form.getByLabel(/Each window covers/).fill('2');
    await form.getByLabel(/^Start time/).fill('2026-08-01T09:00');

    // `assertWindowConsistent` refuses a tumbling trigger on any other policy,
    // so the form settles it rather than letting the save be rejected.
    const concurrency = form.getByLabel('Concurrency');
    await expect(concurrency).toHaveValue('queue');
    await expect(concurrency).toBeDisabled();

    // The advisory says what the window WILL be, computed — not a vibe.
    await expect(form.getByTestId('window-preview')).toContainText('7200s');

    await form.getByRole('button', { name: /Create trigger/i }).click();
    await expect(form).toBeHidden();

    const created = await storedTrigger(page, 'Two-hourly windows');
    expect(created.mode).toBe('tumbling');
    expect(created.concurrency).toEqual({ policy: 'queue' });
    // The epoch is anchored in the BROWSER's zone, so assert the shape and the
    // geometry here and prove the instant survives via the round trip below.
    expect(created.window).toMatchObject({ frequency: 'hour', interval: 2 });
    expect(typeof (created.window as { startTime: unknown }).startTime).toBe('string');

    await page
      .getByRole('row', { name: /Two-hourly windows/ })
      .getByRole('button', { name: /^Edit$/ })
      .click();
    const reopened = triggerForm(page);
    await expect(reopened.getByLabel('Window frequency')).toHaveValue('hour');
    await expect(reopened.getByLabel(/Each window covers/)).toHaveValue('2');
    await expect(reopened.getByLabel(/^Start time/)).toHaveValue('2026-08-01T09:00');

    await expectQuiet(page, problems);
  });

  test('lets a configured tumbling trigger leave the mode', async ({ page }) => {
    // Seeded with params that carry NO `${trigger.windowStart}` binding: those
    // are refused off tumbling by `assertWindowBindingsConsistent`, which is a
    // separate rule this ticket does not clear (see the PR body).
    const seeded = await page.request.post('/api/triggers', {
      data: {
        name: 'Seeded windows',
        pipelineVersionId: null,
        params: {},
        mode: 'tumbling',
        schedule: null,
        window: { frequency: 'hour', interval: 1, startTime: '2026-08-01T08:00:00.000Z' },
        webhook: null,
        concurrency: { policy: 'queue' },
        runWindows: null,
        enabled: false,
      },
    });
    expect(seeded.status()).toBe(201);

    const problems = await openTriggers(page);
    const row = page.getByRole('row', { name: /Seeded windows/ });
    await row.getByRole('button', { name: /^Edit$/ }).click();
    const form = triggerForm(page);
    await expect(form.getByLabel('Window frequency')).toHaveValue('hour');

    await form.getByLabel(/^Mode/).selectOption('schedule');
    await form.getByRole('button', { name: /Save changes/i }).click();

    // The save SUCCEEDS — no 400 — and the stale window is gone.
    await expect(form).toBeHidden();
    const saved = await storedTrigger(page, 'Seeded windows');
    expect(saved.mode).toBe('schedule');
    expect(saved.window).toBeNull();

    await expectQuiet(page, problems);
  });
});

test.describe('#854 continuous mode', () => {
  test('says plainly that nothing dispatches a continuous trigger', async ({ page }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel(/^Mode/).selectOption('continuous');
    await expect(form.getByText(/not dispatched yet/i)).toBeVisible();

    await expectQuiet(page, problems);
  });
});
