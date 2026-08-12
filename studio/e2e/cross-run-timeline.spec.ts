import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fireAndSettle, seedVersion } from './support/seedDoc';
import { fluentRootReady } from './support/theme';

/**
 * U29 (#1015) — the runs list on ONE shared time axis, grouped by pipeline.
 *
 * TWO pipelines, fired in order, so the spec can assert the thing that makes
 * this a CROSS-run chart rather than two charts stacked: both lanes are placed
 * against the same window, so the later run's bar sits further right than the
 * earlier one's. A per-lane axis — the plausible implementation slip — would put
 * the first bar of every lane at 0% and fail that comparison.
 *
 * Scoped by pipeline NAME, never by lane count. The e2e database is shared
 * across the whole suite, so `/monitor/runs` renders every other spec's runs
 * too; anything counting lanes or pinning a global position would flake on
 * whatever else ran first. What the shared DB cannot disturb is the ORDER of
 * two runs this spec fired itself, which is why the assertion is that
 * comparison and not an absolute one.
 *
 * The names are unique to this spec for the same reason: `pipelines` has no
 * unique index on `(owner_id, name)`, so a name reused by another spec would
 * legitimately produce two lanes with one heading.
 *
 * A single `wait` per pipeline, one second as a whole-value `${}` expression
 * (what `validateWaitConfig` accepts), so both runs settle inside
 * `fireAndSettle`'s poll and both bars are CLOSED — measured, not hatched.
 */
const DOC = {
  nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
  edges: [],
};

const EARLIER = 'U29 cross-run EARLIER';
const LATER = 'U29 cross-run LATER';

test('U29 — two pipelines, two lanes, one axis', async ({ page }) => {
  const problems = collectPageProblems(page);

  const earlier = await seedVersion(page, EARLIER, DOC);
  await fireAndSettle(page, earlier.pipelineVersionId, 'U29 earlier');
  const later = await seedVersion(page, LATER, DOC);
  await fireAndSettle(page, later.pipelineVersionId, 'U29 later');

  await page.goto('/#/monitor/runs');
  await fluentRootReady(page);

  // The default view is the table, and the chart is not on screen with it.
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toHaveCount(0);

  // The rendered control, not a hand-built URL: this is the operator's path in.
  await page.getByRole('button', { name: 'Timeline', exact: true }).click();

  /* `exact`, because Playwright matches an accessible name by SUBSTRING and the
     section deliberately renders a second heading, "Not on the timeline", which
     a bare 'Timeline' also matches — a strict-mode violation rather than a
     clean assertion. */
  await expect(page.getByRole('heading', { name: 'Timeline', exact: true })).toBeVisible();
  // One panel, one rendering: the chart REPLACES the table.
  await expect(page.getByRole('table')).toHaveCount(0);
  // …and the view is in the URL, so the operator can share or bookmark it.
  expect(new URL(page.url()).hash).toContain('view=timeline');

  /* Every assertion in ONE evaluate. A per-assertion round trip is what makes a
     browser-driven check expensive, and all of this reads in a single pass. */
  const seen = await page.evaluate(
    ([earlierName, laterName]: readonly [string, string]) => {
      const laneOf = (name: string) => {
        const heading = [...document.querySelectorAll('.run-timeline-group-name')].find(
          (h) => (h.textContent ?? '').trim() === name,
        );
        const group = heading?.closest('.run-timeline-group') ?? null;
        if (group === null) return null;
        const bar = group.querySelector<HTMLElement>('.timeline-span');
        const list = group.querySelector('ol');
        return {
          // The lane's list is named BY its heading, which is the only way a
          // reader landing on a bar learns which pipeline's lane it is in.
          labelledBy: list?.getAttribute('aria-labelledby') ?? null,
          headingId: heading?.id ?? null,
          rowCount: group.querySelectorAll('li').length,
          bar:
            bar === null
              ? null
              : {
                  tone: bar.getAttribute('data-tone'),
                  open: bar.getAttribute('data-open'),
                  title: bar.getAttribute('title'),
                  /* The RESOLVED background — the thing a screenshot could not
                     prove. A tone with no CSS rule leaves the track's default
                     grey, which reports an outcome as neutral rather than as
                     nothing at all. */
                  background: getComputedStyle(bar).backgroundColor,
                  /* Rendered geometry, so a bar that computed to `NaN%` (which
                     CSS drops silently, collapsing every bar to the left edge)
                     is caught as a zero width rather than passing. */
                  width: bar.getBoundingClientRect().width,
                  left: bar.getBoundingClientRect().left,
                },
          // The measurement in WORDS, which is what carries the value when a
          // wide axis floors the bar at its 2px minimum.
          length: (group.querySelector('.run-timeline-length')?.textContent ?? '').trim(),
          trackLeft: group.querySelector('.timeline-track')?.getBoundingClientRect().left ?? 0,
        };
      };
      return {
        earlier: laneOf(earlierName),
        later: laneOf(laterName),
        axisNote: (document.querySelector('.timeline-axis-note')?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
      };
    },
    [EARLIER, LATER] as const,
  );

  expect(seen.earlier, `no lane for ${EARLIER}`).not.toBeNull();
  expect(seen.later, `no lane for ${LATER}`).not.toBeNull();

  for (const [name, lane] of [
    ['earlier', seen.earlier],
    ['later', seen.later],
  ] as const) {
    expect(lane!.rowCount, `${name}: one run fired, one row`).toBe(1);
    expect(lane!.labelledBy, `${name}: lane list is named by its own heading`).toBe(
      lane!.headingId,
    );
    expect(lane!.labelledBy, `${name}: heading id is present`).not.toBeNull();
    const bar = lane!.bar;
    expect(bar, `${name}: a bar`).not.toBeNull();
    // Both runs settled, so both bars are CLOSED — not the hatched open form.
    expect(bar!.open, `${name}: settled bar is not hatched`).toBeNull();
    expect(bar!.tone, `${name}: coloured by the run's own status`).toBe('success');
    // A resolved colour, not an unresolved `var()` and not the transparent
    // default a missing rule would leave.
    expect(bar!.background, `${name}: tone resolves to a real colour`).toMatch(/^rgba?\(/);
    expect(bar!.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(bar!.width, `${name}: bar has real width`).toBeGreaterThan(0);
    expect(bar!.title, `${name}: the bar states what it is`).toMatch(/· success · started /);
    // The length as text, which is the row's statement of the value.
    expect(lane!.length, `${name}: a measured length in words`).not.toBe('');
    expect(lane!.length, `${name}: a measured length in words`).not.toBe('—');
  }

  /* THE cross-run claim. The two lanes are laid out in separate `<ol>`s, so the
     only thing tying them together is the shared window — and the only visible
     consequence of that is where the bars land. The later run started after the
     earlier one, so its bar must be further right. Compared against each lane's
     own TRACK origin, so the assertion survives any difference in label-column
     width between the two lanes; under a per-lane axis both offsets would be
     zero and this fails. */
  const earlierOffset = seen.earlier!.bar!.left - seen.earlier!.trackLeft;
  const laterOffset = seen.later!.bar!.left - seen.later!.trackLeft;
  expect(laterOffset, 'the later run sits further along the shared axis').toBeGreaterThan(
    earlierOffset,
  );

  // The axis states its own window and says the reading is a snapshot.
  expect(seen.axisNote).toMatch(/of measured wall clock, as of the last refresh/);

  await expectQuiet(page, problems);
});
