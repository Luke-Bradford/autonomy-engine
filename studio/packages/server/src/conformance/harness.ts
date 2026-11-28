import type { FastifyInstance } from 'fastify';
import {
  ActivityRunsResponseSchema,
  CATALOG_VERSION,
  TERMINAL_RUN_ROW_STATUS,
  type ActivityRun,
  type ConnectionKind,
  type ConnectionProbeResult,
  type DatasetColumn,
  type DatasetKind,
} from '@autonomy-studio/shared';
import { buildTestAppWithContext } from '../__tests__/build-test-app.js';
import { until } from '../__tests__/poll-until.js';
import { getRun } from '../repo/index.js';

/**
 * #1574 OR39 — the conformance matrix's one way of running a cell.
 *
 * Every cell is a REAL run through the app: the connection, dataset and
 * pipeline version are made through the same HTTP routes the editor calls, the
 * run is started with the editor's Run (`POST /api/pipelines/:id/runs`), and the
 * facts a cell asserts are read back from the routes the run monitor reads. No
 * adapter, executor or engine is stubbed; the only fixtures are the backends
 * themselves (`backends.ts`).
 *
 * Not a `.test.ts` file, so vitest never collects it as a suite.
 */

export interface Harness {
  readonly app: FastifyInstance;
  /** The per-app scratch dir; backends put their roots under it. */
  readonly tmpDir: string;
  createConnection(input: {
    kind: ConnectionKind;
    config: Record<string, unknown>;
    secret?: string;
    name?: string;
  }): Promise<string>;
  createDataset(input: {
    connectionId: string;
    kind: DatasetKind;
    config: Record<string, unknown>;
    columns?: DatasetColumn[];
    parameters?: string[];
    name?: string;
  }): Promise<string>;
  /** Save a pipeline with one version; returns the ids the Run route takes. */
  createPipeline(doc: PipelineDocInput): Promise<{ pipelineId: string; versionId: string }>;
  /** Run a saved version to a terminal status and read back what it did. */
  run(
    ids: { pipelineId: string; versionId: string },
    params?: Record<string, unknown>,
  ): Promise<RunResult>;
  /** `createPipeline` then `run`. */
  runDoc(doc: PipelineDocInput, params?: Record<string, unknown>): Promise<RunResult>;
  probeDraft(input: {
    kind: ConnectionKind;
    config: Record<string, unknown>;
    secret?: string;
  }): Promise<ConnectionProbeResult>;
  probeSaved(connectionId: string): Promise<ConnectionProbeResult>;
  close(): Promise<void>;
}

export interface PipelineDocInput {
  nodes: Record<string, unknown>[];
  edges?: Record<string, unknown>[];
  containers?: Record<string, unknown>[];
  params?: Record<string, unknown>[];
  variables?: Record<string, unknown>[];
  name?: string;
}

export interface RunResult {
  readonly runId: string;
  readonly status: string;
  readonly run: Record<string, unknown>;
  /** The run monitor's activity-runs table. */
  readonly activityRuns: readonly ActivityRun[];
  /** The input each node instance was dispatched with, parsed, keyed by node id. */
  readonly dispatched: ReadonlyMap<string, Record<string, unknown>[]>;
  /** Each node instance's success outputs, keyed by node id, in event order. */
  readonly outputs: ReadonlyMap<string, Record<string, unknown>[]>;
  /** Each node instance's failure message, keyed by node id, in event order. */
  readonly failures: ReadonlyMap<string, string[]>;
}

let seq = 0;
const uniqueName = (prefix: string): string => `${prefix} ${++seq}`;

async function json<T>(
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  expectStatus?: number,
): Promise<T> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  if (expectStatus !== undefined && res.statusCode !== expectStatus) {
    throw new Error(`${method} ${url} answered ${res.statusCode}: ${res.body}`);
  }
  return res.json() as T;
}

function pushTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

export async function createHarness(): Promise<Harness> {
  const { app, tmpDir } = await buildTestAppWithContext();

  const harness: Harness = {
    app,
    tmpDir,
    async createConnection({ kind, config, secret, name }) {
      const body = await json<{ id: string }>(
        app,
        'POST',
        '/api/connections',
        {
          name: name ?? uniqueName(`matrix ${kind}`),
          kind,
          config,
          ...(secret === undefined ? {} : { secret }),
        },
        201,
      );
      return body.id;
    },
    async createDataset({ connectionId, kind, config, columns, parameters, name }) {
      const body = await json<{ id: string }>(
        app,
        'POST',
        '/api/datasets',
        {
          name: name ?? uniqueName(`matrix ${kind}`),
          kind,
          connectionId,
          config,
          columns: columns ?? [],
          ...(parameters === undefined ? {} : { parameters }),
        },
        201,
      );
      return body.id;
    },
    async createPipeline(doc) {
      const pipeline = await json<{ id: string }>(
        app,
        'POST',
        '/api/pipelines',
        { name: doc.name ?? uniqueName('matrix pipeline') },
        201,
      );
      const version = await json<{ id: string }>(
        app,
        'POST',
        `/api/pipelines/${pipeline.id}/versions`,
        {
          basedOnVersionId: null,
          params: doc.params ?? [],
          outputs: [],
          nodes: doc.nodes,
          edges: doc.edges ?? [],
          containers: doc.containers ?? [],
          ...(doc.variables === undefined ? {} : { variables: doc.variables }),
          catalogVersion: CATALOG_VERSION,
        },
        201,
      );
      return { pipelineId: pipeline.id, versionId: version.id };
    },
    async run({ pipelineId, versionId }, params) {
      const started = await json<{ outcome: string; runId: string }>(
        app,
        'POST',
        `/api/pipelines/${pipelineId}/runs`,
        { pipelineVersionId: versionId, ...(params === undefined ? {} : { params }) },
        202,
      );
      if (started.outcome !== 'started') {
        throw new Error(`run did not start: ${JSON.stringify(started)}`);
      }
      const runId = started.runId;
      await until(
        () => {
          const status = getRun(app.db, runId)?.status;
          return status !== undefined && TERMINAL_RUN_ROW_STATUS.has(status);
        },
        `matrix run ${runId} to finish`,
        { iterations: 3000 },
      );
      await app.runLauncher.whenIdle();
      const run = await json<Record<string, unknown>>(app, 'GET', `/api/runs/${runId}`);
      const activity = ActivityRunsResponseSchema.parse(
        await json(app, 'GET', `/api/runs/${runId}/activity-runs`, undefined, 200),
      );
      const events = await json<{ type: string; payload: Record<string, unknown> }[]>(
        app,
        'GET',
        `/api/runs/${runId}/events`,
      );
      const dispatched = new Map<string, Record<string, unknown>[]>();
      const outputs = new Map<string, Record<string, unknown>[]>();
      const failures = new Map<string, string[]>();
      for (const { type, payload: event } of events) {
        const nodeId = event['nodeId'];
        if (typeof nodeId !== 'string') continue;
        if (type === 'node.dispatched') {
          const input = event['input'] as { text: string } | undefined;
          pushTo(dispatched, nodeId, input === undefined ? {} : JSON.parse(input.text));
        } else if (type === 'node.succeeded') {
          pushTo(outputs, nodeId, (event['outputs'] ?? {}) as Record<string, unknown>);
        } else if (type === 'node.failed') {
          pushTo(failures, nodeId, String(event['error'] ?? ''));
        }
      }
      return {
        runId,
        status: String(run['status']),
        run,
        activityRuns: activity.rows,
        dispatched,
        outputs,
        failures,
      };
    },
    async runDoc(doc, params) {
      return harness.run(await harness.createPipeline(doc), params);
    },
    probeDraft({ kind, config, secret }) {
      return json(
        app,
        'POST',
        '/api/connections/test',
        { kind, config, ...(secret === undefined ? {} : { secret }) },
        200,
      );
    },
    probeSaved(connectionId) {
      return json(app, 'POST', `/api/connections/${connectionId}/test`, {}, 200);
    },
    async close() {
      await app.close();
    },
  };
  return harness;
}

/** The one terminal outputs of a node that ran once, or a readable failure. */
export function onlyOutputs(result: RunResult, nodeId: string): Record<string, unknown> {
  const outs = result.outputs.get(nodeId);
  if (outs === undefined || outs.length !== 1) {
    const why = result.failures.get(nodeId)?.join(' | ') ?? 'no outputs';
    throw new Error(`node ${nodeId} in run ${result.runId} (${result.status}): ${why}`);
  }
  return outs[0] as Record<string, unknown>;
}
