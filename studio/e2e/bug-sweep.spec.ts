import { expect, test } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { contrastRatio, fluentRootReady, isOpaque, setTheme, surfaceBehind } from './support/theme';
import { openCanvas } from './support/canvas';
import { openRowMenu } from './support/authorPane';
import { fireAndSettle, seedVersion } from './support/seedDoc';

/**
 * Regression net for the browser-observable half of the first bug sweep:
 * #717 (favicon), #721 (one icon-button treatment) and #698 (route-level
 * code-splitting).
 *
 * Each of these is invisible to the unit suites for the same underlying reason:
 * jsdom paints nothing, resolves no cascade, and fetches no subresources. A
 * rule that collapsed a button to zero, a chunk that never loaded, or a missing
 * static file would pass every vitest run in the repo.
 */

/** The three elements that share the `.icon-button` treatment. */
const ICON_BUTTONS = [
  '.command-bar__pane-toggle',
  '.factory-resources__icon-button',
  '.factory-resources__disclosure',
] as const;

test.describe('#717 favicon', () => {
  /**
   * The console guard CANNOT cover this, which is why it is asserted directly.
   * Playwright's browser context does not issue the implicit `/favicon.ico`
   * request a normal browsing session makes, so the 404 this ticket is about
   * never reaches `collectPageProblems` — the guard was honest about app code
   * and blind to this class of resource miss.
   */
  test('serves the declared icon, so no browser falls back to /favicon.ico', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    const href = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(href, 'index.html must declare an icon').toBe('/favicon.svg');

    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
  });
});

test.describe('#721 one icon-button treatment', () => {
  test('the command bar and pane icon buttons agree on the shared treatment', async ({ page }) => {
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();
    await fluentRootReady(page);

    const measured = await page.evaluate(
      (selectors) => {
        return selectors.map((sel) => {
          const el = document.querySelector(sel);
          if (el === null) return { sel, missing: true };
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          return {
            sel,
            missing: false,
            radius: cs.borderRadius,
            borderStyle: cs.borderTopStyle,
            display: cs.display,
            // A box of zero would mean the shared reset ate a call site's size —
            // the specific regression a source-order mistake would cause, since
            // every rule involved is a single class and ties break on order.
            width: Math.round(box.width),
            height: Math.round(box.height),
          };
        });
      },
      ICON_BUTTONS as unknown as string[],
    );

    for (const m of measured) {
      expect(m.missing, `${m.sel} should be present on this page`).toBe(false);
      expect(m.radius, `${m.sel} radius`).toBe('4px');
      expect(m.borderStyle, `${m.sel} border`).toBe('none');
      expect(m.display, `${m.sel} display`).toBe('flex');
      expect(m.width, `${m.sel} width`).toBeGreaterThan(0);
      expect(m.height, `${m.sel} height`).toBeGreaterThan(0);
    }
  });

  test('a keyboard-focused icon button has a visible focus ring', async ({ page }) => {
    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();

    const toggle = page.getByRole('button', { name: /navigation pane/i });
    await toggle.focus();

    const ring = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.outlineWidth, style: cs.outlineStyle, offset: cs.outlineOffset };
    });
    expect(ring.style).toBe('solid');
    expect(parseFloat(ring.width)).toBeGreaterThan(0);
    // Drawn INSIDE the box: the command bar and pane clip their overflow, so a
    // ring at a positive offset is sliced off at both edges.
    expect(parseFloat(ring.offset)).toBeLessThan(0);
  });
});

test.describe('#698 route-level code-splitting', () => {
  /**
   * The canvas route is `React.lazy`, so its chunk is fetched on navigation.
   * The failure this guards against is not "slower" but "blank": a broken
   * dynamic import, or a `<Suspense>` boundary placed above the shell, leaves
   * the workspace empty with nothing thrown.
   */
  test('the lazy canvas route mounts, with the shell still painted around it', async ({ page }) => {
    const problems = collectPageProblems(page);

    await page.goto('/#/author/pipelines');
    await page.getByRole('heading', { name: 'Pipelines' }).waitFor();

    // Author a pipeline through the page so the route has a real id to open.
    const name = `sweep-canvas-${Date.now()}`;
    await page.getByRole('textbox', { name: 'Name' }).fill(name);
    await page.getByRole('button', { name: 'Create pipeline' }).click();
    await page.getByRole('link', { name: `Open ${name}`, exact: true }).click();

    // The lazily-loaded canvas actually arrives.
    await expect(page.locator('.react-flow')).toBeVisible();

    // ...and the chrome outside `<main>` never suspended with it.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: /navigation pane/i })).toBeVisible();

    await expectQuiet(page, problems);
  });
});

/**
 * ── Bug sweep 3 ──────────────────────────────────────────────────────────────
 *
 * The browser-observable half of #483 and #720. Both are invisible to vitest for
 * the usual reason (jsdom resolves no cascade and has no address bar), and #720
 * additionally needs TWO views of the same pipeline mounted at once, which is
 * only true in the real shell.
 */

test.describe('#483 held/parked node pills', () => {
  /**
   * Asserts the STYLESHEET contract, not a live run: reaching a real
   * `retry_pending` node from the browser needs a transient failure and a
   * wall-clock hold, which belongs in a server test, not here.
   *
   * THE ASSERTION THAT MATTERS is that each pill resolves to the token it is
   * SUPPOSED to paint. An earlier cut of this spec only asserted "opaque, ≥4.5:1,
   * and the two differ", and it passed with the retry pill's rule DELETED —
   * `color` is an inherited property, so an unmatched class quietly computes to
   * the body's `--text` (15.4:1, and a different string from `--muted`), and all
   * three assertions held. Verified by deleting the rule and watching it stay
   * green. Comparing against the resolved token is what makes a missing rule, a
   * typo'd class, or a missing light override fail.
   */
  /* U25 renamed these to the ENGINE's vocabulary (the Monitor no longer keeps a
     five-word enum of its own) and split the single `waiting` pill into the
     three parks the engine distinguishes. Every member of the widened set is
     listed, not just the two #483 introduced: `pending`/`ready`/`skipped` had
     no pill at all until the table began reading the doc-aware projection, and
     an unmatched class is precisely the silent failure this fixture exists to
     catch. `nodeStatus.test.ts` pins that no status is missing from the CODE;
     this pins that none is missing from the STYLESHEET, in both themes. */
  const PILLS = [
    { cls: 'node-status-retry_pending', token: '--warning' },
    { cls: 'node-status-waiting', token: '--muted' },
    { cls: 'node-status-wait_pending', token: '--muted' },
    { cls: 'node-status-external_wait_pending', token: '--muted' },
    { cls: 'node-status-pending', token: '--muted' },
    { cls: 'node-status-ready', token: '--muted' },
    { cls: 'node-status-skipped', token: '--muted' },
  ] as const;

  /**
   * A real run, seeded ONLY so the spec can find the surfaces a pill is
   * actually painted on. Which status the run produces does not matter — a
   * surface is geometry, not colour — so this is the cheapest doc that settles
   * without egress. The seven statuses the COLOUR half covers stay synthetic,
   * for the reason the docblock above gives.
   */
  const SURFACE_DOC = {
    nodes: [{ id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } }],
    edges: [],
  };

  /**
   * The probe host stays on `document.body`, OUTSIDE the FluentProvider root,
   * and that is sound for what it measures. A pill's `color` is
   * `var(--muted)` / `var(--warning)`, resolved from the custom properties
   * `:root[data-theme]` declares — so it is the same colour wherever in the
   * document the probe hangs, and mounting it inside the React tree to make it
   * "more realistic" would buy nothing while breaking the rule
   * `resolvedPaletteColor`'s docblock states (React reconciles its own
   * children; a foreign node among them is a hazard for no gain).
   *
   * What the position CANNOT tell you is the surface, and that is exactly the
   * #1027 defect: this host is a child of `body`, so a walk up from it finds
   * `body` and reports it as the backdrop — a surface no real pill sits on.
   * The surfaces are therefore taken from REAL pills, separately, below.
   */
  async function pillColours(page: import('@playwright/test').Page) {
    return page.evaluate((pills) => {
      const host = document.createElement('div');
      document.body.append(host);
      try {
        return pills.map(({ cls, token }) => {
          const el = document.createElement('span');
          el.className = `node-status ${cls}`;
          host.append(el);
          const cs = getComputedStyle(el);
          // Resolve the EXPECTED token through the same engine, on a probe that
          // is styled ONLY by it — so both sides are computed values and the
          // comparison is hex-vs-rgb-serialization proof.
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          host.append(probe);
          return {
            cls,
            token,
            color: cs.color,
            borderColor: cs.borderColor,
            expected: getComputedStyle(probe).color,
          };
        });
      } finally {
        host.remove();
      }
    }, PILLS);
  }

  for (const theme of ['dark', 'light'] as const) {
    test(`both pills paint their own token in ${theme} mode`, async ({ page }) => {
      const problems = collectPageProblems(page);

      const { pipelineVersionId } = await seedVersion(page, `#483 pill surface ${theme}`, {
        ...SURFACE_DOC,
      });
      const runId = await fireAndSettle(page, pipelineVersionId, '#483 sweep');
      await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
      await fluentRootReady(page);
      /* THROUGH THE TOGGLE, not by writing `data-theme`. That write drives only
         the MVP palette; the FluentProvider's theme is a React prop no DOM write
         can move, so the old "light mode" run measured a light palette against a
         Fluent root still painting `rgb(41, 41, 41)`. It read green only because
         the SURFACE it measured was `body`, which the same write DID move — two
         errors that cancelled, and fixing either one alone turns this red. */
      await setTheme(page, theme);

      /* The pills render on TWO surfaces, and both are asserted because a
         regression in either is a real one. In the Nodes table nothing between
         the pill and the FluentProvider root paints, so the Fluent token is the
         backdrop; in the drill-in panel `.property-panel` paints `--panel` over
         it. Found by walking up from a REAL pill in each, never named — the
         answer for the table is not a colour this app's palette contains at
         all, which is precisely why naming it was wrong. */
      await page.locator('table .node-status').first().waitFor();
      const tableSurface = await surfaceBehind(page, 'table .node-status');
      await page
        .locator('tr', { has: page.locator('td code', { hasText: /^hold$/ }) })
        .locator('button.node-drill-in')
        .click();
      /* Keyed on the panel's CLASS, not `[role="complementary"]`: the panel is
         an `<aside>`, whose `complementary` role is IMPLICIT, so no `role`
         attribute exists for a CSS selector to match. `getByRole` computes the
         ARIA role and finds it; `surfaceBehind` takes a CSS selector and cannot.
         The pill also mounts asynchronously, so without the wait the walk races
         it and reports "no element matched" — which reads like a markup change
         rather than a timing one. */
      await page.locator('.node-detail-panel .node-status').first().waitFor();
      const panelSurface = await surfaceBehind(page, '.node-detail-panel .node-status');
      /* Deduped by colour: in LIGHT mode `--panel` is `#ffffff` and so is
         Fluent's `colorNeutralBackground1`, so the two walks legitimately land
         on the same value and asserting it twice would say nothing new. */
      const surfaces = [tableSurface, panelSurface].filter(
        (s, i, all) => all.findIndex((o) => o.color === s.color) === i,
      );

      const measured = await pillColours(page);
      for (const { cls, token, color, borderColor, expected } of measured) {
        // 1. The rule MATCHED and painted the intended token. Fails outright if
        //    the rule is missing (the class then inherits `--text`).
        expect(color, `${cls} does not paint var(${token}) in ${theme}`).toBe(expected);
        // 2. Every sibling pill colours its ring to match; the parked pill was
        //    the one that did not until this sweep, and it became reachable for
        //    the first time in #483.
        expect(borderColor, `${cls} ring does not match its text colour`).toBe(expected);
        expect(isOpaque(color), `${cls} paints a transparent colour`).toBe(true);
        // 3. The pills are 0.72rem — small text, so WCAG AA asks 4.5:1, on
        //    every surface the pill actually appears on. This is what catches a
        //    light override that is merely a DIFFERENT wrong hue rather than an
        //    absent one. No "the surface is opaque" assertion: `surfaceBehind`
        //    picks the first OPAQUE ancestor by construction and throws naming
        //    the chain if there is none, so the old check could not fail.
        for (const s of surfaces) {
          expect(
            contrastRatio(color, s.color),
            `${cls} is below AA for small text in ${theme}: ${color} on ${s.color} (${s.from})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }

      // ...and the two states are visually TELLABLE APART, which is the whole
      // point of #483: a held node must not read like a routine park.
      const [retrying, waiting] = measured;
      expect(retrying!.color).not.toBe(waiting!.color);

      await expectQuiet(page, problems);
    });
  }
});

test.describe('#720 the open canvas follows a rename', () => {
  /**
   * Needs the real shell: the pane and the canvas are mounted SIMULTANEOUSLY
   * over the same pipeline, and the defect was that only one of them heard the
   * rename. A unit test can drive the store directly (and does), but only this
   * proves the two live views actually agree in the shipped app.
   */
  test('renaming in the tree updates the heading of the canvas already open', async ({ page }) => {
    const problems = collectPageProblems(page);

    // Deliberately free of the substring "name": the suite shares one SQLite
    // file, and a pipeline called "…rename…" is matched by any substring locator
    // a LATER spec aims at the create form. `openCanvas` was hardened for that,
    // but not seeding the trap is the cheaper half of the fix.
    const before = `sweep3-retitle-a-${Date.now()}`;
    const after = `sweep3-retitle-b-${Date.now()}`;

    await openCanvas(page, before);

    // The canvas is open, on its own route, showing the ORIGINAL name.
    await expect(page.getByRole('heading', { name: before })).toBeVisible();

    await openRowMenu(page, before);
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Pipeline name' });
    await expect(field).toHaveValue(before);
    await field.fill(after);
    await page.getByRole('button', { name: 'Rename', exact: true }).click();

    // Before the fix this heading kept the OLD name until a full reload.
    await expect(page.getByRole('heading', { name: after })).toBeVisible();
    await expect(page.getByRole('heading', { name: before })).toHaveCount(0);
    // The canvas did not navigate away or remount onto a different pipeline.
    await expect(page.locator('.react-flow')).toBeVisible();

    await expectQuiet(page, problems);
  });
});

/**
 * ── Bug sweep 4 ──────────────────────────────────────────────────────────────
 *
 * #1008 — the run page's two "why is there no span" classifiers agreed on a
 * routed-around node.
 *
 * Invisible to vitest for a DIFFERENT reason from the sweeps above: not the
 * cascade, but the mock. The panel's unit test stubs `useRunStream`, so it can
 * prove the panel renders the right sentence for a node it is TOLD is skipped,
 * and cannot prove the engine calls that node skipped in the first place.
 *
 * `hold` is a one-second `wait` that SUCCEEDS, and the only edge out of it is a
 * `failure` edge — so `stop` is routed around and the engine appends no event
 * for it at all. That leaves `attempts === 0`, which is also what a node that
 * has genuinely not started yet looks like; the panel used to read the count
 * and say "has not started", while the timeline read the status and said
 * "skipped". One page, one fact, two descriptions.
 *
 * The end-to-end half is the point. `RunDetailPage.test.tsx` mocks
 * `useRunStream`, so it pins the panel's arm against a status the test itself
 * supplies. Only a real run proves the reducer actually settles this node as
 * `skipped` — if it ever produced something else, the unit test would stay
 * green and the operator would be back to reading the wrong sentence.
 */
const ROUTED_AROUND_DOC = {
  nodes: [
    { id: 'hold', type: 'wait', config: { seconds: '${1}' }, position: { x: 0, y: 0 } },
    { id: 'stop', type: 'fail', config: { message: 'unreachable' }, position: { x: 260, y: 0 } },
  ],
  // `hold` succeeds, so this edge is never taken and `stop` is skipped.
  edges: [{ from: 'hold', to: 'stop', on: 'failure' as const }],
};

test.describe('#1008 the skipped node', () => {
  test('the panel and the timeline agree that a routed-around node was skipped', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);

    const { pipelineVersionId } = await seedVersion(page, '#1008 routed around', ROUTED_AROUND_DOC);
    const runId = await fireAndSettle(page, pipelineVersionId, '#1008 sweep');

    await page.goto(`/#/monitor/runs/${encodeURIComponent(runId)}`);
    await fluentRootReady(page);

    /* Keyed on the raw node id in the row's `<code>`, not the activity's display
       name: #882 numbers names by kind, so keying on one would make this spec
       fail on labelling work it is not about (`node-duration.spec.ts`'s rule). */
    const stopRow = page.locator('tr', { has: page.locator('td code', { hasText: /^stop$/ }) });
    await stopRow.locator('button.node-drill-in').click();

    const panel = page.getByRole('complementary');
    await expect(panel).toContainText('routed around, so it was never going to run');
    /* The defect itself, asserted as the ABSENCE that has to hold. Without it
       the spec would pass on a panel that printed both sentences. */
    await expect(panel).not.toContainText('has not started');

    /* The other surface, on the same page, describing the same node — this is
       the agreement the ticket is about, so asserting only one side would miss
       a fix that moved the disagreement rather than removing it. */
    const untimed = page.locator('.timeline-untimed li', { hasText: 'skipped' });
    await expect(untimed).toHaveCount(1);
    await expect(untimed).toContainText('the engine appends no event for a node it routes around');

    await expectQuiet(page, problems);
  });
});
