import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { DENSITIES, DESIGN_RUNS, expectAppearance, preferAppearance } from './support/appearance';
import { expectOnRampWithEachHelp } from './support/typeRamp';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { openRunView } from './support/panels';

/**
 * #1594 OR40 S6g — the run page on the design system, at 1440x900 in compact
 * light and comfortable dark: its secondary views (Gantt, Events, Variables,
 * Cost) each measured with its tab open, because `PanelTabs` keeps the others
 * mounted but hidden and a hidden panel draws no text.
 *
 * On every view: each of its sections is the `Section` primitive (a named
 * region whose `?` is its description, so no static prose), all text is on the
 * type ramp with every `?` closed and then with each open in turn, and nothing
 * scrolls the page sideways. The header and the activity runs above the tabs
 * are on screen in every one of those readings.
 *
 * The seeded run has something to show in every view: a timed activity (the
 * Gantt's bar) and two untimed ones (its "Not on the timeline" list), a variable
 * written from a global parameter (Variables and Global parameters) and a CLI
 * exchange at a known zero cost (Cost, whose figure is a `<strong>`).
 */

type Density = (typeof DENSITIES)[number];

/** Each view, and the sections it must show. */
const VIEWS = [
  { view: 'Gantt', sections: ['Timeline'] },
  { view: 'Events', sections: ['Why this run behaved as it did'] },
  { view: 'Variables', sections: ['Variables', 'Global parameters'] },
  { view: 'Cost', sections: ['Cost & usage'] },
] as const;

/** The page's sideways overflow, in ONE evaluate. */
function sideways(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const root = document.scrollingElement!;
    return Math.max(root.scrollWidth - root.clientWidth, content.scrollWidth - content.clientWidth);
  });
}

for (const { density, theme } of DESIGN_RUNS) {
  test(`#1594 OR40 S6g — the run page: every view in Sections, on the ramp with each ? open, no sideways scroll (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, density as Density);

    const globalName = `s6g_region_${density}`;
    const global = await page.request.post('/api/global-params', {
      data: { name: globalName, type: 'string', value: 'eu' },
    });
    expect(global.status(), await global.text()).toBe(201);
    const { id: globalId } = (await global.json()) as { id: string };
    const created = await page.request.post('/api/connections', {
      data: {
        name: `S6g echo cli ${density}`,
        kind: 'agent_cli',
        config: { command: '/bin/echo' },
      },
    });
    expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
    const { id: connectionId } = (await created.json()) as { id: string };
    const doc: SeedDoc = {
      nodes: [
        {
          id: 's',
          type: 'set_variable',
          config: { variable: 'label', value: `\${global.${globalName}}` },
          position: { x: 0, y: 0 },
        },
        {
          id: 'a',
          type: 'append_variable',
          config: { variable: 'rows', value: 'x' },
          position: { x: 240, y: 0 },
        },
        {
          id: 'c',
          type: 'agent_task',
          config: { task: 'S6g ping' },
          connectionId,
          position: { x: 480, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'a', on: 'success' },
        { id: 'e2', from: 'a', to: 'c', on: 'success' },
      ],
      variables: [
        { name: 'label', type: 'string', default: '' },
        { name: 'rows', type: 'array', default: [] },
      ],
    };
    const { pipelineVersionId } = await seedVersion(page, `S6g run page ${density}`, doc);
    const runId = await fireAndSettle(page, pipelineVersionId, `S6g ${density}`);

    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    await expectAppearance(page, theme, density as Density);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    for (const { view, sections } of VIEWS) {
      await openRunView(page, view);
      for (const name of sections) {
        const region = page.getByRole('region', { name, exact: true });
        await expect(region.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
        await expect(region.locator(`summary[aria-label="About ${name}"]`)).toBeVisible();
      }
      if (view === 'Gantt') {
        // A bar and the untimed list both draw, so their type is measured.
        await expect(page.locator('.timeline-row-label').first()).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Not on the timeline' })).toBeVisible();
      }
      if (view === 'Cost') await expect(page.locator('.section__body strong')).toBeVisible();
      expect(await sideways(page), `${view}: sideways scroll`).toBe(0);
      await expectOnRampWithEachHelp(page, density as Density, view);
    }

    await expectQuiet(page, problems);
    expect((await page.request.delete(`/api/global-params/${globalId}`)).ok()).toBe(true);
  });
}
