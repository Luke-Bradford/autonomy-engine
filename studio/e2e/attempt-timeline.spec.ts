import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * U12a (#1007) — the run's spans on one shared time axis.
 *
 * The same two-activity fixture #867's duration spec uses, and for the same
 * reason: it puts the timeline's two outcomes on one screen without any egress.
 *
 * `hold` is a `wait`. It parks on an A6 timer and settles when the alarm fires,
 * so it has a start event (`timer.waitScheduled`) and a distinct later terminal
 * (`timer.due`) — a real, MEASURED span, and therefore a bar.
 *
 * `stop` is a `fail`. The engine evaluates it in one step and appends a single
 * `node.failed` that is both its start and its terminal, so nothing ever
 * measured a span for it. It must appear in the "Not on the timeline" list with
 * a stated reason — NOT as a zero-length bar (a number nobody observed) and not
 * omitted (which would let a subset of the run read as the whole of it).
 *
 * The wait is ONE second as a whole-value `${}` expression, which is what
 * `validateWaitConfig` accepts, so the run settles inside `fireAndSettle`'s
 * poll.
 *
 * Asserted by SHAPE, never by value: #867's spec records that pinning "1s"
 * flakes on alarm-poll granularity, and a bar's rendered width is a percentage
 * of a window whose extent depends on the same alarm.
 */
const DOC = {
  nodes: [
    { id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } },
    { id: 'stop', type: 'fail', config: { message: 'planned' }, position: { x: 260, y: 0 } },
  ],
  edges: [{ from: 'hold', to: 'stop', on: 'success' as const }],
};

test('U12a — the timeline draws what was measured and names what was not', async ({ page }) => {
  const problems = collectPageProblems(page);

  const { pipelineVersionId } = await seedVersion(page, 'U12a attempt timeline', DOC);
  const runId = await fireAndSettle(page, pipelineVersionId, 'U12a timeline');

  await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
  await fluentRootReady(page);

  /* `exact`, because Playwright matches an accessible name by SUBSTRING and this
     section deliberately renders a second heading — "Not on the timeline" — which
     a bare 'Timeline' also matches, for a strict-mode violation rather than a
     clean assertion. */
  await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toBeVisible();

  /* Every assertion in ONE evaluate. A per-assertion round trip is what makes a
     browser-driven check expensive, and all of this is readable in one pass. */
  const seen = await page.evaluate(() => {
    const section = document.querySelector('.attempt-timeline');
    if (section === null) return null;
    const bars = [...section.querySelectorAll<HTMLElement>('.timeline-span')];
    return {
      /* Keyed on the row label's `title`, which carries the raw node id. The
         VISIBLE text is `activityLabels`' display name ("Wait 1") — numbered by
         kind, so it identifies neither the authored node nor this spec's
         fixture, and asserting on it would make the spec fail on labelling work
         it is not about (#882's rule, as `node-duration.spec.ts` applies it). */
      rowIds: [...section.querySelectorAll('.timeline-row-label')].map((el) =>
        el.getAttribute('title'),
      ),
      rowNames: [...section.querySelectorAll('.timeline-row-label')].map((el) =>
        (el.textContent ?? '').trim(),
      ),
      bars: bars.map((bar) => ({
        tone: bar.getAttribute('data-tone'),
        open: bar.getAttribute('data-open'),
        // The RESOLVED background, which is the thing a screenshot could not
        // prove: a missing tone rule leaves the default grey rather than nothing.
        background: getComputedStyle(bar).backgroundColor,
        // Rendered geometry, so a bar that computed to `NaN%` (which CSS drops
        // silently) is caught as a collapsed width rather than passing.
        width: bar.getBoundingClientRect().width,
        left: bar.getBoundingClientRect().left,
      })),
      untimed: [...section.querySelectorAll('.timeline-untimed li')].map((el) => ({
        // The id lives on `title`, the same convention as the row label above.
        nodeId: el.querySelector('.timeline-untimed-name')?.getAttribute('title') ?? null,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })),
      trackWidth: section.querySelector('.timeline-track')?.getBoundingClientRect().width ?? 0,
    };
  });

  expect(seen).not.toBeNull();

  // The `wait` node measured a span, so it gets a row and exactly one bar.
  expect(seen!.rowIds).toEqual(['hold']);
  // …under its display name, not its raw id — the row is legible, not just
  // identifiable. Asserted as "not the id" rather than as a literal, so the
  // spec does not re-pin `activityLabels`' numbering scheme.
  expect(seen!.rowNames[0]).not.toBe('hold');
  expect(seen!.rowNames[0]).not.toBe('');
  expect(seen!.bars).toHaveLength(1);

  const [bar] = seen!.bars;
  // It SETTLED, so the bar is closed — not the hatched open form.
  expect(bar!.open).toBeNull();
  // `timer.due` flips a parked node straight to `success`, so the span's own
  // end status is what colours it.
  expect(bar!.tone).toBe('success');
  // A resolved colour, and specifically not the transparent one a missing rule
  // would leave. This is the check a screenshot cannot make.
  expect(bar!.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(bar!.background).not.toBe('transparent');
  // Rendered, with real geometry inside its track.
  expect(seen!.trackWidth).toBeGreaterThan(0);
  expect(bar!.width).toBeGreaterThan(0);
  expect(bar!.width).toBeLessThanOrEqual(seen!.trackWidth + 1);

  /* The `fail` node is NAMED with its reason rather than drawn or dropped —
     the ticket's "documented limits", on screen. Matched on the reason's
     substance, not its exact wording. */
  expect(seen!.untimed).toHaveLength(1);
  expect(seen!.untimed[0]!.nodeId).toBe('stop');
  expect(seen!.untimed[0]!.text).toMatch(/no start-and-terminal pair/);

  await expectQuiet(page, problems);
});
