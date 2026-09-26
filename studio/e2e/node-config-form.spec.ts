import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes } from './support/canvasGraph';
import { openSeededCanvas } from './support/seedDoc';
import { seedConnection } from './support/seedResources';

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
 * is the precise question this spec was always asking. (A second, separate
 * trap — the label reading the field's VALUE — is closed at source by #1227 and
 * pinned by the exact-label test below.)
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

    await expect(panel(page).getByRole('textbox', { name: 'url' })).toHaveValue(
      'https://example.test/hook',
    );
    await expect(panel(page).getByRole('textbox', { name: 'method (optional)' })).toHaveValue(
      'POST',
    );
    expect(await persistedConfig(page, id)).toMatchObject({
      url: 'https://example.test/hook',
      method: 'POST',
    });

    await expectQuiet(page, problems);
  });

  // #1227 — the trap: a label that WRAPS its textarea reads the textarea's
  // VALUE as part of its own text, so an exact `getByLabel` resolved while the
  // field was empty and silently stopped matching once it held anything (the
  // spec then died on a bare 30s "waiting for" timeout). Only a spec that
  // touches a field TWICE meets it, which is this one's whole shape.
  test('a filled field is still found by its exact label', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u7 label after fill', {
      nodes: [{ id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} }],
    });
    await canvasNodes(page).first().click();

    const url = panel(page).getByLabel('url', { exact: true });
    await expect(url).toHaveValue('');
    await url.fill('https://example.test/label');
    await expect(url).toHaveValue('https://example.test/label', { timeout: 3_000 });
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

  test('switching to JSON carries an unapplied field edit, and that edit is what saves', async ({
    page,
  }) => {
    // #1088 — the node panel's mode toggle is the shared one the connection and
    // dataset forms use. Before, it flipped a flag: the JSON editor opened on
    // the STORED config, so an edit typed into a control a moment earlier was
    // absent from it and an Apply there silently dropped it.
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u7 toggle carries draft', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { url: 'https://before' },
        },
      ],
    });

    await canvasNodes(page).first().click();
    await panel(page).getByRole('textbox', { name: 'url' }).fill('https://typed-in-a-field');
    await panel(page).getByRole('button', { name: 'Edit as JSON' }).click();

    const json = panel(page).getByLabel('Config (JSON)');
    await expect(json).toHaveValue(/https:\/\/typed-in-a-field/);
    // The toggle names the mode it goes TO, and it is reachable in the new mode.
    await expect(panel(page).getByRole('button', { name: 'Edit as fields' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedConfig(page, id)).toMatchObject({ url: 'https://typed-in-a-field' });

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

  // #852 item 2 — a record of headers is authored as ROWS, and a secret header
  // as a secret NAME that saves as the strict `{"$secret": name}` marker.
  test('headers and secret headers are rows that survive a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u7 header rows', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { url: 'https://example.test', headers: { 'X-Keep': '1' } },
        },
      ],
    });

    await canvasNodes(page).first().click();
    const p = panel(page);
    // No JSON blob for either record: a row group per field.
    await expect(p.getByRole('group', { name: 'headers (optional)', exact: true })).toBeVisible();
    await expect(
      p.getByRole('group', { name: 'secretHeaders (optional)', exact: true }),
    ).toBeVisible();
    await expect(p.getByRole('textbox', { name: 'headers row 1 key', exact: true })).toHaveValue(
      'X-Keep',
    );

    await p.getByRole('button', { name: 'Add headers row', exact: true }).click();
    await p.getByRole('textbox', { name: 'headers row 2 key', exact: true }).fill('X-Trace');
    await p.getByRole('textbox', { name: 'headers row 2 value', exact: true }).fill('${run.runId}');
    await p.getByRole('button', { name: 'Add secretHeaders row', exact: true }).click();
    await p
      .getByRole('textbox', { name: 'secretHeaders row 1 key', exact: true })
      .fill('Authorization');
    await p
      .getByRole('textbox', { name: 'secretHeaders row 1 secret name', exact: true })
      .fill('api-token');
    // The value cell takes a reference; the key and secret-name cells do not.
    await expect(
      p.getByRole('button', { name: 'Insert reference into headers row 2 value', exact: true }),
    ).toBeVisible();
    await expect(
      p.getByRole('button', {
        name: 'Insert reference into secretHeaders row 1 secret name',
        exact: true,
      }),
    ).toHaveCount(0);
    await p.getByRole('button', { name: 'Apply config', exact: true }).click();

    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // Exact on the two records: a marker with any extra key would be refused.
    const saved = await persistedConfig(page, id);
    expect(saved.url).toBe('https://example.test');
    expect(saved.headers).toEqual({ 'X-Keep': '1', 'X-Trace': '${run.runId}' });
    expect(saved.secretHeaders).toEqual({ Authorization: { $secret: 'api-token' } });

    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await canvasNodes(page).first().click();
    await expect(p.getByRole('textbox', { name: 'headers row 2 value', exact: true })).toHaveValue(
      '${run.runId}',
    );
    await expect(
      p.getByRole('textbox', { name: 'secretHeaders row 1 secret name', exact: true }),
    ).toHaveValue('api-token');

    await expectQuiet(page, problems);
  });
  // #852 item 3 — an llm_call's conversation is authored as ROWS of role and
  // content, where it used to be one JSON blob.
  test('llm_call messages are rows that survive a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const connectionId = await seedConnection(page, {
      name: `e2e 852 messages ${Date.now()}`,
      kind: 'ollama',
      config: {},
    });
    const id = await openSeededCanvas(page, 'u7 message rows', {
      nodes: [
        {
          id: 'a',
          type: 'llm_call',
          position: { x: 0, y: 0 },
          connectionId,
          config: { messages: [{ role: 'user', content: 'Summarise this.' }] },
        },
      ],
    });

    await canvasNodes(page).first().click();
    const p = panel(page);
    await expect(p.getByRole('group', { name: 'messages (optional)', exact: true })).toBeVisible();
    await expect(p.getByRole('combobox', { name: 'messages row 1 role', exact: true })).toHaveValue(
      'user',
    );
    await expect(
      p.getByRole('textbox', { name: 'messages row 1 content', exact: true }),
    ).toHaveValue('Summarise this.');

    await p.getByRole('button', { name: 'Add messages row', exact: true }).click();
    await p
      .getByRole('combobox', { name: 'messages row 2 role', exact: true })
      .selectOption('assistant');
    await p
      .getByRole('textbox', { name: 'messages row 2 content', exact: true })
      .fill('Earlier answer for ${run.runId}:\nnone.');
    // Content takes a reference, like the prompt it replaces.
    await expect(
      p.getByRole('button', { name: 'Insert reference into messages row 2 content', exact: true }),
    ).toBeVisible();
    await p.getByRole('button', { name: 'Apply config', exact: true }).click();

    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // Exact: a row control that wrote any extra key, or reordered, fails here.
    const saved = await persistedConfig(page, id);
    expect(saved.messages).toEqual([
      { role: 'user', content: 'Summarise this.' },
      { role: 'assistant', content: 'Earlier answer for ${run.runId}:\nnone.' },
    ]);

    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await canvasNodes(page).first().click();
    await expect(p.getByRole('combobox', { name: 'messages row 2 role', exact: true })).toHaveValue(
      'assistant',
    );

    await expectQuiet(page, problems);
  });

  test('a moved message row saves in its new place (#1347)', async ({ page }) => {
    const problems = collectPageProblems(page);
    const connectionId = await seedConnection(page, {
      name: `e2e 1347 message order ${Date.now()}`,
      kind: 'ollama',
      config: {},
    });
    const id = await openSeededCanvas(page, 'u7 message order', {
      nodes: [
        {
          id: 'a',
          type: 'llm_call',
          position: { x: 0, y: 0 },
          connectionId,
          config: {
            messages: [
              { role: 'user', content: 'Summarise this.' },
              { role: 'system', content: 'Be brief.' },
            ],
          },
        },
      ],
    });

    await canvasNodes(page).first().click();
    const p = panel(page);
    await expect(
      p.getByRole('button', { name: 'move messages row 1 up', exact: true }),
    ).toBeDisabled();
    await p.getByRole('button', { name: 'move messages row 2 up', exact: true }).click();
    await expect(p.getByRole('combobox', { name: 'messages row 1 role', exact: true })).toHaveValue(
      'system',
    );
    await p.getByRole('button', { name: 'Apply config', exact: true }).click();
    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    const saved = await persistedConfig(page, id);
    expect(saved.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Summarise this.' },
    ]);

    await expectQuiet(page, problems);
  });
});
