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

/**
 * Open the run's page, accept the confirmation, click Cancel. Returns the
 * prompt's text and when the click happened — the clock starts HERE, not before
 * the navigation, so the elapsed-time bound measures the stop and not page load.
 */
async function cancelFromPage(
  page: Page,
  runId: string,
): Promise<{ prompt: string; clickedAt: number }> {
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  let prompt = '';
  page.once('dialog', (dialog) => {
    prompt = dialog.message();
    void dialog.accept();
  });
  const button = page.getByRole('button', { name: 'Cancel run' });
  await expect(button).toBeEnabled();
  const clickedAt = Date.now();
  await button.click();
  await expect.poll(() => prompt, { message: 'no confirmation was shown' }).not.toBe('');
  return { prompt, clickedAt };
}

/** The status word in the node table's row for the node whose name contains `name`. */
const nodeRowStatus = (page: Page, name: string) =>
  page.locator('tr', { has: page.getByRole('button', { name }) }).locator('.node-status');

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
      /* The agent's FAILURE handler. The cancel fails the agent, which would make
         this READY — and cancel mode starts no new work, failure handlers
         included (spec D2), so it stays `pending`. (A SUCCESS successor would
         be `skipped` instead: the pure fixpoint still runs under a cancel.) */
      { id: 'after', type: 'wait', config: { seconds: '${0}' }, position: { x: 240, y: 0 } },
    ],
    edges: [{ from: 'agent', to: 'after', on: 'failure' as const }],
  };
  const { pipelineVersionId } = await seedVersion(page, 'CX4 in-flight', doc);
  const runId = await fireManualTrigger(page, pipelineVersionId, 'CX4 in-flight');

  // The PREMISE: the node is really in flight before anything is cancelled.
  await expect
    .poll(() => eventTypes(page, runId), { message: 'node never dispatched', timeout: 20_000 })
    .toContain('node.dispatched');
  expect(await runStatus(page, runId)).toBe('running');

  const { prompt, clickedAt } = await cancelFromPage(page, runId);
  // The confirmation names what stops, and never implies a rollback.
  expect(prompt).toMatch(/— running/);
  expect(prompt).toContain('is not undone');

  await expect(headerPill(page)).toHaveText('cancelled', { timeout: 20_000 });
  // Far inside the subprocess's 120s: the cancel KILLED it, it did not wait it out.
  expect(Date.now() - clickedAt).toBeLessThan(30_000);
  expect(await runStatus(page, runId)).toBe('cancelled');
  expect(await eventTypes(page, runId)).toEqual(
    expect.arrayContaining(['run.cancelRequested', 'node.failed', 'run.finished']),
  );
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
  // The in-flight node failed under the cancel; its successor never started.
  await expect(nodeRowStatus(page, 'Agent')).toHaveText('failure');
  await expect(nodeRowStatus(page, 'Wait')).toHaveText('not run (cancelled)');

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

  const { prompt } = await cancelFromPage(page, runId);
  expect(prompt).toContain('waiting (timer)');

  await expect(headerPill(page)).toHaveText('cancelled', { timeout: 20_000 });
  expect(await runStatus(page, runId)).toBe('cancelled');
  await expect(page.getByRole('button', { name: 'Cancel run' })).toHaveCount(0);
  // D5 — the run finished with the park still on the node; it is not still waiting.
  await expect(nodeRowStatus(page, 'Wait')).toHaveText('stopped (cancelled)');
  /* #1329 — and its COLOUR says stopped on every surface, not the `holding` hue
     of a park still due: the table pill, the graph node and the open span on
     the attempt timeline. One read, every assertion. */
  const stopped = await page.evaluate(() => {
    const pill = [...document.querySelectorAll<HTMLElement>('tr .node-status')].find(
      (el) => el.textContent?.trim() === 'stopped (cancelled)',
    );
    const probe = document.createElement('span');
    probe.style.color = 'var(--muted)';
    pill?.parentElement?.appendChild(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const node = document.querySelector<HTMLElement>('.run-node');
    const span = document.querySelector<HTMLElement>('.timeline-span[data-open="true"]');
    return {
      pillClass: pill?.className ?? null,
      pillIsMuted: pill !== undefined && getComputedStyle(pill).color === muted,
      nodeClass: node?.className ?? null,
      nodeStatus: node?.querySelector('.run-node-status')?.textContent?.trim() ?? null,
      spanTone: span?.getAttribute('data-tone') ?? null,
      spanText: span?.textContent ?? null,
    };
  });
  expect(stopped.pillClass).toBe('node-status node-status-cancelled');
  expect(stopped.pillIsMuted).toBe(true);
  expect(stopped.nodeClass).toContain('run-node-neutral');
  expect(stopped.nodeClass).not.toContain('run-node-holding');
  expect(stopped.nodeStatus).toBe('stopped (cancelled)');
  expect(stopped.spanTone).toBe('neutral');
  expect(stopped.spanText).toContain('stopped (cancelled)');

  await expectQuiet(page, problems);
});
