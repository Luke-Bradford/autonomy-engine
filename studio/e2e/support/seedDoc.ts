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
  /** The Connection this node dispatches through — a TOP-LEVEL field on the
   * node, not part of `config` (`schemas/pipeline.ts`). Checked at DISPATCH,
   * never at version save, so a seed may mint a version naming a connection and
   * only find out at fire time whether it resolves. */
  connectionId?: string;
  /**
   * The structural call blob (#953). A TOP-LEVEL field like `connectionId`, and
   * an OPTIONAL DISCRIMINANT rather than a property of the type: a node carrying
   * it is a call node whatever its `type` says, which is how a doc with the
   * legacy literal `type: 'call_pipeline'` — valid at save for back-compat, and
   * NOT authorable from the canvas — arrives from an import or an API seed.
   * Seeding it is the only way to put that doc in front of the inspector.
   */
  call?: { pipelineVersionId: string; params?: Record<string, unknown>; wait?: boolean };
  /**
   * The PAIRED binding a data-movement node carries instead of the single
   * `connectionId` above: a source STORE and a sink STORE, which for a
   * heterogeneous copy are different connections of different kinds.
   *
   * The node fields themselves shipped with #996 M1/M3 and are enforced by the
   * write gate already; what is new here is only that a SEED can express them.
   * Until it could, no spec could put a runnable copy node in front of the
   * engine, which is why nothing exercised the dispatch path end to end.
   */
  connectionIds?: { source: string; sink: string };
  /**
   * The datasets those two ends address — a first-class node FIELD and
   * deliberately not config (data-movement spec §3), so like `connectionId` it
   * is checked at DISPATCH: a seed can mint a version naming a dataset and only
   * learn at fire time whether it resolves.
   */
  datasetIds?: { source: string; sink: string };
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

  // The pipeline was created on the line above and has no versions yet.
  const pipelineVersionId = await mintVersion(page, id, doc, null, name);
  return { pipelineId: id, pipelineVersionId };
}

/**
 * Mint ONE more version on an EXISTING pipeline, and return its id.
 *
 * Split out of `seedVersion` for the version-history spec (#903), which is the
 * first to need a pipeline carrying several versions. The defaults and the edge
 * id-minting live here so that every seeded version has one shape — a spec
 * hand-writing raw request bodies for its second and third versions would be
 * expressing the same doc two different ways in one file.
 */
export async function mintVersion(
  page: Page,
  pipelineId: string,
  doc: SeedDoc,
  // #904 — the CAS basis every version write now declares: the id of the
  // version this one is based on, or `null` for the pipeline's FIRST. Required
  // rather than defaulted, for the reason the field itself is: a seed that
  // chains versions has to state the chain, and one that guesses would be
  // asserting something about server state it has not checked.
  basedOnVersionId: string | null,
  label = pipelineId,
): Promise<string> {
  const minted = await page.request.post(
    `/api/pipelines/${encodeURIComponent(pipelineId)}/versions`,
    {
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
        basedOnVersionId,
      },
    },
  );
  expect(minted.status(), `minting version for '${label}': ${await minted.text()}`).toBe(201);
  const { id } = (await minted.json()) as { id: string };
  return id;
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
 * Bind a manual trigger to `pipelineVersionId` and FIRE it. Returns the run id,
 * without waiting for anything.
 *
 * Split out of `fireAndSettle` (#870) for the runs that DO NOT settle: a
 * pipeline parked on a timer or an inbound callback is a legitimate, indefinite
 * state, and the Monitor's job is to say so. A spec about a parked run cannot
 * use the settling helper — it would simply time out.
 */
export async function fireManualTrigger(
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
  return runId;
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
 * The pipeline it fires must be egress-free, or this waits on something a test
 * machine cannot do. TWO classes qualify:
 *  - the `control` activities — `fail`, `if`, `switch`, `filter` — which need no
 *    connection and make no network call;
 *  - an `agent_task` on an `agent_cli` connection whose `command` is a local
 *    binary (`/bin/echo`). `agent_cli` is credential-less by design, and the
 *    subprocess is an exec, not a socket. This class is strictly more useful for
 *    OBSERVABILITY specs: `cliSpendFact` mints a real `activity.metered` for any
 *    subprocess that ran, so a spend fact reaches the durable log with no
 *    provider (see `node-cost-and-tools.spec.ts`).
 *  - the ENGINE-RESOLVED park, `wait`. It leaves the process entirely (it is an
 *    alarm, not a call) and the engine itself resumes it, so nothing outside can
 *    be waited on. `${0}` settles immediately, which is what makes it the
 *    cheapest way to seed a SUCCEEDED run — the other two classes give a failure
 *    or need a connection (`node-duration.spec.ts`, `rerun-from-failed.spec.ts`).
 *    A long `seconds` parks and never settles, so `fireAndSettle` would time out
 *    on one — that is `fireManualTrigger`'s case (`run-status-vocabulary.spec.ts`).
 */
export async function fireAndSettle(
  page: Page,
  pipelineVersionId: string,
  name = 'e2e manual',
): Promise<string> {
  const runId = await fireManualTrigger(page, pipelineVersionId, name);

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
