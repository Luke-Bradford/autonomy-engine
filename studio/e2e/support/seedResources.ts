import { expect, type Page } from '@playwright/test';

/**
 * Seed a Connection or a Dataset over the REST API, for a spec that needs one
 * to exist rather than to author one.
 *
 * ONE authority, because there were already five. `copy-node-authoring`,
 * `datasets-page`, `node-cost-and-tools` and `run-cost-summary` each grew their
 * own "POST it, assert 201, return the id" — most of them hard-wired to the one
 * `kind` that spec happened to need, so the next spec could not reuse them and
 * wrote a sixth. That is the shape #1021/#1106/#1088 complain about, and the
 * fix is a general helper rather than another specific one: both of these take
 * the body verbatim, so no kind is privileged and no spec has to widen them.
 *
 * The FAILURE MESSAGE is the reason these are worth extracting beyond the
 * duplication argument. A seed that 400s reports the server's own reason, so a
 * spec that mis-shapes a `config` fails with the Zod complaint that names the
 * field — not with a bare `expected 400 to be 201` that sends the reader to the
 * server log.
 */
async function createResource(page: Page, path: string, body: unknown): Promise<string> {
  const res = await page.request.post(path, { data: body });
  expect(res.status(), `POST ${path} → ${await res.text()}`).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return id;
}

/**
 * A Connection, returning its id. `config` is NOT validated per-kind on this
 * route (`Connection.config` is a `z.record`), so a mis-shaped one is accepted
 * here and refused at DISPATCH — a spec that only authors can get away with a
 * partial config, and a spec that FIRES cannot.
 */
export function seedConnection(
  page: Page,
  connection: { name: string; kind: string; config: Record<string, unknown> },
): Promise<string> {
  return createResource(page, '/api/connections', connection);
}

/**
 * A Dataset, returning its id. `columns` is REQUIRED with no default — an
 * absent column list must fail loudly rather than read as "this table has no
 * columns" (spec §2.2, #473's lesson), so a seed has to state it.
 */
export function seedDataset(
  page: Page,
  dataset: {
    name: string;
    kind: string;
    connectionId: string;
    config: Record<string, unknown>;
    columns: { name: string; type: string; nullable: boolean }[];
  },
): Promise<string> {
  return createResource(page, '/api/datasets', dataset);
}
