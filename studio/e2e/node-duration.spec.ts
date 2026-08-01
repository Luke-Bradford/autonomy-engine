import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * #867 — the run log can now answer "how long did this node take".
 *
 * Nothing in the event model records a per-node span, so the Monitor derives
 * one from the only clock the log has: the envelope `ts` each event is stamped
 * with at append. The whole correctness question is WHICH pair of stamps, and
 * this fixture is built to put both answers on one screen.
 *
 * `hold` is a `wait` — it parks on an A6 timer and settles when the alarm
 * fires, so it has a start event (`timer.waitScheduled`) and a distinct later
 * terminal (`timer.due`). It is the MEASURED case, and it also pins the rule
 * that a park counts: for a `wait` node, waiting IS the work.
 *
 * `stop` is a `fail` — the engine evaluates it in a single step and appends one
 * `node.failed`, which is simultaneously its start and its terminal. Nothing
 * ever measured a span for it, so the cell must say so with an em-dash. A
 * `0ms` there would be a number nobody observed, and the point of this ticket
 * is that a wrong duration is worse than an absent one.
 *
 * Egress-free like the rest of the run suite: `wait` and `fail` are control
 * activities the engine resolves itself — no connection, no network, no
 * subprocess. The wait is ONE second (as a whole-value `${}` expression, which
 * is what `validateWaitConfig` accepts) so the run actually settles inside
 * `fireAndSettle`'s poll, unlike #870's deliberately-parked hour.
 */
const DOC = {
  nodes: [
    { id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } },
    { id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 260, y: 0 } },
  ],
  edges: [{ from: 'hold', to: 'stop', on: 'success' as const }],
};

test('#867 — a node row states how long it took, and says nothing where nothing was measured', async ({
  page,
}) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, '#867 node duration', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, '#867 duration');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* Both rows' cells in ONE evaluate rather than a locator per assertion: a
     per-assertion round trip is what makes a browser-driven check expensive,
     and every fact here is readable from one pass over the table.

     Rows are keyed by the raw node id in the row's `<code>`, not by position
     and not by the activity NAME. #882 put the name in the row's button and
     left the id beside it precisely so a row stays identifiable — and keying on
     the name would make this spec pass or fail on labelling work it is not
     about. */
  const cells = await page.evaluate(() => {
    const read = (nodeId: string): string | null => {
      /* Any `<code>` in a body cell holding the id, rather than `code.node-id`
         specifically: #882 renders the id in the sibling `<code class="node-id">`
         when the node HAS a name and inside the button's own `<code>` when it
         does not, and this spec is about neither. */
      const code = Array.from(document.querySelectorAll('tbody td code')).find(
        (el) => el.textContent?.trim() === nodeId,
      );
      const row = code?.closest('tr');
      return row?.querySelector('.node-duration')?.textContent?.trim() ?? null;
    };
    return { hold: read('hold'), stop: read('stop') };
  });

  /* A duration, asserted by SHAPE not by value: the span is a real elapsed
     measurement of a one-second timer, so pinning "1s" would make the spec
     flake on the alarm poll's granularity. What must hold is that a number was
     rendered at all — a settled node rendering the em-dash would mean the park's
     terminal never closed its span. */
  expect(cells.hold).toMatch(/\d/);
  expect(cells.hold).not.toBe('—');

  // The unmeasurable case, and the reason the em-dash exists.
  expect(cells.stop).toBe('—');

  // The drill-in is the one surface with room to say what the number MEANS.
  const holdRow = page.locator('tr', { has: page.locator('td code', { hasText: /^hold$/ }) });
  await holdRow.locator('button.node-drill-in').click();
  const panel = page.getByRole('complementary');
  await expect(panel).toContainText('wall clock for the latest attempt');
  await expect(panel).toContainText('including any wait it parked on');

  await expectQuiet(page, problems);
});
