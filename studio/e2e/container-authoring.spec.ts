import { expect, test, type Locator, type Page } from '@playwright/test';
import { validationIssues } from './support/canvasGraph';
import { captureConfirm, expectNoConfirm } from './support/confirmDialog';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas } from './support/seedDoc';

/**
 * #1597 — an activity's container, set from the canvas context menu.
 *
 * Until #1597 every activity's properties closed on a Container section: a
 * membership select plus a New container form (U6d). Since #1420 put ForEach,
 * Until and Stage on the palette and let activities be dragged into a box, that
 * section duplicated the canvas in the space the activity's own properties
 * need, and ADF has nothing like it. It is gone, and the keyboard route to what
 * a drag does (WCAG 2.5.7) is the activity's context menu: Move into ▸ and
 * Remove from.
 *
 * The unit suites pin the menu's items and the one-edit store write. What they
 * cannot pin is what the operator experiences: a menu raised from the KEYBOARD,
 * a dialog that states what the edit costs before it happens, a box on the
 * canvas that gains and loses the activity, and a save the server accepts.
 */

/** A container box on the canvas, by its label ("Stage 1", "ForEach 1"). */
function containerBox(page: Page, name: string): Locator {
  return page.getByRole('group', { name: new RegExp(`^${name} container`) });
}

/** How many activities a box says it holds, from its accessible name. */
async function expectHolds(page: Page, name: string, count: number): Promise<void> {
  const noun = count === 1 ? 'activity' : 'activities';
  await expect(containerBox(page, name)).toHaveAttribute(
    'aria-label',
    new RegExp(`^${name} container, ${count} ${noun}\\b`),
  );
}

/** The activity menu's Move into ▸ submenu, opened with the pointer. */
async function moveInto(page: Page, id: string, target: string): Promise<void> {
  await nodeById(page, id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Move into/ }).click();
  await page
    .getByRole('menu', { name: 'Move into' })
    .getByRole('menuitem', { name: target })
    .click();
}

/** The activity menu's Remove from, opened with the pointer. */
async function removeFrom(page: Page, id: string, name: string): Promise<void> {
  await nodeById(page, id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: `Remove from ${name}` }).click();
}

test.describe('#1597 — container membership from the canvas context menu', () => {
  /**
   * The acceptance path, KEYBOARD ONLY: focus the activity, raise its menu with
   * the ContextMenu key (Playwright's Chromium does not turn Shift+F10 into a
   * `contextmenu` event on a macOS host, so the key the platform maps it to is
   * pressed instead), open Move into ▸ with ArrowRight, pick with Enter; then
   * Undo, then Remove from.
   */
  test('keyboard only: Move into ▸ a ForEach, Undo, then Remove from', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-keyboard', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 0, y: 260 } },
      ],
      containers: [
        { id: 'foreach_1', kind: 'foreach', items: '${createArray(1, 2)}', children: ['b'] },
      ],
    });
    await expectHolds(page, 'ForEach 1', 1);

    const raiseMenu = async () => {
      await nodeById(page, 'a').focus();
      await page.keyboard.press('ContextMenu');
      const menu = page.getByRole('menu', { name: 'Selection' });
      await expect(menu).toBeVisible();
      // The keyboard lands IN the menu, so the arrows that follow drive it.
      await expect(menu.locator(':focus')).toHaveCount(1);
      return menu;
    };

    let menu = await raiseMenu();
    // Typeahead: Move into is the menu's one item starting with M.
    await page.keyboard.press('m');
    await expect(menu.getByRole('menuitem', { name: /^Move into/ })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    const into = page.getByRole('menu', { name: 'Move into' });
    await expect(into.getByRole('menuitem', { name: 'ForEach 1' })).toBeFocused();
    const joined = await captureConfirm(page, () => page.keyboard.press('Enter'));
    // A loop body runs once per item: joining one is a routing change, stated.
    expect(joined).toContain('Move HTTP Request 1 into ForEach 1?');
    await expectHolds(page, 'ForEach 1', 2);

    // Focus is back on the activity after the dialog, so the keyboard carries
    // on from there: one Undo takes it back out.
    await expect(nodeById(page, 'a')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+z');
    await expectHolds(page, 'ForEach 1', 1);

    // And Remove from takes out one that is in.
    await nodeById(page, 'b').focus();
    await page.keyboard.press('ContextMenu');
    menu = page.getByRole('menu', { name: 'Selection' });
    await expect(menu.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('r');
    await expect(menu.getByRole('menuitem', { name: 'Remove from ForEach 1' })).toBeFocused();
    await captureConfirm(page, () => page.keyboard.press('Enter'));
    await expectHolds(page, 'ForEach 1', 0);

    await expectQuiet(page, problems);
  });

  /**
   * The headline path, end to end: an activity joins a stage through the menu
   * and the pipeline saves. Asserted by actually SAVING — minting v2 is the only
   * thing that proves the body sent to the server carried the membership
   * through the real write gate.
   */
  test('an activity moved into a stage saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-save', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['a'] }],
    });

    /* #840 — the join is stated: the old comparison read the routing KIND,
       which is `partitioned` on both sides; what changes is that `b` stops
       running after the stage and starts running inside it. */
    const joined = await captureConfirm(page, () => moveInto(page, 'b', 'Stage 1'));
    expect(joined, 'joining an existing container went unstated — #840 regressed?').toContain(
      'changes that inferred routing',
    );
    await expectHolds(page, 'Stage 1', 2);

    expect(await validationIssues(page), 'the edit left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await expectQuiet(page, problems);
  });

  /**
   * The case that decided U6d's POSTURE, and it carries over. `a → b` is the
   * commonest doc there is, and putting `b` in a container makes that edge
   * cross a boundary — a doc `validateDoc` refuses. Refusing the move would make
   * containerising anything already wired impossible, so it is applied and its
   * cost stated instead: the badge names the problem, Save is dead, and Remove
   * from puts it back.
   */
  test('moving an already-wired activity is allowed, stated, and reversible', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-wired', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
        { id: 'c', position: { x: 0, y: 260 } },
      ],
      edges: [{ from: 'a', to: 'b', on: 'success' }],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['c'] }],
    });

    const message = await captureConfirm(page, () => moveInto(page, 'b', 'Stage 1'));
    expect(message).toContain('unsavable');
    expect(message).toContain('crosses a container boundary');
    // Named by its ENDS (#878), never by a minted id.
    expect(message).toContain('HTTP Request 1 → HTTP Request 2');
    expect(message).toContain('Undo (⌘Z) takes it back out.');

    expect((await validationIssues(page)).join('\n')).toContain('crosses a container boundary');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // The way back out, from the same menu. It makes the doc valid again and
    // changes no routing an explicit edge does not already fix, so it is not asked.
    await removeFrom(page, 'b', 'Stage 1');
    await expectNoConfirm(page);
    await expectHolds(page, 'Stage 1', 1);
    expect(await validationIssues(page)).toEqual([]);
    await expect(page.getByRole('button', { name: 'Save version' })).toBeEnabled();

    await expectQuiet(page, problems);
  });

  /** Dismissing the confirmation must leave the graph exactly as it was. */
  test('declining the confirmation applies nothing', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-decline', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['a'] }],
    });

    await captureConfirm(page, () => moveInto(page, 'b', 'Stage 1'), 'cancel');
    await expectHolds(page, 'Stage 1', 1);
    await expectQuiet(page, problems);
  });
});

/**
 * #840 — a membership edit on a doc that ALREADY has a container states what it
 * changes, before it changes it. The gap this closes is a SILENCE: `validateDoc`
 * accepts both docs, the badge stays empty, Save stays enabled, and the changed
 * routing would go straight into the next IMMUTABLE version.
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

    const message = await captureConfirm(page, () => removeFrom(page, 'c', 'Stage 1'));
    expect(
      message,
      'the membership move raised no warning at all — #840 regressed?',
    ).not.toBeNull();
    expect(message).toContain('out of Stage 1?');
    expect(message).toContain('changes that inferred routing');
    expect(message).toContain('Saving mints');

    await expectHolds(page, 'Stage 1', 1);
    expect(await validationIssues(page), 'the edit left the doc invalid').toEqual([]);

    await expectQuiet(page, problems);
  });

  /**
   * The negative half. The box an activity is ALREADY in is never offered, so
   * there is no no-op pick to warn about — a warning there would train the
   * operator to dismiss the dialog unread. With no other box, Move into is
   * greyed and says why.
   */
  test('the container an activity is already in is not offered', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'routing-change-840-noop', {
      nodes: [
        { id: 'a', position: { x: 0, y: 0 } },
        { id: 'b', position: { x: 260, y: 0 } },
      ],
      containers: [{ id: 'stage_1', kind: 'stage', children: ['b'] }],
    });

    await nodeById(page, 'b').click({ button: 'right' });
    const move = page.getByRole('menuitem', { name: /^Move into/ });
    await expect(move).toHaveAttribute('aria-disabled', 'true');
    await expect(move).toContainText('No other container on this canvas');
    await page.keyboard.press('Escape');
    await expectNoConfirm(page);
    await expectHolds(page, 'Stage 1', 1);

    await expectQuiet(page, problems);
  });
});
