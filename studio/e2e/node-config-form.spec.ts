import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { canvasNodes } from './support/canvasGraph';
import { nodeById, openSeededCanvas } from './support/seedDoc';
import { seedConnection } from './support/seedResources';
import { properties, expectTabNames } from './support/panels';

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
    await expect(properties(page).getByRole('textbox', { name: 'Request URL' })).toBeVisible();
    await expect(properties(page).getByRole('textbox', { name: 'HTTP method' })).toBeVisible();
    // And the blob editor an author used to have to understand is not the
    // default surface any more.
    await expect(properties(page).getByLabel('Config (JSON)')).toHaveCount(0);

    await properties(page)
      .getByRole('textbox', { name: 'Request URL' })
      .fill('https://example.test/hook');
    await properties(page).getByRole('textbox', { name: 'HTTP method' }).fill('POST');
    await properties(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // The round trip. A reload re-fetches the latest version from the server, so
    // what renders is what was PERSISTED, not what the store still held.
    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await canvasNodes(page).first().click();

    await expect(properties(page).getByRole('textbox', { name: 'Request URL' })).toHaveValue(
      'https://example.test/hook',
    );
    await expect(properties(page).getByRole('textbox', { name: 'HTTP method' })).toHaveValue(
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
    // Seeded WITH a url: the write gate refuses an `http_request` without one
    // (#1480), so the field is never empty on arrival. The trap needs a field
    // that is located, filled, then located again, which is unchanged.
    await openSeededCanvas(page, 'u7 label after fill', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { url: 'https://example.test/before' },
        },
      ],
    });
    await canvasNodes(page).first().click();

    const url = properties(page).getByLabel('Request URL', { exact: true });
    await expect(url).toHaveValue('https://example.test/before');
    await url.fill('https://example.test/label');
    await expect(url).toHaveValue('https://example.test/label', { timeout: 3_000 });
    await expectQuiet(page, problems);
  });

  // #1396 slice 7 — the panel names a field by its human title, keeps the key
  // in the hint (it is what a `${}` reference and a server message cite), and
  // puts the stored value's unit beside the title.
  test('a field reads by its title, with its key and unit beside it', async ({ page }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'or5 titled fields', {
      nodes: [
        { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
        { id: 'w', type: 'wait', position: { x: 300, y: 0 }, config: { seconds: '${30}' } },
      ],
    });
    await canvasNodes(page).first().click();
    const url = properties(page).getByRole('textbox', { name: 'Request URL', exact: true });
    await expect(url).toHaveAccessibleDescription(/\burl\b/);
    await expect(properties(page).getByRole('textbox', { name: 'url', exact: true })).toHaveCount(
      0,
    );

    await canvasNodes(page).nth(1).click();
    const seconds = properties(page).getByRole('textbox', {
      name: 'Wait time (seconds)',
      exact: true,
    });
    await expect(seconds).toHaveValue('${30}');
    await expect(seconds).toHaveAccessibleDescription(/e\.g\. \$\{30\}.*\bseconds\b/);
    await expectQuiet(page, problems);
  });

  // #1477 OR29 — an activity's tabs come from its catalog entry. An HTTP node
  // opens on Request: its connection, its fields, then Container membership,
  // which closes the landing tab. Secret headers are on Auth.
  test('an activity opens on its first catalog tab, with Container closing it', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'or29 panel tabs', {
      nodes: [
        { id: 'a', type: 'http_request', position: { x: 0, y: 0 }, config: {} },
        { id: 'w', type: 'wait', position: { x: 300, y: 0 }, config: { seconds: '${30}' } },
      ],
    });
    await canvasNodes(page).first().click();
    const tabs = properties(page).getByRole('tablist', { name: 'Activity properties' });
    await expectTabNames(tabs, ['General', 'Request', 'Auth']);
    const request = properties(page).getByRole('tabpanel', { name: 'Request' });
    await expect(request).toBeVisible();
    await expect(request.getByRole('combobox', { name: 'Connection' })).toBeVisible();
    await expect(request.getByRole('textbox', { name: 'Request URL', exact: true })).toBeVisible();
    await expect(request.getByLabel('Container membership')).toBeVisible();

    // One read of every computed value: Container is the tab's only form
    // section, ruled off on its heading because the fields precede it, and its
    // body keeps the panel's own gap.
    const layout = await properties(page).evaluate((panel) => {
      const sections = [
        ...panel.querySelectorAll<HTMLElement>(
          '[role="tabpanel"]:not([hidden]) fieldset.form-section',
        ),
      ];
      return {
        panelGap: getComputedStyle(panel).rowGap,
        sections: sections.map((el) => {
          const legend = el.querySelector<HTMLElement>(':scope > legend')!;
          return {
            title: legend.textContent,
            fieldsetBorder: getComputedStyle(el).borderTopWidth,
            ruled: getComputedStyle(legend).borderTopWidth,
            ruleSpansSection:
              Math.abs(legend.getBoundingClientRect().width - el.getBoundingClientRect().width) < 1,
            gap: getComputedStyle(el.querySelector('.form-section-body')!).rowGap,
          };
        }),
      };
    });
    expect(layout.sections).toEqual([
      {
        title: 'Container',
        fieldsetBorder: '0px',
        ruled: '1px',
        ruleSpansSection: true,
        gap: layout.panelGap,
      },
    ]);

    await tabs.getByRole('tab', { name: 'Auth' }).click();
    await expect(
      properties(page)
        .getByRole('tabpanel', { name: 'Auth' })
        .getByRole('group', { name: 'Secret headers', exact: true }),
    ).toBeVisible();

    // A wait binds nothing: one Settings tab, its field, and no connection. The
    // dock's remembered tab (Auth) is not one a wait has, so it opens on Settings.
    await canvasNodes(page).nth(1).click();
    await expectTabNames(tabs, ['General', 'Settings']);
    const settings = properties(page).getByRole('tabpanel', { name: 'Settings' });
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('combobox', { name: 'Connection' })).toHaveCount(0);
    await expectQuiet(page, problems);
  });

  // #852 item 4 — a field whose SCHEMA is tagged `singleLine` is a one-line
  // input, everything else keeps the textarea, and a stored value holding a
  // line break keeps the textarea too (an input would strip the break).
  test('a short setting is a one-line input; prose and a multi-line value stay textareas', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const id = await openSeededCanvas(page, 'u7 single line', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { url: 'https://example.test', method: 'GET\nPOST' },
        },
      ],
    });
    await canvasNodes(page).first().click();

    const facts = await properties(page).evaluate((root) => {
      const byLabel = (name: string) =>
        Array.from(
          root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'),
        ).find((el) => Array.from(el.labels ?? []).some((l) => l.textContent === name));
      const url = byLabel('Request URL');
      const textareaFont = byLabel('Request body')
        ? getComputedStyle(byLabel('Request body')!).fontFamily
        : null;
      return {
        url: url?.tagName,
        urlFont: url ? getComputedStyle(url).fontFamily : null,
        textareaFont,
        method: byLabel('HTTP method')?.tagName,
        methodValue: byLabel('HTTP method')?.value,
        body: byLabel('Request body')?.tagName,
      };
    });
    expect(facts).toEqual({
      url: 'INPUT',
      // The same face as the textareas beside it, not the page's proportional one.
      urlFont: facts.textareaFont,
      textareaFont: expect.stringContaining('monospace'),
      method: 'TEXTAREA',
      methodValue: 'GET\nPOST',
      body: 'TEXTAREA',
    });

    // The input still round-trips through a save.
    await properties(page)
      .getByRole('textbox', { name: 'Request URL' })
      .fill('https://example.test/one-line');
    await properties(page).getByRole('button', { name: 'Apply config' }).click();
    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedConfig(page, id)).toMatchObject({
      url: 'https://example.test/one-line',
      method: 'GET\nPOST',
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
    await properties(page).getByRole('textbox', { name: 'Request URL' }).fill('https://after');
    await properties(page).getByRole('button', { name: 'Apply config' }).click();

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
    await properties(page)
      .getByRole('textbox', { name: 'Request URL' })
      .fill('https://typed-in-a-field');
    await properties(page).getByRole('button', { name: 'Edit as JSON' }).click();

    const json = properties(page).getByLabel('Config (JSON)');
    await expect(json).toHaveValue(/https:\/\/typed-in-a-field/);
    // The toggle names the mode it goes TO, and it is reachable in the new mode.
    await expect(properties(page).getByRole('button', { name: 'Edit as fields' })).toBeVisible();
    await properties(page).getByRole('button', { name: 'Apply config' }).click();

    await page.getByRole('button', { name: 'Save version' }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect(await persistedConfig(page, id)).toMatchObject({ url: 'https://typed-in-a-field' });

    await expectQuiet(page, problems);
  });

  test('a config the form cannot show falls back to the JSON editor, not to corruption', async ({
    page,
  }) => {
    // The kind comes from the SCHEMA, the value from the DOC. `http_request`'s
    // `headers` is a `z.record(z.string(), z.string())`, which admits a header
    // named '' — a value the write gate accepts (#1480 now refuses a `url` that
    // is not a string, which this spec used to seed) but that a key/value ROW
    // cannot hold, so the form cannot show it. Rendering it as rows would
    // silently drop the entry on an apply that touched another field: a
    // corruption caused by OPENING the panel, with no edit at all.
    const problems = collectPageProblems(page);
    await openSeededCanvas(page, 'u7 unrenderable', {
      nodes: [
        {
          id: 'a',
          type: 'http_request',
          position: { x: 0, y: 0 },
          config: { url: 'https://example.test/seed', headers: { '': 'authored elsewhere' } },
        },
      ],
    });

    await canvasNodes(page).first().click();

    await expect(properties(page).getByLabel('Config (JSON)')).toBeVisible();
    // EXACT: the fallback textarea is wrapped by its own <label>, whose text
    // content includes the JSON being edited — which here literally contains the
    // word "url". A substring match would resolve to the escape hatch itself and
    // pass for the wrong reason.
    await expect(
      properties(page).getByRole('textbox', { name: 'Request URL', exact: true }),
    ).toHaveCount(0);
    await expect(
      properties(page).getByText(/Saved settings this form cannot show \(headers\)/),
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
    const p = properties(page);
    // No JSON blob for either record: a row group per field.
    await expect(p.getByRole('group', { name: 'Request headers', exact: true })).toBeVisible();
    await expect(p.getByRole('textbox', { name: 'headers row 1 key', exact: true })).toHaveValue(
      'X-Keep',
    );

    await p.getByRole('button', { name: 'Add headers row', exact: true }).click();
    await p.getByRole('textbox', { name: 'headers row 2 key', exact: true }).fill('X-Trace');
    await p.getByRole('textbox', { name: 'headers row 2 value', exact: true }).fill('${run.runId}');
    // #1477 — secret headers are on the Auth tab.
    await p.getByRole('tab', { name: 'Auth' }).click();
    await expect(p.getByRole('group', { name: 'Secret headers', exact: true })).toBeVisible();
    await p.getByRole('button', { name: 'Add secretHeaders row', exact: true }).click();
    await p
      .getByRole('textbox', { name: 'secretHeaders row 1 key', exact: true })
      .fill('Authorization');
    await p
      .getByRole('textbox', { name: 'secretHeaders row 1 secret name', exact: true })
      .fill('api-token');
    // The value cell takes a reference; the key and secret-name cells do not.
    await expect(
      p.getByRole('button', {
        name: 'Insert reference into secretHeaders row 1 secret name',
        exact: true,
      }),
    ).toHaveCount(0);
    await p.getByRole('tab', { name: 'Request' }).click();
    await expect(
      p.getByRole('button', { name: 'Insert reference into headers row 2 value', exact: true }),
    ).toBeVisible();
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
    await properties(page).getByRole('tab', { name: 'Auth' }).click();
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
    await properties(page).getByRole('tab', { name: 'Prompt' }).click();
    const p = properties(page);
    await expect(p.getByRole('group', { name: 'Conversation', exact: true })).toBeVisible();
    await expect(p.getByRole('combobox', { name: 'messages row 1 role', exact: true })).toHaveValue(
      'user',
    );
    // #1396: a row's enum cell shows the value's name; the value is what saves.
    await expect(
      p
        .getByRole('combobox', { name: 'messages row 1 role', exact: true })
        .locator('option:checked'),
    ).toHaveText('User');
    await expect(
      p.getByRole('textbox', { name: 'messages row 1 content', exact: true }),
    ).toHaveValue('Summarise this.');

    await p.getByRole('button', { name: 'Add messages row', exact: true }).click();
    await p
      .getByRole('combobox', { name: 'messages row 2 role', exact: true })
      .selectOption({ label: 'Assistant' });
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
    await properties(page).getByRole('tab', { name: 'Prompt' }).click();
    await expect(p.getByRole('combobox', { name: 'messages row 2 role', exact: true })).toHaveValue(
      'assistant',
    );

    await expectQuiet(page, problems);
  });

  // #864 item 4 — `history` is one whole `${}` reference to a turn array. Apply
  // used to check that text against the dispatch schema (an array) and refuse
  // it, so no conversation could be continued from the panel at all.
  test('an llm_call history is picked as a reference and survives a save and reload', async ({
    page,
  }) => {
    const problems = collectPageProblems(page);
    const connectionId = await seedConnection(page, {
      name: `e2e 864 history ${Date.now()}`,
      kind: 'ollama',
      config: {},
    });
    const id = await openSeededCanvas(page, 'u8a history reference', {
      nodes: [
        {
          id: 'p',
          type: 'llm_call',
          position: { x: 0, y: 0 },
          connectionId,
          config: { prompt: 'Start.', emitMessages: true },
        },
        {
          id: 'a',
          type: 'llm_call',
          position: { x: 320, y: 0 },
          connectionId,
          config: { prompt: 'Continue.' },
        },
      ],
      edges: [{ id: 'e1', from: 'p', to: 'a', on: 'success' }],
    });

    await nodeById(page, 'a').click();
    const p = properties(page);
    await properties(page).getByRole('tab', { name: 'Prompt' }).click();
    const history = p.getByRole('textbox', { name: 'History', exact: true });
    await expect(history).toHaveValue('');
    // The prompt, a template, IS offered the producer's string `text`...
    const promptPicker = p.getByRole('button', {
      name: 'Insert reference into prompt',
      exact: true,
    });
    await promptPicker.click();
    await expect(p.getByRole('button', { name: / → text\b/ })).toBeVisible();
    await promptPicker.click();
    await p.getByRole('button', { name: 'Insert reference into history', exact: true }).click();
    // ...and history is not: it is offered only the transcript, a turn array.
    await expect(p.getByRole('button', { name: / → text\b/ })).toHaveCount(0);
    await p.getByRole('button', { name: / → messages\b/ }).click();
    await expect(history).toHaveValue('${nodes.p.output.messages}');
    await p.getByRole('button', { name: 'Apply config', exact: true }).click();

    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');
    expect((await persistedConfig(page, id)).history).toBe('${nodes.p.output.messages}');

    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await nodeById(page, 'a').click();
    await properties(page).getByRole('tab', { name: 'Prompt' }).click();
    await expect(history).toHaveValue('${nodes.p.output.messages}');

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
    await properties(page).getByRole('tab', { name: 'Prompt' }).click();
    const p = properties(page);
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

  // #852 item 3 — a structured output is declared as ROWS, one per field, where
  // it used to be a JSON Schema typed by hand.
  test('a structured outputSchema is rows that survive a save and reload', async ({ page }) => {
    const problems = collectPageProblems(page);
    const connectionId = await seedConnection(page, {
      name: `e2e 852 output schema ${Date.now()}`,
      kind: 'ollama',
      config: {},
    });
    const category = {
      type: 'string',
      description: 'The chosen category.',
      enum: ['positive', 'negative'],
    };
    const id = await openSeededCanvas(page, 'u7 output schema rows', {
      nodes: [
        {
          id: 'a',
          type: 'llm_call',
          position: { x: 0, y: 0 },
          connectionId,
          config: {
            outputMode: 'structured',
            messages: [{ role: 'user', content: 'Classify this.' }],
            outputSchema: {
              type: 'object',
              properties: { category },
              required: ['category'],
              additionalProperties: false,
            },
          },
        },
      ],
    });

    await canvasNodes(page).first().click();
    await properties(page).getByRole('tab', { name: 'Output' }).click();
    const p = properties(page);
    const cell = (role: 'textbox' | 'combobox' | 'checkbox', row: number, name: string) =>
      p.getByRole(role, { name: new RegExp(`^outputSchema row ${row} ${name}\\b`) });
    await expect(p.getByRole('group', { name: 'Output schema', exact: true })).toBeVisible();
    await expect(cell('textbox', 1, 'name')).toHaveValue('category');
    await expect(cell('combobox', 1, 'type')).toHaveValue('string');
    await expect(cell('checkbox', 1, 'required')).toBeChecked();
    await expect(cell('textbox', 1, 'constraints')).toHaveValue(/"positive"/);
    // A property name is not substituted, so it offers no reference.
    await expect(
      p.getByRole('button', { name: 'Insert reference into outputSchema row 1 name' }),
    ).toHaveCount(0);

    await p.getByRole('button', { name: 'Add outputSchema row', exact: true }).click();
    await cell('textbox', 2, 'name').fill('confidence');
    await cell('combobox', 2, 'type').selectOption('number');
    await cell('textbox', 2, 'description').fill('How sure, 0 to 1.');
    await p.getByRole('button', { name: 'Apply config', exact: true }).click();

    await page.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(page.locator('.notice')).toHaveText('Saved v2.');

    // Exact: the unticked row is optional because `required` is written
    // explicitly — absent would have made both fields required (#594).
    const saved = await persistedConfig(page, id);
    expect(saved.outputSchema).toEqual({
      type: 'object',
      properties: {
        category,
        confidence: { type: 'number', description: 'How sure, 0 to 1.' },
      },
      required: ['category'],
      additionalProperties: false,
    });

    await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
    await page.locator('.react-flow__renderer').waitFor();
    await canvasNodes(page).first().click();
    await properties(page).getByRole('tab', { name: 'Output' }).click();
    await expect(cell('textbox', 2, 'name')).toHaveValue('confidence');
    await expect(cell('checkbox', 2, 'required')).not.toBeChecked();

    await expectQuiet(page, problems);
  });
});
