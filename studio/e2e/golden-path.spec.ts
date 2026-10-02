import { expect, test } from '@playwright/test';
import { openCanvas } from './support/canvas';
import {
  WIDE_CANVAS,
  addActivity,
  canvasNodes,
  connectNodes,
  dragNodeBy,
  edgeGroup,
  fitAndSettle,
} from './support/canvasGraph';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { properties, triggerForm } from './support/panels';
import { rowMenuButton } from './support/rowMenu';

/**
 * #1386 — one operator path, end to end, through the UI.
 *
 * Every step below is covered somewhere else, but always in isolation: the
 * connection specs never bind what they create, the canvas specs bind
 * connections seeded over the API, and the run-page specs fire over the API.
 * So "an operator can create a connection, author a pipeline that uses it,
 * trigger it and read what happened" was inferred from the parts and proven by
 * nothing. This spec proves it, and is the evidence an `[mvp-ready]` rests on.
 *
 * The only API calls are READS that pin a premise before the UI is trusted with
 * it. Every WRITE is a click.
 *
 * Egress-free by construction: the connection is `agent_cli` running
 * `/bin/echo` (an exec, not a socket; see `fireAndSettle`'s docblock), and the
 * second node is a `wait` of `${0}`, which the engine resolves itself.
 */

const CONNECTION = 'Golden path echo';
const PIPELINE = 'Golden path';
const TRIGGER = 'Golden path trigger';
const TASK = 'say golden path';

test('#1386 — create a connection, author and bind, trigger it, and read the run log', async ({
  page,
}) => {
  await page.setViewportSize(WIDE_CANVAS);
  const problems = collectPageProblems(page);

  // 1. Manage → Connections → New connection.
  await page.goto('/#/manage/connections');
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  await fluentRootReady(page);
  await page.getByRole('button', { name: 'New connection' }).click();
  const connectionForm = page.getByRole('form', { name: 'Connection form' });
  await connectionForm.getByLabel('Name').fill(CONNECTION);
  await connectionForm.getByLabel('Kind').selectOption('agent_cli');
  await connectionForm.getByLabel('Command', { exact: true }).fill('/bin/echo');
  await connectionForm.getByRole('button', { name: 'Create connection' }).click();
  await expect(rowMenuButton(page, CONNECTION)).toBeVisible();

  // 2. Author → a new pipeline: an Agent Task, then a Wait, wired on success.
  await openCanvas(page, PIPELINE);
  await addActivity(page, 'Agent Task');
  await expect(canvasNodes(page)).toHaveCount(1);
  await addActivity(page, 'Wait');
  await fitAndSettle(page, 1);
  await expect(canvasNodes(page)).toHaveCount(2);
  await dragNodeBy(page, 1, 300, 60);
  await connectNodes(page, 0, 1);
  await expect(edgeGroup(page)).toHaveCount(1);

  // 3. Configure both nodes, binding the Agent Task to the connection from step 1.
  await canvasNodes(page).nth(0).click();
  const panel = properties(page);
  await panel.getByLabel('Connection', { exact: true }).selectOption({
    label: `${CONNECTION} (Agent CLI (subscription))`,
  });
  await panel.getByLabel('Task', { exact: true }).fill(TASK);
  await panel.getByRole('button', { name: 'Apply config', exact: true }).click();

  await canvasNodes(page).nth(1).click();
  await panel.getByLabel('Wait time (seconds)', { exact: true }).fill('${0}');
  await panel.getByRole('button', { name: 'Apply config', exact: true }).click();

  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  // Filtered, not bare: the canvas can hold a second `.notice` (its clipboard
  // and tidy messages), and a bare locator would then match both.
  await expect(page.locator('.notice', { hasText: 'Saved v1.' })).toBeVisible();

  // 4. Manage → Triggers → New trigger, bound to the version just saved.
  await page.goto('/#/manage/triggers');
  await fluentRootReady(page);
  await expect(page.getByRole('heading', { name: 'Triggers' })).toBeVisible();
  await page.getByRole('button', { name: /New trigger/i }).click();
  const form = triggerForm(page);
  await form.getByLabel('Name').fill(TRIGGER);
  await form.getByLabel('Pipeline version').selectOption({ label: `${PIPELINE} v1` });
  await form.getByRole('button', { name: /Create trigger/i }).click();

  // 5. Fire now → Watch live.
  await page.getByRole('button', { name: `Fire now: ${TRIGGER}`, exact: true }).click();
  const fired = page.getByText(new RegExp(`Fired "${TRIGGER}": started \\(run `));
  await expect(fired).toBeVisible();
  await page.getByRole('link', { name: /^Watch live →/ }).click();
  await expect(page).toHaveURL(/#\/monitor\/runs\//);
  const runId = decodeURIComponent(page.url().split('/').pop() ?? '');

  /* PREMISE, read before the page is trusted: the run really succeeded, both
     nodes really ran, and the agent was handed the connection from step 1. A
     run page that rendered a stale or empty run would otherwise pass the UI
     assertions below by accident. */
  await expect
    .poll(async () => {
      const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
      return ((await res.json()) as { status: string }).status;
    })
    .toBe('success');
  const eventsRes = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  expect(eventsRes.status()).toBe(200);
  const events = (await eventsRes.json()) as {
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }[];
  const types = events.map((e) => e.type);
  // A trigger-launched run records WHICH trigger before it starts.
  expect(types.slice(0, 2)).toEqual(['run.triggerContext', 'run.started']);
  expect(events.at(-1)?.payload).toMatchObject({ type: 'run.finished', outcome: 'success' });
  /* The agent ran THROUGH the step-1 connection: `/bin/echo` hands back the task
     as its output, so this value exists only if the node was dispatched with
     that connection's command. */
  expect(events.filter((e) => e.type === 'node.succeeded').map((e) => e.payload)).toEqual([
    expect.objectContaining({ outputs: expect.objectContaining({ output: TASK }) }),
  ]);
  // The Wait ran after it, on the success edge. A wait settles through its
  // alarm (`timer.due`), not `node.succeeded`, so this is its completion fact.
  expect(types.indexOf('timer.due')).toBeGreaterThan(types.indexOf('node.succeeded'));

  // 6. The run log, as the operator reads it. The REST read above is the oracle;
  // the page must mirror it exactly: one row per durable event, in seq order,
  // naming each event's type.
  const feed = page.locator('table.event-feed tbody tr');
  await expect(feed).toHaveCount(events.length);
  await expect(feed.locator('td:nth-child(3)')).toHaveText(types);
  await expect(feed.locator('td:nth-child(1)')).toHaveText(events.map((e) => String(e.seq)));

  await expectQuiet(page, problems);
});
