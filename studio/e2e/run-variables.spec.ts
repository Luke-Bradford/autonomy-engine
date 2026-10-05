import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { fluentRootReady } from './support/theme';
import { openActivity } from './support/panels';

/**
 * #844 V7 (spec V-D9) — the run page shows the run's variable values, and the
 * drill-in of a Set/Append node shows the write it made.
 *
 * Egress-free and connection-free: both writers are evaluated by the engine
 * itself, like an `if`, so a real run settles with nothing but the doc. The
 * chain writes `count` once and appends to `rows` twice, and leaves `label` at
 * its default, so the section has to show a replaced value, an array grown one
 * element per write (the event carries the ELEMENT, so a UI that showed the last
 * event's value instead of the engine's array would read `"y"`), and an
 * untouched default.
 */
const DOC: SeedDoc = {
  nodes: [
    {
      id: 's',
      type: 'set_variable',
      config: { variable: 'count', value: '5' },
      position: { x: 0, y: 0 },
    },
    {
      id: 'a',
      type: 'append_variable',
      config: { variable: 'rows', value: 'x' },
      position: { x: 240, y: 0 },
    },
    {
      id: 'b',
      type: 'append_variable',
      config: { variable: 'rows', value: 'y' },
      position: { x: 480, y: 0 },
    },
  ],
  edges: [
    { id: 'e1', from: 's', to: 'a', on: 'success' },
    { id: 'e2', from: 'a', to: 'b', on: 'success' },
  ],
  variables: [
    { name: 'count', type: 'number', default: 0 },
    { name: 'rows', type: 'array', default: [] },
    { name: 'label', type: 'string', default: '' },
  ],
};

test('#844 V7 — a run shows its variables, and a writer’s drill-in shows its write', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#844 V7 run variables', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, '#844 V7 run');

  /* The PREMISE, before the UI: the run succeeded and the three writes reached
     the durable log. Without this the assertions below could pass against a
     run that failed on its first node and a section showing defaults. */
  const run = (await (await page.request.get(`/api/runs/${encodeURIComponent(runId)}`)).json()) as {
    status: string;
  };
  expect(run.status).toBe('success');
  const events = (await (
    await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`)
  ).json()) as { type: string }[];
  expect(events.map((e) => e.type).filter((t) => t.startsWith('variable.'))).toEqual([
    'variable.set',
    'variable.append',
    'variable.append',
  ]);

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  const section = page.getByRole('region', { name: 'Variables', exact: true });
  await expect(section.getByText('Final values.')).toBeVisible();
  /* One read of every row, rather than a locator per cell. */
  const rows = await section
    .locator('tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('th, td')].map((c) => c.textContent ?? '')),
    );
  expect(rows).toEqual([
    ['count', 'Number', '5'],
    ['rows', 'Array', '["x","y"]'],
    ['label', 'String', '""'],
  ]);

  const panel = await openActivity(page, 'Append variable 1');
  await expect(panel.getByRole('heading', { name: 'Variable write' })).toBeVisible();
  await expect(panel.getByText('Appended to rows:')).toBeVisible();
  await expect(panel.locator('#node-detail-variable-write')).toHaveText('"x"');

  await expectQuiet(page, problems);
});
