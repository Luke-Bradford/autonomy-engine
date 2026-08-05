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
 */

function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** The validation badge's messages, or `[]` when there is no badge. */
async function validationIssues(page: Page): Promise<string[]> {
  const list = page.locator('.badge-list li');
  return (await list.count()) === 0 ? [] : list.allTextContents();
}

/** The canvas-minted id of the nth activity on the canvas. */
async function mintedId(page: Page, index: number): Promise<string> {
  const id = await canvasNodes(page).nth(index).getAttribute('data-id');
  expect(id, 'the canvas minted an id').toBeTruthy();
  expect(id, 'the id is canvas-minted, not a seeded one').toMatch(/^n_[0-9a-f-]{20,}$/);
  return id!;
}

/**
 * The message with every `${…}` span blanked.
 *
 * THE CARVE-OUT, made explicit rather than dodged. `readableIssue` deliberately
 * leaves an expression body verbatim — it is the literal string the operator has
 * to go and edit, and a message telling them to fix
 * `${nodes.HTTP Request 2.output.body}` would name something that appears nowhere
 * in their config and is not even valid syntax. So a minted id CAN legitimately
 * appear inside a `${…}`, and "no `n_` anywhere in the list" is not a property of
 * the code.
 *
 * The first version of this spec asserted exactly that, and passed only because
 * its fixture referenced a node that did not exist. Both pre-PR review lenses
 * found it independently. Naming a real producer makes that assertion fail
 * against correct code — so the guard is scoped to where the claim actually
 * holds, and the second test below pins the carve-out so it cannot silently
 * widen.
 *
 * Since #887 the id inside the span is no longer left UNEXPLAINED — pass 5
 * appends the drawn name after the closing `}`. That gloss lands OUTSIDE the
 * span, so it survives this blanking and is asserted on directly below; this
 * helper's job is unchanged, because the id itself still legitimately sits
 * inside a `${…}` and must not be rewritten there.
 *
 * The `[^}]*` here is the very scanner pass 5 refuses to use — a `${…}` body may
 * carry a `}` inside a string literal, so this would blank such a span short. It
 * stays for two reasons. The failure modes are not comparable: pass 5 SPLICES,
 * where a wrong boundary corrupts the operator's expression, while this only
 * BLANKS before a `not.toContain('n_')` check, so a short blank leaves MORE text
 * under the guard and can only make it stricter — a false RED, never a false
 * green. And the alternative is importing `scanTemplateRefs`, which would be the
 * first `@autonomy-studio/shared` import in any e2e file; these specs drive the
 * app through its HTTP surface as an operator does (`support/seedDoc.ts`).
 *
 * The assumption is ENFORCED rather than asserted in prose. A braced literal
 * needs a quote inside the span, so a quote there trips the guard below and this
 * spec fails naming the reason, instead of silently mis-blanking. It is
 * deliberately over-strict — a harmless `${default(a, "b")}` trips it too —
 * because the remedy (reach for a real scanner) is the same either way, and a
 * loud stop beats a comment nobody re-reads.
 */
function outsideExpressions(message: string): string {
  expect(
    message,
    'a quote inside a ${…} means this naive blanking may close the span early — use a quote-aware scan',
  ).not.toMatch(/\$\{[^}]*["']/);
  return message.replace(/\$\{[^}]*\}/g, '${…}');
}

test.describe('#884 — a canvas-authored issue names its subject', () => {
  test('the badge list names the activity, and no minted id reaches its prose', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e 884 legible issues', { nodes: [] });

    // Built by the GESTURE, so the ids are `newLocalId` uuids. Two of the same
    // type, because one is not enough: 'HTTP Request' alone would be satisfied by
    // the type name, and #878's whole point is that the ordinal is what tells two
    // otherwise identical boxes apart.
    await addActivity(page, 'HTTP Request');
    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(2);

    // A reference to a node that does not exist — `scanNodeRefs`, which writes the
    // location as `nodes.<id>.config.url:` with the id UNQUOTED. That is the shape
    // `readableIssue`'s original quoted-token pass could not see at all, so this
    // message reached the badge list as a raw uuid until #884.
    await canvasNodes(page).nth(1).click();
    await panel(page).getByRole('textbox', { name: 'url' }).fill('${nodes.ghost.output.body}');
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    const issues = await validationIssues(page);
    expect(issues.length, 'the bad reference is refused').toBeGreaterThan(0);

    const all = issues.join('\n');
    // The SECOND one — the ordinal, not just the type.
    expect(all).toContain("node 'HTTP Request 2' config.url:");
    // The operator's own expression text, untouched.
    expect(all).toContain('${nodes.ghost.output.body}');
    // The guard: no minted id in the PROSE.
    expect(outsideExpressions(all)).not.toContain('n_');

    // Save stays gated — this rewrites how the refusal READS, never whether the
    // doc is refused.
    await expect(page.getByRole('button', { name: 'Save version' })).toBeDisabled();

    // Rewriting the strings could collide two previously-distinct messages, and
    // the list is keyed by index for exactly that reason; a duplicate-key warning
    // would fail here.
    await expectQuiet(page, problems);
  });

  /**
   * The carve-out, pinned — and #887, which CLOSED the cost this docblock used to
   * record as outstanding.
   *
   * A reference to a REAL but non-upstream node is the commonest form of this
   * error, and the id in it is usually MACHINE-INSERTED: U8a's expression picker
   * splices `${nodes.<minted id>.output.<name>}` into the field, so the operator
   * never typed the uuid and cannot recognise it. The sentence used to name one
   * end the way the canvas draws it and leave the other as a raw id — only half
   * readable.
   *
   * `readableIssue`'s pass 5 now GLOSSES the reference: the `${…}` span stays
   * byte-identical and the drawn name follows it in parentheses, so both ends are
   * named without editing the string the operator has to go and fix.
   *
   * All three properties are pinned together here, because each one is how the
   * other two could be broken while still looking fixed: the prose names the
   * activity; the expression survives verbatim (a "fix" that rewrote the body
   * would corrupt it into `${nodes.HTTP Request 2.output.body}`, which is in
   * nobody's config and is not valid syntax); and the gloss names the PRODUCER,
   * not merely some name.
   */
  test('a reference to a real node is glossed with its name, expression verbatim', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'e2e 884 real producer', { nodes: [] });

    await addActivity(page, 'HTTP Request');
    await addActivity(page, 'HTTP Request');
    await expect(canvasNodes(page)).toHaveCount(2);

    // The SECOND node's minted id, referenced from the FIRST — which is upstream
    // of nothing, so the reference is refused.
    const second = await mintedId(page, 1);
    await canvasNodes(page).nth(0).click();
    await panel(page).getByRole('textbox', { name: 'url' }).fill(`\${nodes.${second}.output.body}`);
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    const all = (await validationIssues(page)).join('\n');
    expect(all).toContain("node 'HTTP Request 1' config.url:");
    // Verbatim inside the expression — the string the operator must go and edit.
    expect(all).toContain(`\${nodes.${second}.output.body}`);
    // ...and nowhere else. This is what makes the guard behaviour-shaped rather
    // than fixture-shaped: the minted id IS in the message, and still absent from
    // its prose.
    expect(outsideExpressions(all)).not.toContain('n_');
    // #887 — the far end is named too, immediately after the span it explains.
    // Asserted as one contiguous string so it cannot pass on a gloss that landed
    // somewhere else in the sentence, and it names the SECOND HTTP Request
    // specifically: 'HTTP Request 1' is the node being edited, so a gloss that
    // echoed the wrong end would still contain 'HTTP Request'.
    expect(all).toContain(`\${nodes.${second}.output.body} (HTTP Request 2)`);

    await expectQuiet(page, problems);
  });
});
