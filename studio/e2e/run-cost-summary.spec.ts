import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * U27 slice 1 (#930) — the run monitor says what the RUN cost.
 *
 * EGRESS-FREE by the same trick #866's spec documents: an `agent_cli` connection
 * runs an arbitrary command, and `cliSpendFact` mints an `activity.metered` for
 * any subprocess that RAN, before any parsing of what it printed. So `/bin/echo`
 * produces a real, durably-appended spend fact with no network, no credential and
 * no provider.
 *
 * It lands on the shape this ticket is about. A CLI spend fact is
 * `meteringStatus:'unpriced'` with no token counts at all, so a run made of them
 * exercises the two run-level readings a naive total gets wrong: the money is a
 * KNOWN covered zero (so not `$0.00`, which reads as "we priced it and it was
 * free", and not "cost unknown", which reads as a measurement gap), and nobody
 * counted tokens (so not `0 in · 0 out`, a measurement never taken).
 *
 * TWO nodes rather than one, deliberately: the run-level figure has to be a SUM
 * over the whole log, and a single-node run cannot tell a sum from a copy of the
 * one node's cost.
 */
test('#930 — the run monitor totals a run’s spend, and never invents a figure', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: { name: 'e2e echo cli run-cost', kind: 'agent_cli', config: { command: '/bin/echo' } },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };

  /* Hoisted rather than inlined: an inline literal in the `seedVersion(...)`
     call trips excess-property checking against `SeedDoc`. */
  const doc: SeedDoc = {
    nodes: [
      {
        id: 'first',
        type: 'agent_task',
        config: { task: 'e2e ping one' },
        connectionId,
        position: { x: 0, y: 0 },
      },
      {
        id: 'second',
        type: 'agent_task',
        config: { task: 'e2e ping two' },
        connectionId,
        position: { x: 240, y: 0 },
      },
    ],
    edges: [{ id: 'e1', from: 'first', to: 'second', on: 'success' }],
  };
  const { pipelineVersionId } = await seedVersion(page, '#930 run spend', doc);
  const runId = await fireAndSettle(page, pipelineVersionId, '#930 run');

  /* The PREMISE, asserted before the UI: TWO real `activity.metered` events
     reached the durable log. Without this the assertions below could pass
     against a section that simply renders the empty case. */
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  expect(eventsRes.status()).toBe(200);
  const events = (await eventsRes.json()) as { type: string; payload: Record<string, unknown> }[];
  const meteredPayloads = events.filter((e) => e.type === 'activity.metered').map((e) => e.payload);
  expect(meteredPayloads).toHaveLength(2);
  for (const p of meteredPayloads) {
    expect(p).toEqual(
      expect.objectContaining({ provider: 'agent_cli', meteringStatus: 'unpriced' }),
    );
  }

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* The RUN-level section, addressed by its landmark rather than by position, so
     it cannot silently match the drill-in's identically-titled one. */
  const section = page.getByRole('region', { name: 'Cost & usage' });
  await expect(section.getByRole('heading', { name: 'Cost & usage', level: 3 })).toBeVisible();

  // A KNOWN zero, said as one — over the WHOLE run.
  await expect(section.getByText('No marginal cost')).toBeVisible();
  await expect(
    section.getByText(/2 billed exchanges, every one a subscription or CLI call/),
  ).toBeVisible();
  // Not a priced zero…
  await expect(section.getByText('$0.00', { exact: true })).toHaveCount(0);
  // …and not a measurement gap either.
  await expect(section.getByText('Cost unknown')).toHaveCount(0);
  // Tokens nobody counted are said to be uncounted, not rendered as zeros.
  await expect(section.getByText('not reported')).toBeVisible();
  await expect(section.getByText(/0 in · 0 out/)).toHaveCount(0);
  // The exchange count is named as a floor: a CLI reports none of the model
  // calls it drives internally.
  await expect(section.getByText(/floor, not a census/)).toBeVisible();
  // A settled run must NOT carry the still-spending caveat.
  await expect(section.getByText(/has not settled/)).toHaveCount(0);
  // Nothing was reused — an ordinary run makes no claim about a source run.
  await expect(section.getByText(/REUSED from run/)).toHaveCount(0);

  await expectQuiet(page, problems);
});
