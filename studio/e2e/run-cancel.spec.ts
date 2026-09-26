import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireManualTrigger, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * CX4 (#1320) — an operator can stop a run from its page.
 *
 * Both cases the cancel spec's CX4 row names, against the REAL server and
 * engine: a run with work IN FLIGHT, and a run PARKED on a timer.
 *
 * The in-flight node is an `agent_task` whose CLI is `sh -c 'sleep 120'`
 * (the adapter appends the task text as a final argument, which `sh -c` takes
 * as `$0` and ignores). Nothing about it is faked: the run is only `cancelled`
 * in well under 120s if the cancel really reached the executor and killed the
 * subprocess. That elapsed-time bound is the assertion that the stop is real,
 * not just a relabelled row.
 *
 * Named to sort AFTER `monitor-ai-activity.spec.ts`: the killed subprocess
 * still records a metered fact, and that spec assumes no billed run precedes it.
 */

async function runStatus(page: Page, runId: string): Promise<string> {
  const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
  if (res.status() !== 200) return `http ${res.status()}`;
  return ((await res.json()) as { status: string }).status;
}

async function eventTypes(page: Page, runId: string): Promise<string[]> {
  const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}/events`);
  if (res.status() !== 200) return [];
  return ((await res.json()) as { type: string }[]).map((e) => e.type);
}

/** Open the run's page, accept the confirmation, click Cancel; return the prompt's text. */
async function cancelFromPage(page: Page, runId: string): Promise<string> {
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  let prompt = '';
  page.once('dialog', (dialog) => {
    prompt = dialog.message();
    void dialog.accept();
  });
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect.poll(() => prompt, { message: 'no confirmation was shown' }).not.toBe('');
  return prompt;
}

const headerPill = (page: Page) => page.locator('.page-hint .run-status');

/** The pill's colour, and the colour `--muted` resolves to in the same scope. */
async function pillColours(page: Page): Promise<{ pill: string; muted: string; error: string }> {
  return headerPill(page).evaluate((el) => {
    const probe = (token: string) => {
      const span = document.createElement('span');
      span.style.color = `var(${token})`;
      el.parentElement!.appendChild(span);
      const colour = getComputedStyle(span).color;
      span.remove();
      return colour;
    };
    return { pill: getComputedStyle(el).color, muted: probe('--muted'), error: probe('--error') };
  });
}

test('CX4 — cancelling a run with work IN FLIGHT stops it, and the page says cancelled', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const created = await page.request.post('/api/connections', {
    data: {
      name: 'e2e sleeper cli',
      kind: 'agent_cli',
      config: { command: '/bin/sh', args: ['-c', 'sleep 120'] },
    },
  });
  expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
  const { id: connectionId } = (await created.json()) as { id: string };
  const doc = {
    nodes: [
      {
        id: 'agent',
        type: 'agent_task',
        config: { task: 'e2e sleep' },
        connectionId,
        position: { x: 0, y: 0 },
      },
    ],
  };
  const { pipelineVersionId } = await seedVersion(page, 'CX4 in-flight', doc);
  const runId = await fireManualTrigger(page, pipelineVersionId, 'CX4 in-flight');

  // The PREMISE: the node is really in flight before anything is cancelled.
  await expect
    .poll(() => eventTypes(page, runId), { message: 'node never dispatched', timeout: 20_000 })
    .toContain('node.dispatched');
  expect(await runStatus(page, runId)).toBe('running');

  const cancelledAt = Date.now();
  const prompt = await cancelFromPage(page, runId);
  // The confirmation names what stops, and never implies a rollback.
  expect(prompt).toMatch(/— running/);
  expect(prompt).toContain('is not undone');

  await expect(headerPill(page)).toHaveText('cancelled', { timeout: 20_000 });
  // Far inside the subprocess's 120s: the cancel KILLED it, it did not wait it out.
  expect(Date.now() - cancelledAt).toBeLessThan(30_000);
  expect(await runStatus(page, runId)).toBe('cancelled');
  expect(await eventTypes(page, runId)).toEqual(
    expect.arrayContaining(['run.cancelRequested', 'node.failed', 'run.finished']),
  );
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);

  // D9 — NEUTRAL, not red: the operator stopped it, nothing went wrong.
  const colours = await pillColours(page);
  expect(colours.pill).toBe(colours.muted);
  expect(colours.pill).not.toBe(colours.error);

  await expectQuiet(page, problems);
});

test('CX4 — cancelling a PARKED run finishes it at once, and the page says cancelled', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const doc = {
    nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${3600}' }, position: { x: 0, y: 0 } }],
  };
  const { pipelineVersionId } = await seedVersion(page, 'CX4 parked', doc);
  const runId = await fireManualTrigger(page, pipelineVersionId, 'CX4 parked');
  await expect
    .poll(() => runStatus(page, runId), { message: 'run never parked', timeout: 20_000 })
    .toBe('waiting');

  const prompt = await cancelFromPage(page, runId);
  expect(prompt).toContain('waiting (timer)');

  await expect(headerPill(page)).toHaveText('cancelled', { timeout: 20_000 });
  expect(await runStatus(page, runId)).toBe('cancelled');
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);

  await expectQuiet(page, problems);
});
