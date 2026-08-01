import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireManualTrigger, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #900 — the run monitor's "waiting on a callback" surface.
 *
 * A16 shipped the whole producer — the correlation row, the derived capability
 * token, the typed-output inbound contract, `GET /api/runs/:id/external-waits` —
 * and NOTHING in the web app called it. The monitor said `waiting (callback)` and
 * stopped there, so a human-approval pipeline could be authored and fired but
 * never approved without reaching for `curl`.
 *
 * This spec is the level at which that being joined up is provable. The unit tests
 * mock the request, so they can show the page ASKS and renders the answer; only
 * here does the REAL token get derived by the real server and posted back. Hence
 * the last third: the path the page reveals is POSTed, and the run is watched
 * resuming through the live tail. A spec that only asserted the URL was on screen
 * would pass just as happily on a URL that resumes nothing.
 *
 * The fixture is egress-free, `fireAndSettle`'s standing requirement: `webhook` is
 * a `kind:'control'` activity needing no connection and making no outbound call —
 * it parks on an alarm and waits. It is also why `fireManualTrigger` is the right
 * helper: a parked run never reaches a terminal status, so `fireAndSettle` would
 * simply time out on it.
 */
const APPROVAL_DOC = {
  nodes: [
    {
      id: 'approve',
      type: 'webhook',
      // A whole-value `${}` expression, not a bare literal — `validateWebhookConfig`
      // refuses the literal at save time, exactly as it does for `wait.seconds`.
      // Long enough that the expiry alarm cannot race the assertions below.
      config: { timeoutSeconds: '${600}', outputs: [{ name: 'decision', type: 'string' }] },
      position: { x: 0, y: 0 },
    },
  ],
};

/** A `wait` node parks the run too — on a TIMER, which owes no callback. */
const TIMER_DOC = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${600}' }, position: { x: 0, y: 0 } }],
};

/** The header pill, scoped so it cannot match the node table's own status word. */
const headerStatus = '.page-hint .run-status';

test('#900 — a parked run says where its callback goes, and the URL it reveals resumes it', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#900 approval', APPROVAL_DOC);
  const runId = await fireManualTrigger(page, pipelineVersionId, '#900 park');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* PIN THE PARK FIRST. Everything below is a claim about a run parked on a
     CALLBACK; on a run that failed to park, or parked on a timer, the assertions
     would be measuring the wrong thing while the title claimed otherwise. */
  await expect(page.locator(headerStatus)).toHaveText('waiting (callback)', { timeout: 20_000 });

  const list = page.getByRole('list', { name: 'Pending callbacks' });
  await expect(list).toBeVisible();

  // The parked node is named (#878), never shown as the raw id it is keyed on.
  await expect(list).toContainText('Webhook (external wait) 1');

  /* And the page states the inbound CONTRACT. A declared output is mandatory —
     omitting it is a 422 that leaves the node parked — so an operator handed only
     a URL would discover this by failing. Read off `outputContract`, the same
     reader the boundary validates with. */
  await expect(list).toContainText('must be JSON supplying “decision” (string)');

  /* The token is a live bearer capability, so it is not painted onto the page.
     Reveal-on-demand, matching the webhook-secret block on the triggers page. */
  await expect(list).not.toContainText('/api/external-wait/');
  await list.getByRole('button', { name: 'Show callback URL' }).click();

  const revealed = await list.locator('code', { hasText: '/api/external-wait/' }).innerText();
  const callbackPath = revealed.replace(/^POST\s+/, '').trim();
  expect(callbackPath).toMatch(/^\/api\/external-wait\/.+/);

  /* THE POINT OF THIS SPEC: the path on screen is the one that works. A real,
     server-derived token, posted back with a body satisfying the declared
     contract. */
  const res = await page.request.post(callbackPath, { data: { decision: 'ship it' } });
  expect(res.status(), `posting the revealed callback: ${await res.text()}`).toBe(204);

  /* The live tail carries the resume, with no reload — and the section goes away
     with the park rather than leaving a now-dead token on screen. */
  await expect(page.locator(headerStatus)).toHaveText('success', { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Waiting on a callback' })).toHaveCount(0);
  await expect(list).toHaveCount(0);

  await expectQuiet(page, problems);
});

test('#900 — a run parked on a TIMER is offered no callback surface', async ({ page }) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#900 timer', TIMER_DOC);
  const runId = await fireManualTrigger(page, pipelineVersionId, '#900 timer park');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* The withhold half, and the reason the gate is the waiting REASON rather than
     the bare `waiting` status: this run is every bit as `waiting` as the one
     above, and owes no callback at all. Pinned to `(timer)` first, so the
     absences below are absences on the case the title names. */
  await expect(page.locator(headerStatus)).toHaveText('waiting (timer)', { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Waiting on a callback' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Pending callbacks' })).toHaveCount(0);

  await expectQuiet(page, problems);
});
