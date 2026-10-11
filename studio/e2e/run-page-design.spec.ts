import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H, DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { offRampText } from './support/typeRamp';
import { fireAndSettle, seedVersion, type SeedDoc } from './support/seedDoc';
import { openRunView } from './support/panels';

/**
 * #1594 OR40 S6g — the run page on the design system, at 1440x900 in compact
 * light and comfortable dark: the header, the activity runs, the run's facts
 * and every secondary view (Gantt, Events, Variables, Cost).
 *
 * Each view is measured with its tab open, because `PanelTabs` keeps the
 * others mounted but hidden and a hidden panel draws no text. On every view:
 * all text is on the type ramp, the header's buttons are `--control-h` tall,
 * and nothing scrolls the page sideways.
 *
 * The seeded run has something to show in every view: a variable written and
 * appended (Variables), a CLI exchange with a known zero cost (Cost) and a
 * parameter (the facts list).
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const VIEWS = ['Gantt', 'Events', 'Variables', 'Cost'] as const;

/** Every measurement in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const header = content.querySelector('.run-page .page-header')!;
    const shown = (c: Element) => c.getClientRects().length > 0;
    const root = document.scrollingElement!;
    return {
      headerButtons: [...header.querySelectorAll('button')].filter(shown).map((b) => ({
        name: b.getAttribute('aria-label') || (b.textContent ?? '').trim().slice(0, 20),
        h: Math.round(b.getBoundingClientRect().height),
      })),
      sideways: Math.max(
        root.scrollWidth - root.clientWidth,
        content.scrollWidth - content.clientWidth,
      ),
    };
  });
}

for (const { density, theme } of RUNS) {
  test(`#1594 OR40 S6g — the run page: every view on the ramp, header controls at --control-h, no sideways scroll (${density} ${theme})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, density as Density);

    const created = await page.request.post('/api/connections', {
      data: { name: `S6g echo cli ${density}`, kind: 'agent_cli', config: { command: '/bin/echo' } },
    });
    expect(created.status(), `creating connection: ${await created.text()}`).toBe(201);
    const { id: connectionId } = (await created.json()) as { id: string };
    const doc: SeedDoc = {
      nodes: [
        {
          id: 's',
          type: 'set_variable',
          config: { variable: 'count', value: '5' },
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
        { name: 'count', type: 'number', default: 0 },
        { name: 'rows', type: 'array', default: [] },
      ],
    };
    const { pipelineVersionId } = await seedVersion(page, `S6g run page ${density}`, doc);
    const runId = await fireAndSettle(page, pipelineVersionId, `S6g ${density}`);

    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);
    await expectAppearance(page, theme, density as Density);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Run views' })).toBeVisible();

    const h = CONTROL_H[density as Density];
    const off: Record<string, string[]> = {};
    for (const view of VIEWS) {
      await openRunView(page, view);
      if (view === 'Variables') await expect(page.getByText('count', { exact: true })).toBeVisible();
      if (view === 'Cost') {
        await expect(page.getByRole('region', { name: 'Cost & usage' })).toBeVisible();
      }
      const m = await measure(page);
      expect(m.sideways, `${view}: sideways scroll`).toBe(0);
      expect(m.headerButtons.length, 'header buttons').toBeGreaterThanOrEqual(1);
      for (const b of m.headerButtons) expect(b.h, `${view}: header ${b.name} height`).toBe(h);
      const found = await offRampText(page, density as Density);
      if (found.length > 0) off[view] = found;
    }
    expect(off, 'text off the type ramp, by view').toEqual({});

    await expectQuiet(page, problems);
  });
}
