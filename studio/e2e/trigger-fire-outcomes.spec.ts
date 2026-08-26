import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { seedManualTrigger, seedVersion } from './support/seedDoc';

/**
 * #1247 — "Fire now" was guarded by a PAGE-WIDE flag.
 *
 * `TriggersPage` held one `firingId` slot and refused every click while any fire
 * was in flight (`if (firingId) return;`), but disabled only the row that had
 * been clicked. So firing a second trigger while the first was still running was
 * a silent no-op on an ENABLED button — it read as a dead control.
 *
 * WHY THIS NEEDS A BROWSER, given the unit suite already covers the guard. The
 * unit tests can hold a mocked `fireTrigger` pending and prove the per-row
 * single-flight exactly. What they cannot prove is that two REAL fires, through
 * the real launcher, each come back with their own run id and that both survive
 * on screen — the page used to report through one `actionMsg` and one
 * `watchRunId`, and the thing the old shape discarded was a run link the
 * operator had already been offered. That is an end-to-end property.
 *
 * The bound pipeline is a `wait` of `${0}`: egress-free (an engine-resolved
 * alarm, not a call) and it settles immediately, which is the cheapest way to
 * get a real `started` outcome on a test machine — see `fireAndSettle`'s
 * docblock for the three qualifying activity classes.
 */
test.describe('#1247 firing several triggers', () => {
  test('fires two triggers from the list and keeps BOTH outcomes and run links', async ({
    page,
  }) => {
    const { pipelineVersionId } = await seedVersion(page, 'Fire outcomes', {
      nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${0}' }, position: { x: 0, y: 0 } }],
      edges: [],
    });
    await seedManualTrigger(page, pipelineVersionId, 'Alpha trigger');
    await seedManualTrigger(page, pipelineVersionId, 'Beta trigger');

    const problems = collectPageProblems(page);
    await page.goto('/#/manage/triggers');
    await fluentRootReady(page);
    await expect(page.getByRole('heading', { name: 'Triggers' })).toBeVisible();

    /* The FIRST fire is held in flight, and that is what makes this spec able to
       fail. Without it the two fires are sequential — the first has already
       released its slot before the second is clicked, so even the page-wide
       guard this ticket removes would let both through, and the spec would pass
       against the very defect it is named for. Verified: with the fires
       sequential, mutating the guard back to a page-wide slot still passed. */
    let held = false;
    await page.route('**/api/triggers/*/fire', async (route) => {
      if (!held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      await route.continue();
    });

    /* The accessible name is `Fire now: <name>` — lead first, so the visible
       "Fire now" is a literal substring of it (WCAG 2.5.3). It used to infix the
       row name (`Fire <name> now`), which split the visible label in half and
       failed that check; locating by the current shape pins it here too. */
    const alphaBtn = page.getByRole('button', { name: 'Fire now: Alpha trigger' });
    const betaBtn = page.getByRole('button', { name: 'Fire now: Beta trigger' });
    await alphaBtn.click();

    // The single-flight is per ROW: Alpha is busy, Beta is untouched by it.
    await expect(alphaBtn).toBeDisabled();
    await expect(betaBtn).toBeEnabled();

    /* THE DEFECT, end to end. Under the page-wide guard this click landed on an
       enabled button and did nothing at all — no run, no error, no message — so
       this outcome never appeared. */
    await betaBtn.click();
    await expect(page.getByText(/Fired "Beta trigger": started \(run /)).toBeVisible();

    // And when the held fire finally lands, BOTH outcomes are on screen: the
    // later one did not overwrite the earlier one's run link.
    const alpha = page.getByText(/Fired "Alpha trigger": started \(run /);
    await expect(alpha).toBeVisible();

    // Two fires, two DISTINCT run links, each pointing at its own run.
    const links = page.getByRole('link', { name: /^Watch live → run / });
    await expect(links).toHaveCount(2);
    const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''));
    expect(new Set(hrefs).size, `two fires must yield two runs, got ${hrefs.join(', ')}`).toBe(2);
    // Hash routing in the shipped build, so the `href` carries the `#` the unit
    // suite's memory router does not — asserted as the real app serves it.
    for (const href of hrefs) expect(href).toMatch(/^#\/monitor\/runs\/.+/);

    /* The outcome region is a `log`, not a `status`. `status` is implicitly
       `aria-atomic="true"`, so a screen reader would re-read every prior outcome
       on each new fire; `log` announces only what was added. Asserted because the
       role is the whole reason the append-list is acceptable here. */
    await expect(page.getByRole('log')).toContainText('Alpha trigger');

    await expectQuiet(page, problems);
  });
});
