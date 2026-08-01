import { expect, test, type Page } from '@playwright/test';
import { addActivity, canvasNodes } from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { openSeededCanvas } from './support/seedDoc';

/**
 * #884 — the validation badge list names what it is asking the operator to fix.
 *
 * `readableIssue` has existed since #840, rewriting a validator message so node
 * ids become the activity's name and container ids become 'stage 1'. It had one
 * caller: the pre-edit confirm dialog. The STANDING badge list — the surface that
 * tells an operator their pipeline will not save, and the only one they can act
 * on — rendered `validateCanvas`'s strings verbatim.
 *
 * WHY THIS CAN ONLY BE AN E2E, and why the unit suite was blind to it for three
 * tickets: the ids only become unreadable when the CANVAS mints them. Every unit
 * fixture, and every seeded e2e doc, uses ids a human chose ('a', 'n_a', 'c_1'),
 * for which the verbatim string reads perfectly well. `newLocalId` mints
 * `n_7c44a16f-98f1-4958-…`, so the defect exists only on a doc built by the
 * gesture an operator actually performs. That is exactly the same blindness
 * `connectRules.endpointLabel`'s docblock records for U6b's refusal panel — found
 * in a browser, not in review — which is why this spec builds its doc by clicking
 * the toolbox rather than by seeding one.
 *
 * The negative assertion is the real guard. Asserting the readable text alone
 * would still pass if a SECOND, un-rewritten issue sat beside it in the list.
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** The validation badge's messages, or `[]` when there is no badge. */
async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

test.describe('#884 — a canvas-authored issue names its subject', () => {
  test('the badge list names the activity, and no minted id reaches it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e 884 legible issues', { nodes: [] });

    // Built by the GESTURE, so the ids are `newLocalId` uuids. Two of the same
    // type, because one is not enough: 'HTTP Request' alone would be satisfied by
    // the type name, and #878's whole point is that the ordinal is what tells two
    // otherwise identical boxes apart.
    await addActivity(page, 'HTTP Request');
    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(2);

    // A reference to a node that does not exist — `validateRefs`. This is the
    // commonest error a canvas author reaches, and it is written
    // `node.<id>.config.url: …` with the id UNQUOTED, which is the shape
    // `readableIssue`'s original quoted-token pass could not see at all.
    await canvasNodes(page).nth(1).click();
    await panel(page).getByRole('textbox', { name: 'url' }).fill('${nodes.ghost.output.body}');
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    const issues = await validationIssues(page);
    expect(issues.length, 'the bad reference is refused').toBeGreaterThan(0);

    const all = issues.join('\n');
    // The SECOND one — the ordinal, not just the type.
    expect(all).toContain("node 'HTTP Request 2' config.url:");
    // And the operator's own expression text is untouched, because it is the
    // string they must go and edit. A message telling them to fix
    // `${nodes.HTTP Request 2.output.body}` would name something that appears
    // nowhere in their config.
    expect(all).toContain('${nodes.ghost.output.body}');
    // The guard: NOTHING in this list is a minted id.
    expect(all).not.toContain('n_');

    // Save stays gated — this rewrites how the refusal READS, never whether the
    // doc is refused.
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // Rewriting the strings could collide two previously-distinct messages, and
    // the list is keyed by index for exactly that reason; a duplicate-key warning
    // would fail here.
    await expectQuiet(page, problems);
  });
});
