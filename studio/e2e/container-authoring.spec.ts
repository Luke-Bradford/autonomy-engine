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
    /* #840 — this SECOND edit is now stated too, and it did not used to be. The
       old comparison read the routing KIND, which is `partitioned` on both sides
       of it; what actually changes is that `b` stops running after the stage and
       starts running inside it. Under a `stage` that is subtle, under a `loop` it
       is the difference between once and once per round. So the dialog has to be
       READ here rather than left to Playwright's default dismissal, which is what
       silently declined the edit and turned this into a red spec. */
    const joined = await captureConfirm(page, async () => {
      await page.getByLabel('Container membership').selectOption({ label: 'stage 1' });
    });
    expect(joined, 'joining an existing container went unstated — #840 regressed?').toContain(
      'changes that inferred routing',
    );
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
    // Named by its ENDS, never by the uuid `newLocalId` minted for it — and
    // since #878 the two ends are TOLD APART. This doc is two `http_request`
    // nodes, which used to render "HTTP Request → HTTP Request": true, and no
    // more use to the operator than the two uuids it replaced.
    expect(message).toContain('HTTP Request 1 → HTTP Request 2');
    expect(message).not.toMatch(/'e_[0-9a-f]{8}/);

    expect((await validationIssues(page)).join('\n')).toContain('crosses a container boundary');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The way back out, through the control that got here.
    await page.getByLabel('Container membership').selectOption('');
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  /**
   * The same journey for a LOOP, which is where the stage version cannot
   * discriminate: an emptied stage validates clean, so "set it back to — none —"
   * looks like a recovery for it. For a loop that instruction makes the doc
   * WORSE (no children, and an `exitWhen` naming a node outside), so the create
   * path names the container's own delete instead — and this walks that.
   */
  test('the way out of a loop created round a wired activity is the box, not — none —', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-loop-undo', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
      edges: [{ from: 'a', to: 'b', on: 'success' }],
    });

    await select(page, 'b');
    await page.getByLabel('New container kind').selectOption('loop');
    await page.getByLabel('Exit when').fill('${equals(nodes.b.status, "success")}');
    const message = await captureConfirm(page, async () => {
      await page.getByRole('button', { name: 'Create container' }).click();
    });

    expect(message).toContain('✕ on the container box');
    expect(message, 'named a recovery that would make the doc worse').not.toContain('— none —');

    expect((await validationIssues(page)).join('\n')).toContain('crosses a container boundary');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The recovery the dialog actually named.
    await captureConfirm(page, async () => {
      await page.getByRole('button', { name: 'Delete loop 1 container' }).click();
    });
    await expect(page.locator('.flow-container')).toHaveCount(0);
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  /** A foreach needs its items expression for the same reason a loop needs an exit. */
  test('a foreach cannot be created without an items expression', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u6d-foreach-gate', {
      nodes: [{ id: 'a', position: { x: 0, y: 0 } }],
    });

    await select(page, 'a');
    await page.getByLabel('New container kind').selectOption('foreach');
    const create = page.getByRole('button', { name: 'Create container' });
    await expect(create).toBeDisabled();

    await page.getByLabel('Items').fill('${run.params.rows}');
    await expect(create).toBeEnabled();

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
    await expect(page.locator('.flow-container-label')).toHaveText('loop 1');

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

    // Scoped by TEXT: `.property-panel .error` alone also matches NodePanel's
    // config-parse error, so it would stay green if this one never rendered.
    await expect(page.locator('.property-panel .error')).toContainText('maxRounds');
    await expect(page.locator('.flow-container')).toHaveCount(0);

    await expectQuiet(page, problems);
  });
});

/**
 * #840 — a membership edit on a doc that ALREADY has a container states what it
 * changes, before it changes it.
 *
 * The gap this closes is a SILENCE, which is why it needs a spec at this level:
 * the old warning compared only the routing KIND, so both sides of this edit read
 * `partitioned` and no dialog was raised at all. Nothing else on the page said
 * anything either — `validateDoc` accepts both docs, the badge stays empty, Save
 * stays enabled, and the changed routing goes straight into the next IMMUTABLE
 * version. A spec that only asserted the dialog's wording could not have caught
 * that; what makes this one meaningful is that a dialog exists to read.
 */
test.describe('#840 — a container edit states the routing it changes', () => {
  test('moving an activity OUT of an existing container is stated first', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'routing-change-840', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
        { id: 'c', position: { x: 520, y: 0 } },
      ],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['b', 'c'] }],
    });

    // No authored edges and no validation issue on either side of this edit —
    // so the dialog is the ONLY thing that can tell the operator anything.
    expect(await validationIssues(page)).toEqual([]);

    await select(page, 'c');
    const message = await captureConfirm(page, async () => {
      await page.getByLabel('Container membership').selectOption('');
    });

    expect(
      message,
      'the membership move raised no warning at all — #840 regressed?',
    ).not.toBeNull();
    expect(message).toContain('changes that inferred routing');
    expect(message).toContain('Saving mints');
    // Qualitative by design. It was once a hard constraint — `activityLabel` is
    // keyed on TYPE, so naming the activities repeated one word — and since #878
    // it is a scope decision instead: `activityLabels` could name them, and
    // `RoutingChange` carries the ids. Deferred to #881; this pins the sentence
    // that ships today.
    expect(message).not.toContain('HTTP Request');

    await expect(page.getByLabel('Container membership')).toHaveValue('');
    expect(await validationIssues(page), 'the edit left the doc invalid').toEqual([]);

    await expectQuiet(page, problems);
  });

  /**
   * The negative half. Re-picking the container an activity is ALREADY in is a
   * no-op the store short-circuits, and a warning there would train the operator
   * to dismiss the dialog unread — which is how a pre-hoc warning stops working.
   */
  test('a membership pick that changes nothing does not interrupt', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'routing-change-840-noop', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['b'] }],
    });

    await select(page, 'b');
    const message = await captureConfirm(page, async () => {
      await page.getByLabel('Container membership').selectOption({ label: 'stage 1' });
    });
    expect(message).toBeNull();

    await expectQuiet(page, problems);
  });
});
