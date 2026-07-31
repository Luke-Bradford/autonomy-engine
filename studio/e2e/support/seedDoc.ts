import { expect, type Locator, type Page } from '@playwright/test';
import { viewportSettled } from './canvasGraph';
import { fluentRootReady } from './theme';

/**
 * Seeding a canvas from a DOC, rather than authoring one through the UI.
 *
 * `support/canvas.ts`'s `openCanvas` is the right tool whenever the doc under
 * test is one the canvas can author. A container now IS one — U6d added the
 * create-and-assign gesture, and `container-authoring.spec.ts` walks it. These
 * helpers stay, and are still the right tool for a doc whose SHAPE the canvas
 * cannot reach in a few clicks (a specific back-edge, a `foreach` with a
 * batchCount, a doc with a pre-existing defect): they mint the version through
 * the API and open it, which is also, exactly, the path a real operator's doc
 * takes when it arrives from an import or a git checkout.
 *
 * The mint goes through the REAL write gate, so a doc these helpers can seed is
 * a doc an operator can actually have: a `loop` still needs its `exitWhen`, a
 * child still cannot belong to two containers. That is deliberate — a seed that
 * bypassed validation could put the canvas in a state nothing else can reach,
 * and the spec would be guarding a fiction.
 *
 * Uses `page.request`, so the calls share the page's origin and cookie jar. The
 * e2e harness serves the app and the API from ONE server (`playwright.config.ts`),
 * so a relative path resolves against `baseURL`, and the auth seam attaches the
 * same fixed local principal to every request.
 */

/** An activity node, with the boilerplate a seed does not care about defaulted. */
export interface SeedNode {
  id: string;
  /** An activity `type` from the catalog — defaults to `http_request`. */
  type?: string;
  config?: Record<string, unknown>;
  position: { x: number; y: number };
}

/** An edge, in the doc's own shape. `id` is minted below when omitted. */
export interface SeedEdge {
  id?: string;
  from: string;
  to: string;
  on: 'success' | 'failure' | 'completion' | 'skipped' | 'branch';
  branch?: string;
  back?: boolean;
  maxBounces?: number;
}

export interface SeedContainer {
  id: string;
  kind: 'loop' | 'stage' | 'foreach';
  children: string[];
  /** Required for a `loop` — the write gate refuses one without it. */
  exitWhen?: string;
  maxRounds?: number;
  timeout?: number;
  items?: string;
  batchCount?: number;
  join?: 'all' | 'any';
}

/**
 * A pipeline's declared input, in the doc's own shape (U16). Seeded so a spec
 * can start from a doc that ALREADY has a contract — the state an imported or
 * API-minted pipeline arrives in, which is where the interesting cases live
 * (a default the run would reject, a param the canvas must not drop on save).
 */
export interface SeedParam {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'secret';
  required: boolean;
  default?: unknown;
  description?: string;
}

/** A pipeline's declared result. No `secret` — that would be a leak channel. */
export interface SeedOutput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  optional?: boolean;
  description?: string;
}

export interface SeedDoc {
  nodes: SeedNode[];
  edges?: SeedEdge[];
  containers?: SeedContainer[];
  params?: SeedParam[];
  outputs?: SeedOutput[];
}

/**
 * Mint a pipeline version WITHOUT opening its canvas, and return both ids.
 *
 * The mint half of `openSeededCanvas`, which is written in terms of this: a spec
 * about a RUN needs the version id to bind a trigger to, and must not navigate
 * anywhere yet.
 */
export async function seedVersion(
  page: Page,
  name: string,
  doc: SeedDoc,
): Promise<{ pipelineId: string; pipelineVersionId: string }> {
  const created = await page.request.post('/api/pipelines', { data: { name } });
  expect(created.status(), `creating pipeline '${name}': ${await created.text()}`).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const minted = await page.request.post(`/api/pipelines/${encodeURIComponent(id)}/versions`, {
    data: {
      params: doc.params ?? [],
      outputs: doc.outputs ?? [],
      nodes: doc.nodes.map((n) => ({ type: 'http_request', config: {}, ...n })),
      // `Edge.id` is required on the write path; a seed cares about the shape of
      // the graph, not about the ids, so one is minted from the edge itself —
      // stable across runs (no randomness), and unique for any doc a spec can
      // express, since `(from, to, on)` is the authoring key the canvas already
      // refuses duplicates on.
      edges: (doc.edges ?? []).map((e) => ({ id: `e_${e.from}_${e.to}_${e.on}`, ...e })),
      containers: doc.containers ?? [],
    },
  });
  expect(minted.status(), `minting version for '${name}': ${await minted.text()}`).toBe(201);
  const { id: pipelineVersionId } = (await minted.json()) as { id: string };
  return { pipelineId: id, pipelineVersionId };
}

/**
 * Create a pipeline, mint one version holding `doc`, and open its canvas.
 *
 * Returns once React Flow has mounted, every seeded activity is on screen AND
 * the viewport has stopped moving. All three matter: `fitView` re-centres
 * asynchronously, so a rect read during it is a screen box that has already
 * moved; and a container's box is derived from its children's MEASURED sizes,
 * falling back to an assumed size for the one frame before React Flow has
 * measured them — so an early read is a first-frame box that is about to change.
 * The `draggable` class is React Flow's own signal that it has measured a node.
 */
export async function openSeededCanvas(page: Page, name: string, doc: SeedDoc): Promise<string> {
  const { pipelineId } = await seedVersion(page, name, doc);

  await page.goto(`/#/author/pipelines/${encodeURIComponent(pipelineId)}`);
  await fluentRootReady(page);
  await page.locator('.react-flow__renderer').waitFor();
  for (const n of doc.nodes) {
    await expect(nodeById(page, n.id)).toHaveClass(/\bdraggable\b/);
  }
  await viewportSettled(page);
  return pipelineId;
}

/**
 * One React Flow node, by its DOC id.
 *
 * By id and never by index — see `canvasGraph.ts`'s `NodeRef` for why a
 * positional lookup is wrong the moment a doc has containers in it.
 */
export function nodeById(page: Page, id: string): Locator {
  return page.locator(`.react-flow__node[data-id="${id}"]`);
}

/** A plain rect for one element, in screen coords. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** The rect of one doc element (activity node or container box), in screen coords. */
export function rectOf(page: Page, selector: string): Promise<ScreenRect> {
  return page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });
}

/**
 * Bind a manual trigger to `pipelineVersionId`, FIRE it, and wait for the run to
 * reach a terminal status. Returns the run id.
 *
 * This is the first e2e path that produces a real run, so it goes through the
 * public API exactly as an operator would: create → fire → poll. It polls the
 * run row rather than the event stream because the terminal fact it needs lives
 * on the row, and because a poll cannot miss a frame that arrived before the
 * subscription did.
 *
 * The pipeline it fires must be egress-free (the `control` activities — `fail`,
 * `if`, `switch`, `filter` — need no connection and make no network call), or
 * this waits on something a test machine cannot do.
 */
export async function fireAndSettle(
  page: Page,
  pipelineVersionId: string,
  name = 'e2e manual',
): Promise<string> {
  const trigger = await page.request.post('/api/triggers', {
    data: {
      name,
      pipelineVersionId,
      params: {},
      mode: 'manual',
      schedule: null,
      webhook: null,
      runWindows: null,
      concurrency: { policy: 'skip_if_running' },
      enabled: true,
    },
  });
  expect(trigger.status(), `creating trigger: ${await trigger.text()}`).toBe(201);
  const { id: triggerId } = (await trigger.json()) as { id: string };

  const fired = await page.request.post(`/api/triggers/${encodeURIComponent(triggerId)}/fire`);
  expect(fired.status(), `firing trigger: ${await fired.text()}`).toBe(202);
  const { runId } = (await fired.json()) as { runId: string };
  expect(runId, 'a manual fire must start a run').toBeTruthy();

  // Hand-listed rather than read off `RunStatusSchema.options`: no e2e file
  // imports `@autonomy-studio/shared` (the specs drive the app through its HTTP
  // surface, as an operator does). The cost is that a NEW terminal status would
  // leave this poll waiting — which fails loudly on the timeout, naming the
  // status it was stuck in, rather than passing wrongly.
  const TERMINAL = ['success', 'failure', 'skipped', 'interrupted'];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/runs/${encodeURIComponent(runId)}`);
        if (res.status() !== 200) return `http ${res.status()}`;
        const { status } = (await res.json()) as { status: string };
        // Collapsed to one word so a timeout message names the status it was
        // stuck in, rather than just "false".
        return TERMINAL.includes(status) ? 'terminal' : status;
      },
      { message: `run ${runId} never reached a terminal status`, timeout: 20_000 },
    )
    .toBe('terminal');

  return runId;
}
