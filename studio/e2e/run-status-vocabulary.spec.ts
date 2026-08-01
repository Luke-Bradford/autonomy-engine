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
 *
 * `seconds` is a STRING holding a WHOLE-VALUE `${}` expression, like
 * `if.condition` — `validateWaitConfig` refuses a bare literal at save time, so
 * the hour is written as an expression the engine evaluates (`evalWaitSeconds`)
 * rather than as a number.
 */
const PARKED_DOC = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${3600}' }, position: { x: 0, y: 0 } }],
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
  // A bare `waiting` is the honest answer here and is pinned as such — the row
  // has no park-reason column, and "fixing" the asymmetry would mean inventing
  // a reason. `runStatusLabel`'s docblock owns the argument.
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

  await expectQuiet(page, problems);
});

/**
 * #873 — the CONTAINER half of the same reconciliation, and the FIRST e2e ever
 * to render a container on the run canvas.
 *
 * The ticket claimed `run-overlay.spec.ts` or `container-rendering.spec.ts`
 * "already drive a container on the run canvas". Neither does: `run-overlay`'s
 * doc has no containers at all, and `container-rendering` drives the AUTHOR
 * canvas. So `runFlowNodes`' container branch had no browser coverage, which is
 * how it kept passing the engine's identifier through for two tickets while the
 * node branch beside it was worded.
 *
 * THE FIXTURE IS THE #870 PARKED NODE, WRAPPED IN A STAGE. A container is
 * `active` only while it is live and unfinished, so the spec needs a run that
 * stays that way — and a `wait` on an hour is already the suite's egress-free
 * way to buy exactly that. `stepContainers` advances a container only once every
 * child is terminal, and `wait_pending` is not terminal, so the stage holds at
 * `active` for as long as the spec needs it. A `stage` also imposes no
 * `exitWhen`/`items`/min-children rules (those are loop/foreach), so the doc
 * needs nothing invented to be savable.
 *
 * It is a SEPARATE fixture from #870's rather than a container added to that
 * one: the run-level spec above is not about containers, and giving it a
 * container would make its parked-run assertions depend on a fact it does not
 * claim.
 */
const PARKED_IN_STAGE_DOC = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${3600}' }, position: { x: 0, y: 0 } }],
  containers: [{ id: 'stg', kind: 'stage' as const, children: ['hold'] }],
};

test('#873 — a live container says "running", the same word its node and its run say', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(
    page,
    '#873 parked in a stage',
    PARKED_IN_STAGE_DOC,
  );
  const runId = await fireManualTrigger(page, pipelineVersionId, '#873 container park');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);
  const canvas = page.getByTestId('run-canvas');
  await expect(canvas).toBeVisible();

  /* Wait on the ASSERTION TARGET itself rather than on the run row's status.
     The row reaching `waiting` while the `wait` sits inside a container is a
     fact this spec has no need to assume — and the retry cannot paper over the
     defect here, because with the wording reverted the box reads `stage 1 · active`
     and never becomes `running` however long it is given. The box is drawn from
     the R1 doc fetch before the WebSocket replay lands, so it says `stage 1` ALONE (the ORDINAL is doc-derived, so it is
     there from that first paint — #886)
     first — `RunCanvas` short-circuits the whole ` · <status>` fragment when
     nothing is projected, so the visible label omits the status entirely and
     `NO_STATUS_LABEL` reaches only the accessible name. This is the assertion
     that can only hold once the projection has arrived.

     The 20s budget is #870's, above, and is needed for the same reason: the
     driver has to start the run, enter the container, dispatch the node and arm
     its alarm before either surface can say anything true. This assertion covers
     strictly MORE than #870's poll — the SPA navigation, the lazy `RunGraph`
     chunk and the WS replay on top — so it cannot take the 5s default. */
  const box = canvas.locator('.run-container .flow-container-label');
  await expect(box).toHaveText('stage 1 · running', { timeout: 20_000 });

  /* And wait on the CHILD's park too, before reading anything one-shot below.
     The container turns `active` at ENTER, which is strictly earlier in the
     lifecycle than its child parking — the driver appends `timer.waitScheduled`
     only once it has armed the alarm, a separate event in a separate frame. So
     the box can already read `running` while the node still reads `ready`, and
     the single `evaluate` below has no retry to save it. This is the assertion
     that closes that window; it replaces #870's run-row poll, which this spec
     deliberately does not borrow, and it does so without assuming anything
     about what the ROW says for a wait nested in a container. */
  await expect(canvas.locator('.run-node .run-node-status')).toHaveText('waiting (timer)', {
    timeout: 20_000,
  });

  /* One evaluate, every remaining assertion. The pairing is the point of the
     ticket: the container and the node it encloses are two levels of one graph,
     and before this they answered "what is happening here?" in two vocabularies
     — `active` on the box, `waiting (timer)` on the node inside it. */
  const graph = await page.evaluate(() => {
    const container = document.querySelector('.run-container');
    const node = document.querySelector('.run-node');
    return {
      boxLabel: container?.querySelector('.flow-container-label')?.textContent?.trim() ?? '',
      boxClasses: container?.className ?? '',
      boxAria: container?.closest('.react-flow__node')?.getAttribute('aria-label') ?? '',
      nodeStatus: node?.querySelector('.run-node-status')?.textContent?.trim() ?? '',
    };
  });

  // The engine's identifier reaches NEITHER surface — not the label, and not
  // the accessible name, which is how U11's "never by colour alone" commitment
  // is actually delivered for a box that carries no status text of its own.
  expect(graph.boxLabel).not.toContain('active');
  expect(graph.boxAria).toContain('running');
  expect(graph.boxAria).not.toContain('active');
  // Named in full, so a truncated or reordered accessible name trips.
  expect(graph.boxAria).toBe('stage 1 container, 1 activity, running');

  /* The hue is PINNED here, not discriminated: `active` is the one member whose
     label and tone are the same word, so this assertion reads identically
     whether the class is keyed off the status or off the label. It is worth
     asserting anyway — it proves the class RESOLVED on the box the operator is
     looking at — but the seam itself is guarded where it can actually fail, in
     `runFlow.test.ts`, which walks all five members and catches the four whose
     label and tone diverge. */
  expect(graph.boxClasses).toContain('run-container-running');

  /* The honest limit, asserted rather than left to be discovered: a container
     has no park member, so a live stage whose only child is parked reads
     `running` above a child reading `waiting (timer)`. That is correct — the box
     IS live, and WHAT it waits on is the child's fact — and pinning it here
     stops a later reader "fixing" the pair into agreement by inventing a
     container park word the engine cannot back. */
  expect(graph.nodeStatus).toBe('waiting (timer)');

  await expectQuiet(page, problems);
});
