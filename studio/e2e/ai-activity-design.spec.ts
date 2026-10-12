import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';
import { CONTROL_H, DENSITIES, expectAppearance, preferAppearance } from './support/appearance';
import { expectInlineRow } from './support/inlineRow';
import { offRampText } from './support/typeRamp';
import { allCapsText } from './support/allCaps';
import { seriesSnapshot, stubActivity } from './support/aiActivity';

/**
 * #1594 OR40 S6r — Monitor › AI activity on the design system, at 1440x900 in
 * compact light and comfortable dark.
 *
 * The header: no prose under the title, which says what the page holds through
 * its `?` ("About AI activity"), and the window picker and the "as of" line in
 * its toolbar. The window's figures are a facts list, not KPI tiles. Every piece
 * of text is on the type ramp and none is ALL CAPS (the quota's "UNREADABLE"
 * was), with the page as full as it gets: the chart, the model table, agent CLI
 * work, an external reporter whose table is cut, an unreadable Claude quota
 * with an out-of-date last-known reading beneath it and an unreadable Codex one.
 *
 * Both endpoints are stubbed: CI's database has no metered events and its quota
 * endpoint has no credential, so the real page is the empty one.
 */

type Density = (typeof DENSITIES)[number];

const RUNS = [
  { density: 'compact', theme: 'light' },
  { density: 'comfortable', theme: 'dark' },
] as const;

const NOW_S = Math.floor(Date.now() / 1000);
const RESETS_AT_SECONDS = Math.floor(Date.UTC(2099, 0, 1) / 1000);

function fullSnapshot() {
  const base = seriesSnapshot();
  return {
    ...base,
    agentCli: { invocations: 2, completed: 1, notCompleted: 1, lastAt: 1_785_999_000_000 },
    external: {
      ...base.external,
      invocations: 3,
      completed: 3,
      lastAt: 1_785_999_000_000,
      truncated: true,
      reporters: [
        {
          source: 'studio-build-loop',
          agent: 'claude',
          model: 'claude-opus-5',
          invocations: 3,
          completed: 3,
          notCompleted: 0,
          unknown: 0,
          inFlight: 0,
          lastAt: 1_785_999_000_000,
          tokens: {
            inputTokens: 12,
            outputTokens: 34,
            cacheReadTokens: 56,
            cacheCreationTokens: 78,
            measuredInvocations: 3,
          },
        },
      ],
    },
  };
}

const QUOTA = {
  generated_at: NOW_S,
  account: { claude: null, codex: null },
  unavailable: { claude: 'rate_limited', codex: 'no_reading' },
  last_known: {
    claude: {
      five_hour: { utilization: 0.31, resets_at: RESETS_AT_SECONDS },
      seven_day: { utilization: 0.58, resets_at: RESETS_AT_SECONDS },
    },
    // Older than two cache lifetimes, so the "out of date" sentence shows.
    read_at: NOW_S - 3600,
  },
};

/** Every measurement in ONE evaluate. */
function measure(page: Page) {
  return page.evaluate(() => {
    const content = document.querySelector('.content')!;
    const header = content.querySelector('.page-header')!;
    const headRect = header.getBoundingClientRect();
    const box = (c: Element) => {
      const r = c.getBoundingClientRect();
      return {
        name:
          c.getAttribute('aria-label') || (c.textContent ?? '').trim().slice(0, 20) || c.tagName,
        left: r.left,
        right: r.right,
        centre: r.top + r.height / 2,
        h: Math.round(r.height),
      };
    };
    const h1 = header.querySelector('h1')!;
    const help = header.querySelector(':scope > details > summary');
    const note = header.querySelector<HTMLElement>(':scope > details[open] > [role=note]');
    const noteRect = note?.getBoundingClientRect();
    const facts = content.querySelector('dl.ai-activity-facts');
    const root = document.scrollingElement!;
    return {
      prose: [...content.querySelectorAll('.page-hint')].filter(
        (el) => !el.closest('.section, form'),
      ).length,
      helpName: help?.getAttribute('aria-label') ?? null,
      title: [box(h1), ...(help ? [{ ...box(help), name: '?' }] : [])],
      headerControls: [...header.querySelectorAll('.toolbar select, .toolbar button')]
        .filter((c) => c.getClientRects().length > 0)
        .map(box),
      toolbarText: (header.querySelector('.toolbar')?.textContent ?? '').trim(),
      tiles: content.querySelectorAll('.monitor-tiles').length,
      facts: facts
        ? [...facts.querySelectorAll(':scope > dt')].map((dt) => (dt.textContent ?? '').trim())
        : null,
      // No fact is a box: a tile is a bordered card around a term and its value.
      boxedFacts: facts
        ? [...facts.querySelectorAll(':scope > *')].filter(
            (el) => getComputedStyle(el).borderTopStyle !== 'none',
          ).length
        : null,
      note:
        noteRect === undefined
          ? null
          : {
              leftOffset: Math.round(noteRect.left - headRect.left),
              belowRow: Math.round(noteRect.top - headRect.bottom),
              inViewport: noteRect.left >= 0 && noteRect.right <= window.innerWidth,
            },
      sideways: Math.max(
        root.scrollWidth - root.clientWidth,
        content.scrollWidth - content.clientWidth,
      ),
    };
  });
}

for (const { density, theme } of RUNS) {
  test(`#1594 OR40 S6r — AI activity: the title's ?, facts not tiles, on the ramp, no capitals (${density} ${theme})`, async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await preferAppearance(page, theme, density as Density);
    await stubActivity(page, fullSnapshot());
    await page.route('**/api/quota/display', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(QUOTA) }),
    );

    await page.goto('/#/monitor/ai');
    await fluentRootReady(page);
    await expectAppearance(page, theme, density as Density);
    const region = page.getByRole('region', { name: 'AI activity', exact: true });
    await expect(region.getByRole('heading', { level: 1, name: 'AI activity' })).toBeVisible();
    // Everything the page can draw is on it before it is measured.
    await expect(page.locator('.token-flow')).toBeVisible();
    await expect(page.getByText(/2 agent CLI subprocesses/)).toBeVisible();
    await expect(
      page.getByText('Showing the busiest reporters only', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('Codex quota unreadable.')).toBeVisible();
    await expect(page.getByText('treat it as out of date', { exact: false })).toBeVisible();

    const h = CONTROL_H[density as Density];
    const closed = await measure(page);
    expect(closed).toMatchObject({
      prose: 0,
      helpName: 'About AI activity',
      note: null,
      tiles: 0,
      boxedFacts: 0,
      sideways: 0,
    });
    expect(closed.facts).toEqual([
      'Runs executing',
      'Pending',
      'Queued',
      'Waiting',
      'Billed exchanges',
      'Tokens',
      'Spend',
      'Agent CLI',
    ]);
    expect(closed.toolbarText).toMatch(/Activity as of/);
    expectInlineRow('AI activity title', closed.title);
    expect(closed.headerControls.length).toBeGreaterThanOrEqual(1);
    for (const c of closed.headerControls) expect(c.h, `header ${c.name} height`).toBe(h);
    expect(await offRampText(page, density as Density), '? closed').toEqual([]);
    expect(await allCapsText(page), 'ALL CAPS').toEqual([]);

    // The note is the page's description, and it opens under the header row.
    const note = page.locator('.page-header [role=note]');
    const said = ((await note.textContent()) ?? '').trim();
    expect(said).not.toBe('');
    await expect(region).toHaveAccessibleDescription(said);
    await page.locator('.page-header > details > summary').click();
    await expect(note).toBeVisible();
    const open = await measure(page);
    expect(open.note).toEqual({ leftOffset: 0, belowRow: 4, inViewport: true });
    expect(open.sideways).toBe(0);
    expect(await offRampText(page, density as Density), '? open').toEqual([]);
    expect(await allCapsText(page), 'ALL CAPS, ? open').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(note).toBeHidden();

    await expectQuiet(page, problems);
  });
}
