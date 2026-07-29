import { expect, type Locator, type Page } from '@playwright/test';
import { viewportSettled } from './canvasGraph';
import { fluentRootReady } from './theme';

/**
 * Seeding a canvas from a DOC, rather than authoring one through the UI.
 *
 * `support/canvas.ts`'s `openCanvas` is the right tool whenever the doc under
 * test is one the canvas can author. A CONTAINER is not: U6c draws a container
 * and refuses edges that cross its boundary, but creating one is U6d's ticket
 * and dragging nodes in and out of one is U23's. So the only way to put a
 * `loop`/`stage`/`foreach` on screen today is to mint a pipeline version through
 * the API and open it — which is also, exactly, the path a real operator's doc
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

export interface SeedDoc {
  nodes: SeedNode[];
  edges?: SeedEdge[];
  containers?: SeedContainer[];
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
  const created = await page.request.post('/api/pipelines', { data: { name } });
  expect(created.status(), `creating pipeline '${name}': ${await created.text()}`).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const minted = await page.request.post(`/api/pipelines/${encodeURIComponent(id)}/versions`, {
    data: {
      params: [],
      outputs: [],
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

  await page.goto(`/#/author/pipelines/${encodeURIComponent(id)}`);
  await fluentRootReady(page);
  await page.locator('.react-flow__renderer').waitFor();
  for (const n of doc.nodes) {
    await expect(nodeById(page, n.id)).toHaveClass(/\bdraggable\b/);
  }
  await viewportSettled(page);
  return id;
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
