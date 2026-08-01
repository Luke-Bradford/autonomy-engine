import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';

/**
 * U7 — authoring an activity's settings through NAMED controls.
 *
 * Until this ticket the node panel offered exactly one control for every
 * activity in the catalog: a raw "Config (JSON)" textarea. The canvas could
 * place an `http_request`, bind it to a connection, wire its edges and put it in
 * a container — and then the operator had to already know that its settings are
 * `{"url": …, "method": …}`, with nothing on screen saying so.
 *
 * The unit suites pin the derivation rules and the apply semantics. What only an
 * e2e can prove is the property the whole ticket is about: that a value typed
 * into a control the SCHEMA produced reaches the server, survives an immutable
 * version mint, and comes back on reload — and, just as importantly, that
 * applying through the form does not DROP the parts of the config no control
 * owns. That second half is a round-trip through the write gate; no jsdom test
 * can see it, and a regression there is silent data loss.
 */

/**
 * NOTE on the queries below: a config control is reached by ROLE, not by label.
 * U8a's expression-picker toggle sits beside each text field and carries that
 * field's name in its accessible name ("Insert reference into url"), so a
 * `getByLabel('url')` now matches the textarea AND the button. Naming the role
 * is the precise question this spec was always asking.
 */
function panel(page: Page) {
  return page.getByRole('complementary', { name: 'Properties' });
}

/** The stored config of the seeded node, read back from the LATEST version. */
async function persistedConfig(page: Page, pipelineId: string): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/pipelines/${encodeURIComponent(pipelineId)}/versions`);
  expect(res.status()).toBe(200);
  const items = (await res.json()) as {
    version: number;
    nodes: { id: string; config: Record<string, unknown> }[];
  }[];
  const latest = items.reduce((a, b) => (a.version > b.version ? a : b));
  const node = latest.nodes.find((n) => n.id === 'a');
  expect(node, 'the seeded node survived the save').toBeTruthy();
  return node!.config;
}

test.describe('U7 — per-activity node config form', () => {
  test('a setting typed into a derived control SURVIVES a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u7 round trip', {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
    });

    await canvasNodes(page).first().click();

    // The hole this ticket closes: the settings are NAMED on screen. `url` and
    // `method` are not strings this spec invented — they are the keys of
    // `http_request`'s own `configSchema`, so a control per key is the assertion.
    await expect(panel(page).getByRole('textbox', { name: 'url' })).toBeVisible();
    await expect(panel(page).getByRole('textbox', { name: 'method (optional)' })).toBeVisible();
    // And the blob editor an author used to have to understand is not the
    // default surface any more.
    await expect(panel(page).getByLabel('Config (JSON)')).toHaveCount(0);

    await panel(page).getByRole('textbox', { name: 'url' }).fill('https://example.test/hook');
    await panel(page).getByRole('textbox', { name: 'method (optional)' }).fill('POST');
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the latest version from the server, so
    // what renders is what was PERSISTED, not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await canvasNodes(page).first().click();

    await expect(panel(page).getByRole('textbox', { name: 'url' })).toHaveValue('https://example.test/hook');
    await expect(panel(page).getByRole('textbox', { name: 'method (optional)' })).toHaveValue('POST');
    expect(await persistedConfig(page, id)).toMatchObject({
      url: 'https://example.test/hook',
      method: 'POST',
    });

    await expectQuiet(page, problems);
  });

  test('applying the form does NOT drop the outputs contract it cannot see', async ({ page }) => {
    // The data-integrity half, and the reason the apply path merges over the
    // original config instead of storing a parse result. `config.outputs` is the
    // F13 contract — no activity's `configSchema` declares it, so no derived
    // control owns it, and a `z.object` parse would strip it on the way through.
    // Losing it here would silently break every `${nodes.a.output.…}` reference
    // downstream, and the author's only clue would be a run that stopped
    // resolving.
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u7 preserve outputs', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: {
            url: 'https://before',
            outputs: [{ name: 'status', type: 'number' }],
            // A SECOND undeclared key, and not an incidental one. With only
            // `outputs` here this spec passed against a version of the panel that
            // re-attached that one key by hand — it certified the old special case
            // while its name claimed the general rule. `legacyExtra` stands for
            // what an API-authored or git-imported doc can carry that this build's
            // catalog does not know, and nothing preserves it except the rule.
            legacyExtra: { keep: true },
          },
        },
      ],
    });

    await canvasNodes(page).first().click();
    await panel(page).getByRole('textbox', { name: 'url' }).fill('https://after');
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    expect(await persistedConfig(page, id)).toEqual({
      url: 'https://after',
      outputs: [{ name: 'status', type: 'number' }],
      legacyExtra: { keep: true },
    });

    await expectQuiet(page, problems);
  });

  test('a config the form cannot show falls back to the JSON editor, not to corruption', async ({
    page,
  }) => {
    // The kind comes from the SCHEMA, the value from the DOC. `http_request`'s
    // `config` is a `z.record(z.string(), z.unknown())` at the doc level, so the
    // write gate accepts a `url` that is not a string — which is exactly what an
    // API-authored or imported doc can arrive holding. Rendering that object into
    // a text box would apply back as "[object Object]": a corruption caused by
    // OPENING the panel, with no edit at all.
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u7 unrenderable', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { url: { authored: 'elsewhere' } },
        },
      ],
    });

    await canvasNodes(page).first().click();

    await expect(panel(page).getByLabel('Config (JSON)')).toBeVisible();
    // EXACT: the fallback textarea is wrapped by its own <label>, whose text
    // content includes the JSON being edited — which here literally contains the
    // word "url". A substring match would resolve to the escape hatch itself and
    // pass for the wrong reason.
    await expect(panel(page).getByRole('textbox', { name: 'url', exact: true })).toHaveCount(0);
    await expect(
      panel(page).getByText(/Saved settings this form cannot show \(url\)/),
    ).toBeVisible();

    await expectQuiet(page, problems);
  });
});
