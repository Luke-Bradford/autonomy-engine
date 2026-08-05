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
 * ONE known caveat, recorded rather than dropped. `playwright.config.ts` keeps a
 * trace on failure, so a FAILING run's artifact carries both the revealed DOM text
 * and the POST url — i.e. the capability token. It is accepted rather than worked
 * around: the token is `HMAC(masterKey, …)` over the e2e master key, which is
 * auto-generated per run into a throwaway `data/e2e` tree alongside the throwaway
 * db, so the artifact holds a credential to a database that no longer exists.
 * Suppressing it would mean not revealing the token in the spec, which is the
 * behaviour under test.
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

/**
 * #901 — the same resume, driven ENTIRELY from the app.
 *
 * ADDED beside the test above rather than replacing its `page.request.post`: that
 * POST is the only end-to-end proof the anonymous A13 seam still resumes a run,
 * and #901 does not change that seam. The two doors need two tests.
 *
 * What only this level can show: the browser completes the wait without ever
 * holding the capability token. The unit tests can assert the client does not SEND
 * one, but only here is the token genuinely derived by the real server, from a
 * request that carried nothing but `(nodeId, attemptId, payload)`.
 *
 * The `decision` output is declared, so the run also proves the body ARRIVED: a
 * completion that dropped the payload would still resume the run, and would still
 * look green from the header alone.
 */
test('#901 — an operator completes the wait from the app, sending no token', async ({ page }) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#901 approval', APPROVAL_DOC);
  const runId = await fireManualTrigger(page, pipelineVersionId, '#901 park');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  await expect(page.locator(headerStatus)).toHaveText('waiting (callback)', { timeout: 20_000 });

  const list = page.getByRole('list', { name: 'Pending callbacks' });
  await expect(list).toBeVisible();

  /* NEVER REVEALED. The whole request below is composed without clicking "Show
     callback URL", so the token is not on the page, not in the DOM, and not in
     this browser context — which is the property #901 exists for. */
  await list.getByRole('button', { name: /^Complete wait for / }).click();
  await expect(list).not.toContainText('/api/external-wait/');

  const body = list.getByRole('textbox', { name: /Callback body/ });

  /* THE REFUSAL FIRST, because it is the half a happy path cannot show: a body
     failing the declared contract must come back NAMING the field, and must leave
     the node parked and the editor usable. Before #901 this reached the operator
     as "request failed (422)" with the reason discarded — the route's error body
     bypassed the shared contract — so this assertion is the fix, not decoration. */
  await body.fill('{"note": "no decision here"}');
  await list.getByRole('button', { name: 'Complete this wait' }).click();
  await expect(list.getByRole('alert')).toContainText('decision');
  await expect(page.locator(headerStatus)).toHaveText('waiting (callback)');
  // Still open, still holding what was typed — a 422 is fixable in place.
  await expect(body).toHaveValue('{"note": "no decision here"}');

  await body.fill('{"decision": "approved in-app"}');
  await list.getByRole('button', { name: 'Complete this wait' }).click();

  /* Resumed through the live tail, with no reload and no `curl`. */
  await expect(page.locator(headerStatus)).toHaveText('success', { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Waiting on a callback' })).toHaveCount(0);

  /* The BODY got through, not just the completion — a completion that dropped the
     payload resumes the run and still reads as success from the header, so the
     value has to be asserted somewhere it is actually recorded.

     Read off the durable LOG rather than the page, because the page does not show
     it: `externalWait.completed` IS the node's success event (there is no
     following `node.succeeded`), and the drill-in's Outputs section folds only
     from `node.succeeded` — so a webhook's declared outputs render nowhere, which
     is true of a `curl` completion too and predates this ticket. Filed as #911.
     When that lands, this assertion should move onto the panel, which is where an
     operator would look. */
  const events = await (await page.request.get(`/api/runs/${runId}/events`)).json();
  const completion = (events as Array<{ type: string; payload: { outputs?: unknown } }>).find(
    (row) => row.type === 'externalWait.completed',
  );
  expect(completion?.payload.outputs).toEqual({ decision: 'approved in-app' });

  /* The one allowed console line is the browser's own network entry for the 422
     this spec PROVOKES — the contract refusal above is the behaviour under test,
     and Chrome logs every non-2xx response whether or not the app handles it (it
     does: the reason is rendered into the alert). Anchored on the browser-level
     wording rather than a bare `/422/`, which would also swallow an unhandled
     `request failed (422)` from the app itself. `expectQuiet` fails an allow
     pattern that matches nothing, so this cannot rot into a blanket mute. */
  await expectQuiet(page, problems, [
    /Failed to load resource: the server responded with a status of 422/,
  ]);
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
