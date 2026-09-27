import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { collectPageProblems, expectQuiet } from './support/console-guard';
import { mintVersion, seedVersion } from './support/seedDoc';
import { seedConnection } from './support/seedResources';

/**
 * #1044 — the whole #1018 chain, end to end: a version names a connection, the
 * workspace commits, the connection is DELETED, the pipeline is authored past,
 * and the branch is pulled back.
 *
 * The stored version is immutable, so its node keeps naming a DB id that no
 * longer resolves, while the branch file carries the connection's `resourceId`.
 * The two forms differ for a reason that is not a hand-edit. Before #1018 that
 * wedged every future pull as tampering; now the import proceeds and says, on
 * both render sites, that this version's content was not compared. The server
 * and component halves are unit-tested; this walks the page.
 *
 * A SIBLING of `workspace-git.spec.ts` rather than a second test inside it, as
 * #1044 asks: that spec's single round trip owns its own connect → disconnect
 * lifecycle over the shared database, and this one needs a full cycle of its
 * own. Setup goes through the API — connecting and committing are walked in the
 * UI there already — and only the caveat, which is what #1018 made visible, is
 * read off the page.
 *
 * Teardown disconnects unconditionally for the same reason that spec does: git
 * mode is workspace-wide and the database is shared with every later spec.
 */
test.describe.configure({ mode: 'serial' });

/** `UNVERIFIED_CONTENT_SUFFIX` (`api/workspaceGit.ts`), spelled out: the spec
 * asserts what the operator READS, so importing the constant would let a
 * reworded caveat pass unnoticed. */
const CAVEAT = 'a ref names a deleted resource, so it was not compared';

let repoDir: string;

test.beforeAll(() => {
  // Outside the harness data dir, which `reset-state.mjs` wipes.
  repoDir = mkdtempSync(join(tmpdir(), 'studio-git-e2e-delconn-'));
  execFileSync('git', ['init', '--bare', '--initial-branch=main', repoDir], { stdio: 'ignore' });
});

test.afterAll(async ({ request }) => {
  await request.delete('/api/workspace/git').catch(() => undefined);
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

async function post(page: Page, url: string, data: unknown): Promise<void> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
}

test('a pull over a version whose connection was deleted proceeds, and says what it did not compare', async ({
  page,
}) => {
  const problems = collectPageProblems(page);
  const stamp = String(Date.now());
  const pipelineName = `git-delconn-${stamp}`;

  // ── a version that names a connection ──────────────────────────────────────
  const connectionId = await seedConnection(page, {
    name: `delconn-${stamp}`,
    kind: 'http',
    config: { baseUrl: 'https://example.invalid' },
  });
  const { pipelineId, pipelineVersionId } = await seedVersion(page, pipelineName, {
    nodes: [{ id: 'n1', position: { x: 0, y: 0 }, connectionId }],
  });

  // ── committed while the connection still exists, and merged to main ───────
  await post(page, '/api/workspace/git', { repoUrl: repoDir });
  await post(page, '/api/workspace/git/commit', { message: 'studio: e2e #1044' });
  execFileSync('git', ['update-ref', 'refs/heads/main', 'refs/heads/studio/local/work'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  // ── the two ordinary acts: delete the connection, author past it ──────────
  const deleted = await page.request.delete(`/api/connections/${connectionId}`);
  expect(deleted.ok(), `deleting the connection: ${await deleted.text()}`).toBe(true);
  await mintVersion(
    page,
    pipelineId,
    { nodes: [{ id: 'n1', position: { x: 0, y: 0 } }] },
    pipelineVersionId,
  );

  // ── the preview says it ────────────────────────────────────────────────────
  await page.goto('/#/manage/git');
  const incoming = page.getByRole('region', { name: 'Incoming', exact: true });
  await incoming.getByRole('button', { name: 'Check for incoming' }).click();

  const row = incoming.getByRole('table').getByRole('row').filter({ hasText: pipelineName });
  await expect(row).toContainText(CAVEAT);

  /* The same gate `workspace-git.spec.ts` holds, for the same reason: the
     database is shared, `withConfirm`-style acceptance below is blind, and a
     preview proposing archives would be about to archive other specs' work. */
  await expect(incoming.getByRole('heading', { name: 'Will be archived' })).toHaveCount(0);

  // ── the import proceeds — no tamper refusal — and says it too ─────────────
  page.once('dialog', (dialog) => void dialog.accept());
  await incoming.getByRole('button', { name: 'Import' }).click();

  const outcome = incoming.getByRole('status');
  await expect(outcome).toContainText(CAVEAT);
  await expect(incoming.getByRole('alert')).toHaveCount(0);

  await expectQuiet(page, problems);
});
