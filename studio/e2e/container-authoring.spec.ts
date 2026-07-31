import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * U6d — authoring a container from the canvas.
 *
 * Until this ticket a container could only arrive with a version minted through
 * the API, which is why every other container spec has to seed one. This is the
 * first spec that MAKES one the way an operator does: select an activity, pick a
 * kind, click Create.
 *
 * The unit suites pin the store actions and the consequence rules. What they
 * cannot pin is the thing the operator actually experiences — a dialog that
 * states what an edit costs before it happens, a box that appears on the canvas,
 * and a save that reaches the server carrying the container. jsdom cannot see
 * the box at all (a container's rect is derived from MEASURED child sizes it
 * reports as 0×0), and no unit test can prove the save BODY.
 */

/** Select an activity so the property panel shows its container controls. */
async function select(page: Page, id: string): Promise<void> {
  await nodeById(page, id).click();
  await expect(page.getByLabel('Container membership')).toBeVisible();
}

/** The validation badge's messages, or `[]` when there is no badge. */
async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

/**
 * Run `act`, capturing the text of the one confirm it is expected to raise.
 *
 * Returns `null` when nothing was raised, which is an assertable outcome in its
 * own right: an edit that costs nothing must NOT interrupt the operator.
 */
async function captureConfirm(
  page: Page,
  act: () => Promise<void>,
  response: 'accept' | 'dismiss' = 'accept',
): Promise<string | null> {
  let seen: string | null = null;
  const handler = async (dialog: {
    message: () => string;
    accept: () => Promise<void>;
    dismiss: () => Promise<void>;
  }) => {
    seen = dialog.message();
    await (response === 'accept' ? dialog.accept() : dialog.dismiss());
  };
  page.on('dialog', handler);
  try {
    await act();
  } finally {
    page.off('dialog', handler);
  }
  return seen;
}

test.describe('U6d — creating a container from the canvas', () => {
  /**
   * The headline path, end to end: no container exists, the operator makes one,
   * puts a second activity in it, and saves.
   *
   * Asserted by actually SAVING and reading the confirmation rather than by
   * asserting a button is enabled — minting v2 is the only thing that proves the
   * body sent to the server carried the container through the real write gate.
   */
  test('an operator creates a stage, adds a second activity, and saves it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-create', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
    });
    await expect(page.locator('.flow-container')).toHaveCount(0);

    await select(page, 'a');
    const message = await captureConfirm(page, async () => {
      await page.getByRole('button', { name: 'Create container' }).click();
    });

    // The consequence NO validator reports: an edge-less doc's routing is
    // INFERRED, and a container splits that inferred chain into parallel roots.
    expect(message, 'the routing flip was not stated before it happened').toContain(
      'parallel roots',
    );
    await expect(page.locator('.flow-container')).toHaveCount(1);

    await select(page, 'b');
    await page.getByLabel('Container membership').selectOption({ label: 'stage 1' });
    await expect(page.getByLabel('Container membership')).toHaveValue(/^stage_/);

    expect(await validationIssues(page), 'the edit left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await expectQuiet(page, problems);
  });

  /**
   * The case that decided this ticket's POSTURE.
   *
   * `a → b` is the commonest doc there is, and putting a container round `b`
   * makes that edge cross a boundary — a doc `validateDoc` refuses. REFUSING the
   * membership edit for that reason would make containerising anything already
   * wired impossible, so the edit is applied and its cost is stated instead.
   *
   * What makes that safe rather than a #748-shaped trap is walked here in full:
   * the operator is told, the badge names the problem, Save is dead — and the
   * SAME control puts it back.
   */
  test('containerising an already-wired activity is allowed, stated, and reversible', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-wired', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
      edges: [{ from: 'a', to: 'b', on: 'success' }],
    });

    await select(page, 'b');
    const message = await captureConfirm(page, async () => {
      await page.getByRole('button', { name: 'Create container' }).click();
    });

    expect(message).toContain('unsavable');
    expect(message).toContain('crosses a container boundary');
    // Named by its ENDS, never by the uuid `newLocalId` minted for it.
    expect(message).toContain('HTTP Request → HTTP Request');
    expect(message).not.toMatch(/'e_[0-9a-f]{8}/);

    expect((await validationIssues(page)).join('\n')).toContain('crosses a container boundary');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The way back out, through the control that got here.
    await page.getByLabel('Container membership').selectOption('');
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  /** Dismissing the confirmation must leave the graph exactly as it was. */
  test('declining the confirmation applies nothing', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-decline', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
    });

    await select(page, 'a');
    await captureConfirm(
      page,
      async () => {
        await page.getByRole('button', { name: 'Create container' }).click();
      },
      'dismiss',
    );

    await expect(page.locator('.flow-container')).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  /**
   * A loop with no exit condition is a doc `validateDoc` refuses outright, so the
   * form cannot offer to author one — the gate is the disabled button, before the
   * doc exists, rather than a badge after it.
   */
  test('a loop cannot be created without an exit condition', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-loop-gate', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await select(page, 'a');
    await page.getByLabel('New container kind').selectOption('loop');
    const create = page.getByRole('button', { name: 'Create container' });
    await expect(create).toBeDisabled();

    await page.getByLabel('Exit when').fill('${equals(nodes.a.status, "success")}');
    await expect(create).toBeEnabled();

    await captureConfirm(page, async () => {
      await create.click();
    });
    await expect(page.locator('.flow-container')).toHaveCount(1);
    await expect(page.locator('.flow-container-label')).toHaveText('loop');

    await expectQuiet(page, problems);
  });

  /**
   * The gap the canvas's own validation cannot see. `validatePipelineDoc` runs no
   * schema parse and the server parses the body FIRST, so a `maxRounds` of 0
   * would clear every canvas check, enable Save, and come back as a raw zod 400
   * with no badge naming the cause. `buildContainer` refuses it here instead.
   */
  test('a maxRounds the schema rejects is refused in the form, not by a 400', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-maxrounds', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await select(page, 'a');
    await page.getByLabel('New container kind').selectOption('loop');
    await page.getByLabel('Exit when').fill('${equals(nodes.a.status, "success")}');
    await page.getByLabel('Max rounds (optional)').fill('0');
    await page.getByRole('button', { name: 'Create container' }).click();

    await expect(page.locator('.property-panel .error')).toBeVisible();
    await expect(page.locator('.flow-container')).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});
