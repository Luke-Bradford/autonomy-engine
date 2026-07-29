import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { nodeById, openSeededCanvas, type SeedDoc } from './support/seedDoc';

/**
 * #746 — deleting an ENCLOSED activity, end to end.
 *
 * The unit suites pin the prune and the validator's verdict. Neither can pin
 * what the operator actually reported, which is a UI state: the Save button
 * dead, a badge naming a node that is no longer on screen, and the container box
 * teleporting off to the side because every child it lists has become a phantom.
 * Those are cross-cutting — store, validator, `PipelineCanvas` badge, the U6c
 * derived-box layout — and jsdom cannot see the last of them at all, since a
 * container's rect is derived from MEASURED child sizes it reports as 0×0.
 *
 * So this spec walks the path: seed a doc with a container (the canvas cannot
 * author one until U6d, so the seed goes through the real write gate), delete a
 * child, and assert the doc is still savable — by SAVING it, which is the only
 * assertion that proves the save BODY no longer carries the phantom.
 *
 * The container's GEOMETRY is deliberately NOT asserted here, though #746
 * describes a box that teleports. It was written, and it PASSED with the prune
 * reverted — so it could not fail for this fix and was removed rather than
 * shipped. The reason it cannot discriminate is U6c's own honesty: the box is
 * derived from the children it can actually DRAW, so a listed-but-deleted child
 * and a pruned one produce the identical rect (and emptying a container reaches
 * the same fallback branch either way). `container-rendering.spec.ts` owns that
 * geometry. What #746 changes is the doc, and the doc is what is asserted.
 */

/** Two activities inside a stage, one outside it, and a `stage -> outside` edge. */
function stageDoc(): SeedDoc {
  return {
    nodes: [
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 0, y: 200 } },
      { id: 'after', type: 'file_write', position: { x: 460, y: 100 } },
    ],
    // From the CONTAINER, not from a child: an edge crossing the boundary is
    // exactly what the write gate refuses, so the seed would not mint.
    edges: [{ from: 'stage_1', to: 'after', on: 'success' }],
    containers: [{ id: 'stage_1', kind: 'stage', children: ['a', 'b'] }],
  };
}

/** Select an activity and delete it through the property panel. */
async function deleteActivity(page: Page, id: string): Promise<void> {
  await nodeById(page, id).click();
  await page.getByRole('button', { name: 'Delete node' }).click();
  await expect(nodeById(page, id)).toHaveCount(0);
}

/** The validation badge's messages, or `[]` when there is no badge. */
async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

test.describe('#746 container membership follows a delete', () => {
  /**
   * The headline, stated as the operator experiences it: delete an enclosed
   * activity and the doc still saves.
   *
   * Asserted by actually clicking Save and reading the confirmation, not by
   * asserting the button is enabled. `canSave` is a pure predicate the unit
   * suite already covers; what it CANNOT cover is that the body sent to the
   * server no longer lists the deleted child — and the server's own write gate
   * (the same `validatePipelineDoc`) is what proves it, by minting v2 instead of
   * returning a 400.
   */
  test('a deleted child leaves a doc that still saves', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-save', stageDoc());

    await deleteActivity(page, 'b');

    expect(await validationIssues(page), 'the delete left the doc invalid').toEqual([]);
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    await expectQuiet(page, problems);
  });

  /**
   * The DOCUMENTED RESIDUE, in the operator's own words.
   *
   * A container is deliberately NOT deleted with its last child — it owns edges
   * and config (`exitWhen`/`items`/`maxRounds`/`timeout`) that the canvas cannot
   * re-author until U6d/#425, so a cascade would destroy authored structure to
   * spare one refused save. An empty `loop` is still refused, and that is the
   * point of this test: the message the operator now reads names the REAL
   * problem instead of naming the node they just deleted.
   */
  test('emptying a loop is refused for the right reason, not for a phantom', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'membership-residue', {
      nodes: [{ id: 'only', position: { x: 0, y: 0 } }],
      containers: [
        {
          id: 'loop_1',
          kind: 'loop',
          children: ['only'],
          exitWhen: '${equals(nodes.only.status, "success")}',
          maxRounds: 3,
        },
      ],
    });

    await deleteActivity(page, 'only');

    const issues = await validationIssues(page);
    expect(issues.join('\n')).not.toContain('is not a node in this pipeline');
    expect(issues.join('\n')).toContain('makes no progress');
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    await expectQuiet(page, problems);
  });
});
