import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireManualTrigger, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #870 — the Monitor speaks ONE run-status vocabulary, and a parked run says
 * WHY it is parked.
 *
 * U25 closed this at NODE level on the run detail page. One level up, the runs
 * LIST printed the DB enum's identifier while the detail header printed either
 * the engine's lifecycle status or the row's, and `deriveRunLifecycle` folded a
 * `run.waiting` to the bare word `waiting` while dropping the event's
 * `WaitingReason` on the floor. So an operator staring at a run that was not
 * advancing could not tell a timer from an awaited inbound callback from a
 * capacity hold — a distinction the engine had already made and every reader
 * threw away.
 *
 * THE FIXTURE IS A RUN THAT DOES NOT SETTLE, which is the point: a single
 * `wait` node with an hour on it. `wait` is a control activity the engine
 * resolves itself, so this is egress-free like the rest of the run suite — no
 * connection, no network, no subprocess — but unlike the others it parks and
 * STAYS parked, which is exactly the state the ticket is about. It is fired
 * through the public API (`fireManualTrigger`) rather than settled, because
 * settling is what it will never do.
 */
const PARKED_DOC = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: 3600 }, position: { x: 0, y: 0 } }],
};

test('#870 — a parked run says WHAT it is waiting on, in one vocabulary across both Monitor surfaces', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#870 parked run', PARKED_DOC);
  const runId = await fireManualTrigger(page, pipelineVersionId, '#870 park');

  /* Wait for the PARK on the row, not on the screen. The driver has to dispatch
     the wait node, arm its alarm and append `run.waiting` before either surface
     can say anything true — asserting the rendered word first would race that,
     and a retrying locator would paper over the race by simply passing later. */
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
        if (res.status() !== 200) return `http ${res.status()}`;
        return ((await res.json()) as { status: string }).status;
      },
      { message: `run ${runId} never parked`, timeout: 20_000 },
    )
    .toBe('waiting');

  // ── The run LIST ────────────────────────────────────────────────────────────
  // It reads the DB row, which carries no park reason, so a bare `waiting` here
  // is the honest answer and is pinned as such: one surface knowing LESS than
  // another is not the drift this ticket closes, and "fixing" it would mean
  // inventing a reason the row does not have.
  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);
  const row = page.locator('tr', { has: page.getByText(runId, { exact: true }) });
  await expect(row.locator('.run-status')).toHaveText('waiting');

  // ── The run DETAIL header ───────────────────────────────────────────────────
  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* The whole ticket in one assertion: the reason the engine recorded, worded
     for an operator, on the surface that has the event log. `wait` parks on an
     A6 timer, so the reason is `waiting_timer` — and the header must say which
     alarm, not merely that something is pending. */
  const header = page.locator('.page-hint .run-status');
  await expect(header).toHaveText('waiting (timer)');

  /* One evaluate, every remaining assertion — a per-assertion round trip is
     what makes a browser-driven verification expensive.

     The PILL CLASS is asserted alongside the word because the two are built
     from different values on purpose: the class is keyed by the STATUS
     (`run-status-waiting`, so `palette.test.ts` can hold a rule for every enum
     member) while the text is keyed by the status AND its reason. A refactor
     that keyed the class off the label instead would silently unstyle the pill
     — the colour would fall through to the unstyled default — and no
     word-level assertion would notice. */
  const pill = await page.evaluate(() => {
    const el = document.querySelector('.page-hint .run-status');
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return {
      text: el.textContent?.trim() ?? '',
      classes: el.className,
      color: cs.color,
    };
  });

  expect(pill).not.toBeNull();
  expect(pill!.classes).toContain('run-status-waiting');
  // Keyed by the status, NOT by the label — a class built from `waiting (timer)`
  // would not match any rule in the stylesheet.
  expect(pill!.classes).not.toContain('timer');
  // The muted park hue actually RESOLVED. An unresolved custom property comes
  // back as the initial `rgba(0, 0, 0, 0)`/`currentcolor`, which is the silent
  // failure no screenshot catches.
  expect(pill!.color).toMatch(/^rgb\(/);

  await expectQuiet(problems);
});
