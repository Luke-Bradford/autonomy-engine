import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { fluentRootReady } from './support/theme';

/**
 * U3 — the secondary pane, its splitter and the command bar.
 *
 * What only a real browser can prove: that the pane's grid TRACK is the width
 * the store says (jsdom resolves no `grid-template-columns` at all, so the unit
 * suite can assert the `--pane-width` custom property but never the layout it
 * drives); that a pointer drag moves it; that the collapsed pane actually
 * reclaims its space rather than merely being invisible; and that any of it
 * survives a reload, which is the only place the persistence round-trip is
 * end-to-end real.
 *
 * Names and paths are hard-coded rather than imported from app source, in the
 * same spirit as `support/theme.ts` and `hub-nav.spec.ts`: a spec observes the
 * shipped contract from outside, and a rename should FAIL here rather than
 * silently follow along.
 */

/** The shell's grid track widths, in px, as the browser resolved them. */
async function shellTracks(page: Page): Promise<number[]> {
  const template = await page.evaluate(
    () => getComputedStyle(document.querySelector('.app-shell')!).gridTemplateColumns,
  );
  return template.split(' ').map(parseFloat);
}

/** Rail, pane, splitter, workspace — the pane's own track is the second. */
async function paneTrack(page: Page): Promise<number> {
  return (await shellTracks(page))[1]!;
}

function pane(page: Page) {
  return page.getByRole('navigation', { name: 'Manage sections' });
}

function paneToggle(page: Page) {
  return page.getByRole('button', { name: /navigation pane/ });
}

async function gotoManage(page: Page) {
  await page.goto('/#/manage/connections');
  await fluentRootReady(page);
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
}

test.describe('U3 secondary pane', () => {
  /**
   * The four-track shell of the spec's diagram. The RAIL assertion is carried
   * over from U2 deliberately: growing the template from two columns to four is
   * exactly the change that could have silently broken it, and an undefined
   * `--pane-width` would make the whole declaration invalid at computed-value
   * time and drop the template to `none`.
   */
  test('lays out as rail | pane | splitter | workspace', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoManage(page);

    const tracks = await shellTracks(page);
    expect(tracks).toHaveLength(4);
    expect(tracks[0]).toBe(48);
    // The store's default width, resolved as a real track.
    expect(tracks[1]).toBe(240);
    expect(tracks[2]).toBe(5);
    expect(tracks[3]).toBeGreaterThan(100);

    // The track is not merely reserved — the pane fills it.
    expect((await pane(page).boundingBox())?.width).toBe(240);
    await expectQuiet(page, problems);
  });

  /**
   * The regression U3 exists to close as much as the pane itself: between U2 and
   * U3 the Triggers page was reachable only by typing its URL. The rail reaches
   * Manage, Manage index-redirects to Connections, and nothing linked on.
   * Asserted by CLICKING all the way there — a link that merely exists in the
   * DOM would satisfy a weaker check without proving the route resolves.
   */
  test('makes the Triggers page reachable by clicking alone', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Manage' })
      .click();
    await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();

    await pane(page).getByRole('link', { name: 'Triggers' }).click();
    await expect(page.getByRole('heading', { name: 'Triggers' })).toBeVisible();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/manage/triggers');
    await expectQuiet(page, problems);
  });

  test('marks the section you are on, on a non-colour channel', async ({ page }) => {
    await gotoManage(page);
    await expect(pane(page).getByRole('link', { name: 'Connections' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(pane(page).getByRole('link', { name: 'Triggers' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  /**
   * The pane clips its overflow (it scrolls), so a focus ring drawn OUTSIDE the
   * border box is sliced off at both edges — the same trap the rail documents.
   * Deliberately NOT `outlineStyle !== 'none'`: Chromium's own default is
   * `outline: auto` at offset 0, so that assertion passes with the rule deleted
   * and proves nothing. Pin the rule actually written.
   */
  test('a keyboard-focused pane link has a visible focus ring', async ({ page }) => {
    await gotoManage(page);
    const link = pane(page).getByRole('link', { name: 'Triggers' });
    await link.focus();

    const ring = await link.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset };
    });
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThan(0);
    // STRICTLY negative: drawn inside the border box, where the clip cannot reach.
    expect(parseFloat(ring.offset)).toBeLessThan(0);
  });
});

test.describe('U3 pane splitter', () => {
  /**
   * The pointer drag, which is the half jsdom cannot run at all: it implements
   * no pointer-capture API, so the unit suite covers only the keyboard path.
   * The assertion is on the resolved TRACK after the drag, not on the store or
   * the custom property — a preview that never commits, or a commit that never
   * reaches the layout, both fail here.
   */
  test('dragging the splitter resizes the pane and it sticks', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoManage(page);
    expect(await paneTrack(page)).toBe(240);

    const box = (await page.getByRole('separator').boundingBox())!;
    // Measured from the grab point, not from `box.x`: the splitter is 5px wide,
    // so grabbing its centre and moving to `box.x + 60` is a 57.5px delta, not
    // 60. The pane would land on 298 and the failure would read as an
    // off-by-something in the app rather than in the test's arithmetic.
    const grabX = box.x + box.width / 2;
    const grabY = box.y + box.height / 2;
    await page.mouse.move(grabX, grabY);
    await page.mouse.down();
    // Two moves, not one: a handler that only read the LAST event would pass
    // either way, but one accumulating per-event deltas instead of measuring
    // from the drag ORIGIN would drift and land at 240 + 30 + 60.
    await page.mouse.move(grabX + 30, grabY);
    await page.mouse.move(grabX + 60, grabY);
    await page.mouse.up();

    await expect.poll(() => paneTrack(page)).toBe(300);
    expect((await pane(page).boundingBox())?.width).toBe(300);
    await expectQuiet(page, problems);
  });

  /** The keyboard path, end to end — the spec's keyboard-operable criterion. */
  test('arrow keys resize the pane, and End jumps to the maximum', async ({ page }) => {
    await gotoManage(page);
    const splitter = page.getByRole('separator');
    await splitter.focus();

    await page.keyboard.press('ArrowRight');
    await expect.poll(() => paneTrack(page)).toBe(256);
    await expect(splitter).toHaveAttribute('aria-valuenow', '256');

    await page.keyboard.press('End');
    await expect.poll(() => paneTrack(page)).toBe(480);

    // ...and does not run past it. A second End is a no-op, not 480 + a step.
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => paneTrack(page)).toBe(480);
  });

  /**
   * A drag must not leave the width behind in memory only. Reload is the honest
   * test: it rebuilds the store from `localStorage` exactly as a new session
   * would.
   */
  test('a resized pane survives a reload', async ({ page }) => {
    await gotoManage(page);
    await page.getByRole('separator').focus();
    await page.keyboard.press('End');
    await expect.poll(() => paneTrack(page)).toBe(480);

    await page.reload();
    await fluentRootReady(page);
    await expect(pane(page)).toBeVisible();
    await expect.poll(() => paneTrack(page)).toBe(480);
  });
});

test.describe('U3 command bar', () => {
  const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

  test('shows the hub trail, with only the current crumb unlinked', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/#/manage/triggers');
    await fluentRootReady(page);

    await expect(trail(page).getByRole('listitem')).toHaveText(['Manage', 'Triggers']);
    await expect(trail(page).getByRole('link')).toHaveText(['Manage']);
    await expect(trail(page).locator('[aria-current="page"]')).toHaveText('Triggers');

    // The linked crumb navigates — a breadcrumb whose links go nowhere is
    // decoration, and `toHaveText` alone cannot tell the difference.
    await trail(page).getByRole('link', { name: 'Manage' }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/manage/connections');
    await expectQuiet(page, problems);
  });

  /**
   * The three-deep trail, whose deepest crumb is the run id — the case that
   * required nesting `:runId` under `runs` so the middle crumb has a real path
   * to link back to.
   */
  test('reads Monitor > Runs > <run id> on a run detail route', async ({ page }) => {
    await page.goto('/#/monitor/runs/run_e2e_u3');
    await fluentRootReady(page);

    await expect(trail(page).getByRole('listitem')).toHaveText(['Monitor', 'Runs', 'run_e2e_u3']);
    await trail(page).getByRole('link', { name: 'Runs' }).click();
    await expect.poll(() => new URL(page.url()).hash).toBe('#/monitor/runs');
  });

  /**
   * Collapse must RECLAIM the space, not just hide the pane. A `hidden` element
   * still occupies its grid track, so "the pane is invisible" would pass while
   * the workspace stayed inset behind 240px of nothing.
   */
  test('collapsing reclaims the pane track, and expanding restores the width', async ({ page }) => {
    const problems = collectPageProblems(page);
    await gotoManage(page);

    const before = (await page.locator('.workspace').boundingBox())!.width;
    await paneToggle(page).click();

    await expect(pane(page)).toBeHidden();
    await expect.poll(() => paneTrack(page)).toBe(0);
    // The splitter goes with it — a resize handle for a pane that is not on
    // screen is a focusable control with nothing to do.
    await expect(page.getByRole('separator')).toHaveCount(0);
    expect((await page.locator('.workspace').boundingBox())!.width).toBeGreaterThan(before);
    await expect(paneToggle(page)).toHaveAttribute('aria-expanded', 'false');

    await paneToggle(page).click();
    await expect(pane(page)).toBeVisible();
    await expect.poll(() => paneTrack(page)).toBe(240);
    await expectQuiet(page, problems);
  });

  test('a collapsed pane stays collapsed across a hub change and a reload', async ({ page }) => {
    await gotoManage(page);
    await paneToggle(page).click();
    await expect.poll(() => paneTrack(page)).toBe(0);

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Monitor' })
      .click();
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect.poll(() => paneTrack(page)).toBe(0);

    await page.reload();
    await fluentRootReady(page);
    await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect.poll(() => paneTrack(page)).toBe(0);
    await expect(paneToggle(page)).toHaveAttribute('aria-expanded', 'false');
  });

  /**
   * Home declares no sections, so it gets no pane AND no toggle — a disclosure
   * button controlling nothing is worse than no button. The track must be zero
   * too, or the Home page sits inset behind an empty column.
   */
  test('Home has no pane, no toggle and no pane track', async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto('/');
    await fluentRootReady(page);
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

    expect(await paneTrack(page)).toBe(0);
    await expect(paneToggle(page)).toHaveCount(0);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(trail(page).getByRole('listitem')).toHaveText(['Home']);
    await expectQuiet(page, problems);
  });

  /**
   * The shell is viewport-height and `.content` is what scrolls, so the command
   * bar, rail and pane stay put on a long page. Before U3 the document itself
   * scrolled — which would carry the command bar off the top of the screen, and
   * is why the rail needed `position: sticky` in the first place.
   */
  test('the command bar stays put while the workspace scrolls', async ({ page }) => {
    // A SHORT viewport, so this page genuinely overflows. Without it the
    // assertions below are vacuous: `.content` would have nothing to scroll, so
    // "the document did not scroll" holds trivially and a layout where the
    // DOCUMENT is the scroller would pass just as well. 200px was measured, not
    // guessed — at 300px the Connections page still fits inside `.content`, and
    // the `overflow > 0` guard below is what keeps that honest if the page's
    // content ever shrinks.
    await page.setViewportSize({ width: 1280, height: 200 });
    await gotoManage(page);

    const barBefore = (await page.locator('.command-bar').boundingBox())!.y;
    const paneBefore = (await pane(page).boundingBox())!.y;

    const scrolled = await page.evaluate(() => {
      const content = document.querySelector('.content')!;
      content.scrollTop = 400;
      return {
        contentScrolled: content.scrollTop,
        overflow: content.scrollHeight - content.clientHeight,
        docScroll: document.documentElement.scrollTop,
        docOverflow: document.documentElement.scrollHeight - window.innerHeight,
      };
    });

    // `.content` is the scroller, and it really did move.
    expect(scrolled.overflow).toBeGreaterThan(0);
    expect(scrolled.contentScrolled).toBeGreaterThan(0);
    // The DOCUMENT is not a scroller at all — that is what keeps the shell
    // chrome on screen rather than carrying it off the top of the page.
    expect(scrolled.docOverflow).toBe(0);
    expect(scrolled.docScroll).toBe(0);

    expect((await page.locator('.command-bar').boundingBox())!.y).toBe(barBefore);
    expect((await pane(page).boundingBox())!.y).toBe(paneBefore);
  });
});
