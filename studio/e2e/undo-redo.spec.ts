import { expect, test } from '@playwright/test';
import { openCanvas } from './support/canvas';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { addActivity, canvasNodes, viewportSettled } from './support/canvasGraph';

/**
 * U17 — undo/redo on the authoring canvas.
 *
 * The store's own behaviour is unit-tested (`canvasStore.test.ts`); what only a
 * real browser can prove is that the two controls are WIRED — that pressing them
 * changes what is drawn, that the keyboard shortcut reaches the same actions
 * from wherever focus happens to be, and that ⌘Z inside a text field is still
 * the browser's own text undo rather than a graph edit the operator never asked
 * for.
 *
 * Every assertion below was mutation-checked (recorded in the PR): each fails
 * when the behaviour it names is removed.
 */
test.describe('undo/redo (U17)', () => {
  test('an added activity can be undone and redone from the buttons', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e undo add');

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });

    // Nothing edited yet: both controls are dead, and each SAYS why.
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await expect(undo).toHaveAttribute('title', 'Nothing to undo.');

    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(1);
    await expect(undo).toBeEnabled();

    await undo.click();
    await expect(canvasNodes(page)).toHaveCount(0);
    // The undo is now the thing that can be redone, and undo has nothing left.
    await expect(redo).toBeEnabled();
    await expect(undo).toBeDisabled();

    await redo.click();
    await expect(canvasNodes(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });

  test('a deleted activity comes back — the destructive edit is reversible', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e undo delete');

    await addActivity(page, 'HTTP Request');
    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(2);
    await viewportSettled(page);

    // Select a node and delete it with the keyboard — the destructive path an
    // operator actually reaches for.
    await canvasNodes(page).first().click();
    await page.keyboard.press('Backspace');
    await expect(canvasNodes(page)).toHaveCount(1);

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(canvasNodes(page)).toHaveCount(2);

    await expectQuiet(page, problems);
  });

  test('the keyboard shortcut drives the same two actions', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e undo keys');

    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(1);

    // Both platform chords, since the app runs under either.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(canvasNodes(page)).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(canvasNodes(page)).toHaveCount(1);

    await expectQuiet(page, problems);
  });

  test('⌘Z inside a text field is the FIELD’s undo, not the canvas’s', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openCanvas(page, 'e2e undo text');

    // The pipeline property panel's param editor. It is the nothing-selected
    // slot, so a canvas with no selection already shows it (`params-authoring`).
    await page.getByRole('button', { name: 'Add param' }).click();
    const name = page.getByRole('textbox', { name: 'Name' }).last();
    await name.fill('customer');

    // The canvas edit goes LAST, so it is the top of the undo stack. This is
    // what makes the spec discriminate: two earlier versions did not. Asserting
    // the node count with the param edit on top passed even with the text-field
    // exemption deleted (a leaked undo reverts the param, not the node), and
    // asserting the FIELD passed too — the browser's own undo reverts a
    // programmatic fill to exactly the value the store's undo would.
    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(1);

    await name.press('ControlOrMeta+z');

    // A leaked shortcut would have undone the ADD, whatever the browser did to
    // the text. The graph is not the operator's to lose while their caret sits
    // in a name field.
    await expect(canvasNodes(page)).toHaveCount(1);
    // And the control is still live — the keystroke was declined, not consumed.
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();

    await expectQuiet(page, problems);
  });
});
