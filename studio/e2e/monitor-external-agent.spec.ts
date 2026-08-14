import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * #988 — Monitor › AI activity, the REPORTED half.
 *
 * NOTHING IS STUBBED HERE, deliberately. The defect was that `/monitor/ai` could
 * only ever describe AI use studio itself dispatched, so the one thing worth
 * proving end to end is that a report from an agent studio did NOT launch
 * traverses the real POST, the real SQLite, the real aggregate and the real
 * render. A fixture-fed component test cannot prove that seam exists — it is
 * exactly the layer the bug lived in.
 *
 * The specs share one server and one database, so every invocation here carries
 * a spec-unique `source` and the assertions are scoped to that row. Asserting on
 * the window's TOTALS would couple this file to whatever else has reported.
 */

/** Spec-unique so a sibling spec's rows can never satisfy these assertions. */
const SOURCE = 'e2e-988-reporter';

/** A distinct source for the "a second reporter is its own row" case. */
const OTHER_SOURCE = 'e2e-988-other';

async function report(
  request: import('@playwright/test').APIRequestContext,
  body: Record<string, unknown>,
) {
  return request.post('/api/monitor/external-activity', { data: body });
}

test.describe('reported external agent activity', () => {
  test('a still-running invocation reported by an outside agent reaches the page', async ({
    page,
    request,
  }) => {
    const startedAt = Date.now() - 5 * 60_000;
    const created = await report(request, {
      source: SOURCE,
      externalId: 'fire-live',
      agent: 'claude',
      model: 'claude-opus-5',
      startedAt,
    });
    expect(created.status(), await created.text()).toBe(201);

    const problems = collectPageProblems(page);
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    const row = page.locator('tr', { hasText: SOURCE });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('claude-opus-5');
    // The invocation has not ended, so it must read as RUNNING — the state the
    // operator was looking at when the panel told them nothing was happening.
    await expect(row).toContainText('not reported');

    // The window notice must NOT claim the window was idle: reported activity is
    // activity, and this is the ticket's own symptom in its second form.
    await expect(page.getByText('No AI or agent activity in this window.')).toHaveCount(0);

    await expectQuiet(page, problems);
  });

  test('re-reporting the same invocation settles it instead of counting it twice', async ({
    page,
    request,
  }) => {
    const startedAt = Date.now() - 4 * 60_000;
    const first = await report(request, {
      source: OTHER_SOURCE,
      externalId: 'fire-settles',
      agent: 'codex',
      model: 'gpt-5',
      startedAt,
    });
    expect(first.status()).toBe(201);

    // The SAME invocation, now finished, with its measurements.
    const second = await report(request, {
      source: OTHER_SOURCE,
      externalId: 'fire-settles',
      agent: 'codex',
      model: 'gpt-5',
      startedAt,
      endedAt: startedAt + 60_000,
      outcome: 'completed',
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 98_000,
    });
    // 200, not 201 — studio recognised the invocation rather than minting a second.
    expect(second.status(), await second.text()).toBe(200);
    expect((await second.json()).id).toBe((await first.json()).id);

    const problems = collectPageProblems(page);
    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);

    const row = page.locator('tr', { hasText: OTHER_SOURCE });
    await expect(row).toHaveCount(1);
    // ONE invocation, and it is no longer running: the two reports are one fire.
    await expect(row).toContainText('1,200 in · 340 out · 98,000 cached');

    const cells = row.locator('td');
    // Columns: Source · Agent · Model · Invocations · Running · Tokens · Last started
    await expect(cells.nth(3)).toHaveText('1');
    await expect(cells.nth(4)).toHaveText('0');

    await expectQuiet(page, problems);
  });

  test('studio refuses a report it cannot render honestly', async ({ request }) => {
    const startedAt = Date.now();

    // A settled outcome with no end stamp would sit in the "running now" count
    // forever; a newline in a grouping key would break the row it renders into.
    const noEnd = await report(request, {
      source: SOURCE,
      externalId: 'fire-bad-1',
      agent: 'claude',
      startedAt,
      outcome: 'completed',
    });
    const badSource = await report(request, {
      source: 'has\nnewline',
      externalId: 'fire-bad-2',
      agent: 'claude',
      startedAt,
    });

    expect(noEnd.status()).toBe(400);
    expect(badSource.status()).toBe(400);
  });
});
