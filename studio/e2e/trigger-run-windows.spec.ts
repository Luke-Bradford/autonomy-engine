import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #1090 U14c — authoring a RUN WINDOW through controls instead of raw JSON.
 *
 * What only a real round trip can prove: that a window authored through the new
 * editor is accepted by the write boundary and stored in the shape the
 * scheduler reads (the shared `RunWindowWriteSchema` runs on both sides, so a
 * client-only test validates against the same object it just built), that
 * re-opening the trigger rebuilds the same form from what was persisted, and —
 * the one the unit tests structurally cannot reach — that the SERVER refuses a
 * window it could never open, not merely the form.
 *
 * Why the refusals matter more than they look: `isWithinRunWindows` is
 * fail-CLOSED. Before this ticket a bound like `"9am"` was accepted by the
 * write boundary, persisted, and then silently stopped the trigger ever firing
 * — no error at write time, at fire time, or anywhere on screen.
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

/** The trigger write body, with `runWindows` left to the caller. */
function triggerBody(name: string, runWindows: unknown) {
  return {
    name,
    pipelineVersionId: null,
    params: {},
    mode: 'schedule' as const,
    schedule: '0 * * * *',
    recurrence: null,
    webhook: null,
    concurrency: { policy: 'skip_if_running' as const },
    runWindows,
    enabled: false,
  };
}

test.describe('U14c run-window editor', () => {
  test('authors a day-restricted window, and it round-trips through the server', async ({
    page,
  }) => {
    const problems = await openTriggers(page);

    await page.getByRole('button', { name: /New trigger/i }).click();
    const form = triggerForm(page);
    await form.getByLabel('Name').fill('Weekday office hours');
    // A new schedule trigger opens on the RECURRENCE builder, whose blank form
    // is already a valid daily schedule — nothing else needs authoring here.
    await form.getByLabel(/^Mode/).selectOption('schedule');

    // Unrestricted until asked — the rows only appear once there is a window.
    await expect(form.getByRole('group', { name: 'Window 1' })).toBeHidden();
    await form.getByRole('button', { name: 'Add window' }).click();

    const window1 = form.getByRole('group', { name: 'Window 1' });
    await window1.getByLabel(/Window 1 start/).fill('09:00');
    await window1.getByLabel(/Window 1 end/).fill('17:00');
    await window1.getByRole('checkbox', { name: /Only on selected days/ }).check();
    await window1.getByRole('checkbox', { name: 'Mon' }).check();
    await window1.getByRole('checkbox', { name: 'Fri' }).check();

    await form.getByRole('button', { name: /Create trigger/i }).click();
    await expect(triggerForm(page)).toBeHidden();

    // The SERVER holds the shape `isWithinRunWindows` reads — the point of the
    // whole ticket is that this is now structurally impossible to get wrong.
    const stored = await page.request.get('/api/triggers');
    const list = (await stored.json()) as Array<{ name: string; runWindows: unknown }>;
    expect(list.find((t) => t.name === 'Weekday office hours')?.runWindows).toEqual([
      { start: '09:00', end: '17:00', days: [1, 5] },
    ]);

    // Re-opening rebuilds the SAME form from what was persisted.
    const row = page.getByRole('row', { name: /Weekday office hours/ });
    await row.getByRole('button', { name: /^Edit$/ }).click();
    const reopened = triggerForm(page).getByRole('group', { name: 'Window 1' });
    await expect(reopened.getByLabel(/Window 1 start/)).toHaveValue('09:00');
    await expect(reopened.getByLabel(/Window 1 end/)).toHaveValue('17:00');
    await expect(reopened.getByRole('checkbox', { name: 'Mon' })).toBeChecked();
    await expect(reopened.getByRole('checkbox', { name: 'Fri' })).toBeChecked();
    await expect(reopened.getByRole('checkbox', { name: 'Tue' })).not.toBeChecked();

    await expectQuiet(page, problems);
  });

  test('the SERVER refuses a window it could never open, not just the form', async ({ page }) => {
    // The client and the server share one schema, so a form-only assertion
    // proves nothing about the boundary. Posted directly, past the UI.
    for (const badWindow of [
      [{ start: '9am', end: '5pm' }], // unreadable bound
      [{ start: '09:00', end: '09:00' }], // zero-width: no instant is inside it
      [{ start: '09:00', end: '17:00', days: [] }], // no weekday satisfies it
    ]) {
      const res = await page.request.post('/api/triggers', {
        data: triggerBody(`Refused ${JSON.stringify(badWindow)}`, badWindow),
        failOnStatusCode: false,
      });
      expect(res.status(), `expected a refusal for ${JSON.stringify(badWindow)}`).toBe(400);
    }

    // ...and the well-formed neighbours of each are still accepted, so the gate
    // refuses the never-opening window rather than run windows generally.
    const ok = await page.request.post('/api/triggers', {
      data: triggerBody('Accepted overnight window', [
        { start: '22:00', end: '02:00', days: [0, 6] },
      ]),
    });
    expect(ok.status()).toBe(201);
  });

  test('a trigger configured with NO windows stays never-open across an unrelated edit', async ({
    page,
  }) => {
    // `[]` means "windows configured, none of them" — permanently CLOSED, and a
    // legitimate thing to mean. An editor that rendered it as "no rows" and
    // wrote back `null` would silently convert never-fires into always-open on
    // a rename. This is that guard, end to end.
    const seeded = await page.request.post('/api/triggers', {
      data: triggerBody('Held closed', []),
    });
    expect(seeded.status()).toBe(201);

    const problems = await openTriggers(page);
    await page
      .getByRole('row', { name: /Held closed/ })
      .getByRole('button', { name: /^Edit$/ })
      .click();
    const form = triggerForm(page);

    await expect(
      form.getByRole('checkbox', { name: /Restrict when this trigger may fire/ }),
    ).toBeChecked();
    await expect(form.getByText(/can never fire automatically/)).toBeVisible();

    await form.getByLabel('Name').fill('Held closed (renamed)');
    await form.getByRole('button', { name: /Save changes/i }).click();
    await expect(triggerForm(page)).toBeHidden();

    const stored = await page.request.get('/api/triggers');
    const list = (await stored.json()) as Array<{ name: string; runWindows: unknown }>;
    expect(list.find((t) => t.name === 'Held closed (renamed)')?.runWindows).toEqual([]);

    await expectQuiet(page, problems);
  });
});
