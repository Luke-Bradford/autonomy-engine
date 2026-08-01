import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #866 — the run monitor's drill-in says what a node SPENT.
 *
 * EGRESS-FREE, and the trick that makes it so is the point of the spec rather
 * than a convenience: an `agent_cli` connection runs an ARBITRARY command, and
 * `cliSpendFact` mints an `activity.metered` for any subprocess that RAN,
 * BEFORE any parsing of what it printed. So `/bin/echo` produces a real,
 * durably-appended spend fact with no network, no credential and no provider.
 *
 * It also lands on exactly the shape this ticket is about. A CLI spend fact is
 * `meteringStatus:'unpriced'` with NO token counts at all, so it exercises the
 * two readings a naive renderer gets wrong:
 *
 *   - the money is a KNOWN covered zero, not an unmeasured one, so the panel
 *     must not print `$0.00` (which reads as "we priced it and it was free")
 *     NOR "cost unknown" (which reads as a measurement gap);
 *   - nobody counted tokens, so `0 in · 0 out` would be a measurement that was
 *     never taken — the manufactured-zero failure this whole surface exists to
 *     avoid.
 *
 * The tool-call table has no egress-free producer (`activity.toolCalled` comes
 * only from the `llm_call` tool loop, which needs an HTTP provider), so it is
 * covered by the unit/component tests instead — see #892.
 */
test('#866 — a node drill-in states its spend, and never invents a figure', async ({ page }) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: { name: 'e2e echo cli', kind: 'agent_cli', config: { command: '/bin/echo' } },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };

  /* Hoisted rather than inlined: an inline literal in the `seedVersion(...)`
     call trips excess-property checking against `SeedDoc`. */
  const doc = {
    nodes: [
      {
        id: 'agent',
        type: 'agent_task',
        config: { task: 'e2e ping' },
        connectionId,
        position: { x: 0, y: 0 },
      },
    ],
  };
  const { pipelineVersionId } = await seedVersion(page, '#866 agent spend', doc);
  const runId = await fireAndSettle(page, pipelineVersionId, '#866 agent');

  /* The PREMISE, asserted before the UI: a real `activity.metered` reached the
     durable log. Without this the UI assertions below could pass against a
     panel that simply renders the empty case. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  expect(eventsRes.status()).toBe(200);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  expect(events.filter((e) => e.type === 'activity.metered').map((e) => e.payload)).toEqual([
    expect.objectContaining({ provider: 'agent_cli', meteringStatus: 'unpriced' }),
  ]);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  await page.getByRole('button', { name: 'Agent Task 1' }).click();
  const panel = page.getByRole('complementary', { name: /Node Agent Task 1/ });

  await expect(panel.getByRole('heading', { name: 'Cost & usage' })).toBeVisible();
  // A KNOWN zero, said as one.
  await expect(panel.getByText('No marginal cost')).toBeVisible();
  // Not a priced zero…
  await expect(panel.getByText('$0.00', { exact: true })).toHaveCount(0);
  // …and not a measurement gap either.
  await expect(panel.getByText('Cost unknown')).toHaveCount(0);
  // Tokens nobody counted are said to be uncounted, not rendered as zeros.
  await expect(panel.getByText('not reported')).toBeVisible();
  await expect(panel.getByText(/0 in · 0 out/)).toHaveCount(0);
  // And the exchange count is named as a floor: a CLI reports none of the model
  // calls it drives internally.
  await expect(panel.getByText(/floor, not a census/)).toBeVisible();

  // A node whose loop ran no tools gets no tool table at all.
  await expect(panel.getByRole('heading', { name: 'Tool calls' })).toHaveCount(0);

  await expectQuiet(page, problems);
});
